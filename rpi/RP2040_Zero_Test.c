#include <stdio.h>

#include "pico/stdlib.h"
#include "hardware/adc.h"

#define MUX_SELECT_MASK 0x0fu
#define ADC_PIN 26
#define ADC_INPUT 0

int main(void)
{
    // GPIO0 is S0 (LSB), through GPIO3 as S3 (MSB).
    gpio_init_mask(MUX_SELECT_MASK);
    gpio_put_masked(MUX_SELECT_MASK, 0);
    gpio_set_dir_out_masked(MUX_SELECT_MASK);

    adc_init();
    adc_gpio_init(ADC_PIN);
    adc_select_input(ADC_INPUT);
    stdio_init_all();

    // Undo the 47 kohm / 68 kohm divider using a nominal 3.3 V reference.
    const float input_volts_per_count = (3.3f / 4096.0f) * (115.0f / 68.0f);

    while (true)
    {
        absolute_time_t next_scan = make_timeout_time_ms(1000);
        puts("\nSmart breadboard scan (nominal 3.3 V ADC reference)");
        puts("Channel  Raw ADC  Input voltage");

        for (uint channel = 0; channel < 16; ++channel)
        {
            gpio_put_masked(MUX_SELECT_MASK, channel);
            sleep_ms(1);
            (void)adc_read(); // Discard the first conversion after switching.
            uint16_t raw = adc_read();
            float input_voltage = raw * input_volts_per_count;

            printf("%7u  %7u  %8.3f V\n", channel, (unsigned int)raw,
                   input_voltage);
        }

        // Include settling and printing time in the one-second scan period.
        sleep_until(next_scan);
    }
}
