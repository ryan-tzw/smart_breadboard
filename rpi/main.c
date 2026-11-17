#include <stdio.h>

#include "pico/stdlib.h"
#include "hardware/adc.h"
#include "hardware/sync.h"

#include "command_parser.h"
#include "led_strip.h"

#define CHANNEL_COUNT 16
#define MUX_SELECT_MASK 0x0fu
#define INJECTION_SELECT_MASK 0xf0u
#define INJECTION_ENABLE_PIN 8
#define INJECTION_PIN 27
#define ADC_PIN 26
#define ADC_INPUT 0
#define PROBE_MAX_PASSIVE_VOLTS 0.3f
#define PROBE_TIMEOUT_MS 20
#define CONNECTION_LOW_VOLTS 0.3f
#define CONNECTION_HIGH_VOLTS 2.0f
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

static void print_error(const char *command, const char *code)
{
    printf("{\"type\":\"error\",\"command\":\"%s\",\"code\":\"%s\"}\n", command, code);
}

static void handle_command(const char *text)
{
    // --------------------
    // command validation
    // --------------------
    uint requested_source = 0;
    uint requested_target = 0;
    CommandType command = parse_command(text, CHANNEL_COUNT, &requested_source, &requested_target);
    if (command == COMMAND_INVALID)
    {
        disable_injection();
        print_error("unknown", "invalid_command");
        return;
    }
    bool scanning = command == COMMAND_SCAN_CONNECTIONS;
    const char *command_name = scanning ? "scan_connections" : "probe";
    // Keep the 1 KiB matrix off the small default stack. A completed scan
    // overwrites every off-diagonal entry before classification.
    static float responses[CHANNEL_COUNT][CHANNEL_COUNT];
    if (scanning)
    {
        printf("{\"type\":\"scan_progress\",\"completed_sources\":0,\"total_sources\":%u}\n", CHANNEL_COUNT);
    }

    for (uint source = scanning ? 0 : requested_source;
         source < (scanning ? CHANNEL_COUNT : requested_source + 1); ++source)
    {
        // --------------------
        // passive pre-check
        // --------------------
        disable_injection();
        for (uint channel = 0; channel < CHANNEL_COUNT; ++channel)
        {
            float voltage = measure_channel(channel);
            if (voltage > PROBE_MAX_PASSIVE_VOLTS)
            {
                printf("{\"type\":\"error\",\"command\":\"%s\",\"code\":\"unexpected_voltage\","
                       "\"source\":%u,\"channel\":%u,\"voltage\":%.3f,\"threshold\":%.3f}\n",
                       command_name, source, channel, voltage, (double)PROBE_MAX_PASSIVE_VOLTS);
                return;
            }
        }

        // --------------------
        // signal injection
        // --------------------
        // MUX2 stays disabled while its source address changes.
        gpio_put_masked(INJECTION_SELECT_MASK, source << 4);

        // Arm and enable atomically so an alarm cannot be overridden by enable.
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
            print_error(command_name, "timer_unavailable");
            return;
        }

        // --------------------
        // measurement and cleanup
        // --------------------
        // A scan measures 15 targets per source, within the 20 ms cutoff.
        // No USB printing or command parsing while injection is enabled.
        for (uint target = scanning ? 0 : requested_target;
             target < (scanning ? CHANNEL_COUNT : requested_target + 1); ++target)
        {
            if (source == target) continue;
            responses[source][target] = measure_channel(target);
            if (probe_timed_out) break;
        }
        disable_injection();
        cancel_alarm(alarm);
        if (probe_timed_out)
        {
            print_error(command_name, "probe_timeout");
            return;
        }
        if (!scanning)
        {
            printf("{\"type\":\"probe_result\",\"source\":%u,\"target\":%u,\"voltage\":%.3f}\n",
                   source, requested_target, responses[source][requested_target]);
            return;
        }
        printf("{\"type\":\"scan_progress\",\"completed_sources\":%u,\"total_sources\":%u}\n",
               source + 1, CHANNEL_COUNT);
    }

    // --------------------
    // bidirectional classification
    // --------------------
    uint16_t connected[CHANNEL_COUNT] = {0};
    uint16_t ambiguous[CHANNEL_COUNT] = {0};
    for (uint a = 0; a < CHANNEL_COUNT; ++a)
    {
        for (uint b = a + 1; b < CHANNEL_COUNT; ++b)
        {
            if (responses[a][b] >= CONNECTION_HIGH_VOLTS && responses[b][a] >= CONNECTION_HIGH_VOLTS)
            {
                connected[a] |= 1u << b;
                connected[b] |= 1u << a;
            }
            else if (!(responses[a][b] <= CONNECTION_LOW_VOLTS && responses[b][a] <= CONNECTION_LOW_VOLTS))
            {
                // Includes intermediate voltages and asymmetric detection.
                ambiguous[a] |= 1u << b;
                ambiguous[b] |= 1u << a;
            }
        }
    }

    // --------------------
    // connected groups
    // --------------------
    uint16_t groups[CHANNEL_COUNT];
    bool uncertain[CHANNEL_COUNT];
    uint group_of[CHANNEL_COUNT];
    uint group_count = 0;
    uint16_t visited = 0;
    for (uint start = 0; start < CHANNEL_COUNT; ++start)
    {
        if (visited & (1u << start)) continue;
        uint16_t members = 1u << start;
        uint16_t previous;
        do
        {
            previous = members;
            for (uint node = 0; node < CHANNEL_COUNT; ++node)
            {
                if (members & (1u << node)) members |= connected[node];
            }
        } while (members != previous);

        groups[group_count] = members;
        uncertain[group_count] = false;
        for (uint node = 0; node < CHANNEL_COUNT; ++node)
        {
            if (!(members & (1u << node))) continue;
            group_of[node] = group_count;
            // Every pair in a confirmed group must agree. Any uncertain link,
            // including one to an outside node, prevents confirming the group.
            if (ambiguous[node] || (connected[node] & members) != (members & ~(1u << node)))
            {
                uncertain[group_count] = true;
            }
        }
        visited |= members;
        ++group_count;
    }

    // --------------------
    // scan result
    // --------------------
    bool has_ambiguity = false;
    for (uint group = 0; group < group_count; ++group)
    {
        has_ambiguity |= uncertain[group];
    }
    printf("{\"type\":\"connection_scan\",\"status\":\"%s\",\"provisional\":true,"
           "\"thresholds\":{\"low\":%.3f,\"high\":%.3f}",
           has_ambiguity ? "ambiguous" : "complete",
           (double)CONNECTION_LOW_VOLTS, (double)CONNECTION_HIGH_VOLTS);
    for (uint category = 0; category < 2; ++category)
    {
        printf(category == 0 ? ",\"groups\":[" : ",\"ambiguous_groups\":[");
        bool first_group = true;
        for (uint group = 0; group < group_count; ++group)
        {
            if (uncertain[group] != (category == 1)) continue;
            printf(first_group ? "[" : ",[");
            first_group = false;
            bool first_node = true;
            for (uint node = 0; node < CHANNEL_COUNT; ++node)
            {
                if (!(groups[group] & (1u << node))) continue;
                printf("%s%u", first_node ? "" : ",", node);
                first_node = false;
            }
            printf("]");
        }
        printf("]");
    }
    printf(",\"ambiguous_pairs\":[");
    bool first_pair = true;
    for (uint a = 0; a < CHANNEL_COUNT; ++a)
    {
        for (uint b = a + 1; b < CHANNEL_COUNT; ++b)
        {
            bool contradiction = group_of[a] == group_of[b] && !(connected[a] & (1u << b));
            if ((ambiguous[a] & (1u << b)) || contradiction)
            {
                // [a, b, voltage when injecting a, voltage when injecting b]
                printf("%s[%u,%u,%.3f,%.3f]", first_pair ? "" : ",", a, b,
                       responses[a][b], responses[b][a]);
                first_pair = false;
            }
        }
    }
    puts("]}");
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

    // --------------------
    // LED initialization and optional hardware test
    // --------------------
    led_strip_init();
#if LED_STRIP_SELF_TEST
    led_strip_set_brightness(16);
    led_strip_set_pixel(0, 255, 0, 0);
    led_strip_set_pixel(1, 0, 255, 0);
    led_strip_set_pixel(2, 0, 0, 255);
    led_strip_show();
    sleep_ms(300);
    led_strip_clear();
    led_strip_show();
    led_strip_set_brightness(255);
#endif

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
                    print_error("unknown", "invalid_command");
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
