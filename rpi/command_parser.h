#ifndef COMMAND_PARSER_H
#define COMMAND_PARSER_H

#include <stdbool.h>

typedef enum {
    COMMAND_INVALID,
    COMMAND_PROBE,
    COMMAND_SCAN_CONNECTIONS
} CommandType;

// Output channels are only set for a valid probe command.
CommandType parse_command(const char *text, unsigned int channel_count,
                          unsigned int *source_out, unsigned int *target_out);

#endif
