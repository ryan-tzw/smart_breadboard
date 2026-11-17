#ifndef COMMAND_PARSER_H
#define COMMAND_PARSER_H

#include <stdbool.h>
#include <stdint.h>

typedef enum {
    COMMAND_INVALID,
    COMMAND_PROBE,
    COMMAND_SCAN_CONNECTIONS,
    COMMAND_SET_LED,
    COMMAND_FILL_LEDS,
    COMMAND_CLEAR_LEDS,
    COMMAND_SET_BRIGHTNESS
} CommandType;

typedef struct {
    CommandType type;
    unsigned int source;
    unsigned int target;
    unsigned int index;
    uint8_t r;
    uint8_t g;
    uint8_t b;
    uint8_t brightness;
} Command;

// The output is only written for a fully validated command.
bool parse_command(const char *text, unsigned int channel_count,
                   unsigned int led_count, Command *output);

#endif
