#ifndef COMMAND_PARSER_H
#define COMMAND_PARSER_H

#include <stdbool.h>

// Returns false for invalid commands; output channels are only set on success.
bool parse_probe_command(const char *text, unsigned int channel_count,
                         unsigned int *source_out, unsigned int *target_out);

#endif
