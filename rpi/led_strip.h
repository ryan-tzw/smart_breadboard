#ifndef LED_STRIP_H
#define LED_STRIP_H

#include <stdint.h>

#ifndef LED_STRIP_COUNT
#define LED_STRIP_COUNT 100
#endif

#ifndef LED_STRIP_SELF_TEST
#define LED_STRIP_SELF_TEST 0
#endif

// Initialize once at startup; sends an all-off frame. Default brightness is 255.
void led_strip_init(void);

// These functions update stored colours only. Out-of-range indices are ignored.
void led_strip_set_pixel(unsigned int index, uint8_t r, uint8_t g, uint8_t b);
void led_strip_fill(uint8_t r, uint8_t g, uint8_t b);
void led_strip_clear(void);
void led_strip_set_brightness(uint8_t brightness);

// Send and latch the stored frame. Call from the main loop, outside probing.
void led_strip_show(void);

#endif
