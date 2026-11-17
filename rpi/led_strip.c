#include "led_strip.h"

#include "pico/stdlib.h"
#include "hardware/pio.h"
#include "ws2812.pio.h"

#define LED_DATA_PIN 9
#define LED_RESET_US 300

_Static_assert(LED_STRIP_COUNT > 0, "LED_STRIP_COUNT must be positive");

static const PIO led_pio = pio0;
static uint led_sm;
static uint8_t brightness = 255;
static struct {
    uint8_t r;
    uint8_t g;
    uint8_t b;
} pixels[LED_STRIP_COUNT];

void led_strip_init(void)
{
    gpio_init(LED_DATA_PIN);
    gpio_put(LED_DATA_PIN, 0);
    gpio_set_dir(LED_DATA_PIN, GPIO_OUT);

    led_sm = pio_claim_unused_sm(led_pio, true);
    uint offset = pio_add_program(led_pio, &ws2812_program);
    ws2812_program_init(led_pio, led_sm, offset, LED_DATA_PIN, 800000, false);

    // The idle PIO program holds data low; establish a reset before frame one.
    sleep_us(LED_RESET_US);
    led_strip_clear();
    led_strip_show();
}

void led_strip_set_pixel(unsigned int index, uint8_t r, uint8_t g, uint8_t b)
{
    if (index >= LED_STRIP_COUNT) return;
    pixels[index].r = r;
    pixels[index].g = g;
    pixels[index].b = b;
}

void led_strip_fill(uint8_t r, uint8_t g, uint8_t b)
{
    for (uint index = 0; index < LED_STRIP_COUNT; ++index)
    {
        pixels[index].r = r;
        pixels[index].g = g;
        pixels[index].b = b;
    }
}

void led_strip_clear(void)
{
    led_strip_fill(0, 0, 0);
}

void led_strip_set_brightness(uint8_t value)
{
    brightness = value;
}

void led_strip_show(void)
{
    for (uint index = 0; index < LED_STRIP_COUNT; ++index)
    {
        // Scale only the transmitted values, preserving the original RGB frame.
        uint32_t r = ((uint32_t)pixels[index].r * brightness + 127) / 255;
        uint32_t g = ((uint32_t)pixels[index].g * brightness + 127) / 255;
        uint32_t b = ((uint32_t)pixels[index].b * brightness + 127) / 255;
        uint32_t grb = (g << 16) | (r << 8) | b;
        pio_sm_put_blocking(led_pio, led_sm, grb << 8);
    }

    while (!pio_sm_is_tx_fifo_empty(led_pio, led_sm))
    {
        tight_loop_contents();
    }
    // FIFO-empty can precede the last word finishing in the shift register.
    // Allow 40 us for that word/boundary bit, then at least 300 us low to latch.
    sleep_us(40 + LED_RESET_US);
}
