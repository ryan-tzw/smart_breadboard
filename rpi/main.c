#include <stdio.h>

#include "pico/stdlib.h"
#include "hardware/adc.h"
#include "hardware/sync.h"

#include "command_parser.h"

#define CHANNEL_COUNT 16
#define MUX_SELECT_MASK 0x0fu
#define INJECTION_SELECT_MASK 0xf0u
#define INJECTION_ENABLE_PIN 8
#define INJECTION_PIN 27
#define ADC_PIN 26
#define ADC_INPUT 0
#define PROBE_MAX_PASSIVE_VOLTS 0.3f
#define PROBE_TIMEOUT_MS 20
#define COMMAND_BUFFER_SIZE 128

// Undo the 47 kohm / 68 kohm divider using a nominal 3.3 V reference.
static const float input_volts_per_count = (3.3f / 4096.0f) * (115.0f / 68.0f);
static volatile bool probe_timed_out;

static void disable_injection(void)
{
    gpio_put(INJECTION_ENABLE_PIN, 1);
    // Leave the injection pin high impedance while MUX2 is disconnected.
    gpio_set_dir(INJECTION_PIN, GPIO_IN);
    gpio_put(INJECTION_PIN, 0);
}

static int64_t probe_timeout(alarm_id_t id, void *user_data)
{
    (void)id;
    (void)user_data;
    disable_injection();
    probe_timed_out = true;
    return 0;
}

static float measure_channel(uint channel)
{
    gpio_put_masked(MUX_SELECT_MASK, channel);
    sleep_ms(1);
    (void)adc_read(); // Discard the first conversion after switching.
    return adc_read() * input_volts_per_count;
}

static void print_error(const char *code)
{
    printf("{\"type\":\"error\",\"command\":\"probe\",\"code\":\"%s\"}\n", code);
}

static void handle_command(const char *text)
{
    // --------------------
    // command validation
    // --------------------
    uint source;
    uint target;
    if (!parse_probe_command(text, CHANNEL_COUNT, &source, &target))
    {
        disable_injection();
        print_error("invalid_command");
        return;
    }

    // --------------------
    // passive pre-check
    // --------------------
    float passive[CHANNEL_COUNT];
    disable_injection();
    for (uint channel = 0; channel < CHANNEL_COUNT; ++channel)
    {
        passive[channel] = measure_channel(channel);
    }
    for (uint channel = 0; channel < CHANNEL_COUNT; ++channel)
    {
        if (passive[channel] > PROBE_MAX_PASSIVE_VOLTS)
        {
            printf("{\"type\":\"error\",\"command\":\"probe\",\"code\":\"unexpected_voltage\","
                   "\"channel\":%u,\"voltage\":%.3f,\"threshold\":%.3f}\n",
                   channel, passive[channel], (double)PROBE_MAX_PASSIVE_VOLTS);
            return;
        }
    }

    // --------------------
    // signal injection
    // --------------------

    // MUX2 stays disabled while its source address changes.
    gpio_put_masked(INJECTION_SELECT_MASK, source << 4);

    // Arm the cutoff and enable injection atomically, so an alarm cannot fire
    // before enable and then be accidentally overridden by the main loop.
    uint32_t interrupts = save_and_disable_interrupts();
    probe_timed_out = false;
    alarm_id_t alarm = add_alarm_in_ms(PROBE_TIMEOUT_MS, probe_timeout, NULL, true);
    if (alarm > 0)
    {
        gpio_put(INJECTION_PIN, 1);
        gpio_set_dir(INJECTION_PIN, GPIO_OUT);
        gpio_put(INJECTION_ENABLE_PIN, 0);
    }
    restore_interrupts(interrupts);
    if (alarm <= 0)
    {
        disable_injection();
        print_error("timer_unavailable");
        return;
    }

    // --------------------
    // measurement and cleanup
    // --------------------

    // No USB printing or command parsing while injection is enabled.
    float voltage = measure_channel(target);
    disable_injection();
    cancel_alarm(alarm);
    if (probe_timed_out)
    {
        print_error("probe_timeout");
        return;
    }
    printf("{\"type\":\"probe_result\",\"source\":%u,\"target\":%u,\"voltage\":%.3f}\n",
           source, target, voltage);
}

int main(void)
{
    // --------------------
    // hardware initialization
    // --------------------

    // Set the disable latch before making the active-low enable an output.
    gpio_init(INJECTION_ENABLE_PIN);
    gpio_put(INJECTION_ENABLE_PIN, 1);
    gpio_set_dir(INJECTION_ENABLE_PIN, GPIO_OUT);
    gpio_init(INJECTION_PIN);
    gpio_disable_pulls(INJECTION_PIN);
    disable_injection();
    gpio_init_mask(INJECTION_SELECT_MASK);
    gpio_put_masked(INJECTION_SELECT_MASK, 0);
    gpio_set_dir_out_masked(INJECTION_SELECT_MASK);

    // GPIO0 is S0 (LSB), through GPIO3 as S3 (MSB).
    gpio_init_mask(MUX_SELECT_MASK);
    gpio_put_masked(MUX_SELECT_MASK, 0);
    gpio_set_dir_out_masked(MUX_SELECT_MASK);
    adc_init();
    adc_gpio_init(ADC_PIN);
    adc_select_input(ADC_INPUT);
    stdio_init_all();

    char command[COMMAND_BUFFER_SIZE];
    size_t length = 0;
    bool dropping_line = false;
    absolute_time_t next_scan = get_absolute_time();
    while (true)
    {
        // --------------------
        // passive monitoring
        // --------------------
        if (time_reached(next_scan))
        {
            next_scan = make_timeout_time_ms(1000);
            float voltages[CHANNEL_COUNT];
            disable_injection();
            for (uint channel = 0; channel < CHANNEL_COUNT; ++channel)
            {
                voltages[channel] = measure_channel(channel);
            }
            printf("{\"type\":\"voltage_scan\",\"voltages\":[");
            for (uint channel = 0; channel < CHANNEL_COUNT; ++channel)
            {
                printf("%s%.3f", channel == 0 ? "" : ",", voltages[channel]);
            }
            puts("]}");
        }
        // --------------------
        // serial commands
        // --------------------
        // Bound each poll so continuous incoming data cannot starve passive scans.
        for (uint count = 0; count < 64; ++count)
        {
            int character = getchar_timeout_us(0);
            if (character == PICO_ERROR_TIMEOUT)
            {
                break;
            }
            if (character == '\n')
            {
                if (!dropping_line && length > 0)
                {
                    command[length] = '\0';
                    handle_command(command);
                }
                length = 0;
                dropping_line = false;
            }
            else if (!dropping_line)
            {
                if (character <= 0 || character > 127 || length == sizeof(command) - 1)
                {
                    dropping_line = true;
                    length = 0;
                    disable_injection();
                    print_error("invalid_command");
                }
                else
                {
                    command[length++] = (char)character;
                }
            }
        }
        sleep_ms(1);
    }
}
