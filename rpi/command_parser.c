#include "command_parser.h"

#include <limits.h>
#include <string.h>

#define JSMN_STATIC
#define JSMN_STRICT
#include "jsmn.h"

static bool token_matches(const char *text, const jsmntok_t *token, const char *expected)
{
    size_t length = strlen(expected);
    return token->type == JSMN_STRING && token->end - token->start == (int)length &&
           strncmp(text + token->start, expected, length) == 0;
}

bool parse_command(const char *text, unsigned int channel_count,
                   unsigned int led_count, Command *output)
{
    enum { TYPE, SOURCE, TARGET, INDEX, RED, GREEN, BLUE, BRIGHTNESS, FIELD_COUNT };
    static const char *const field_names[FIELD_COUNT] = {
        "type", "source", "target", "index", "r", "g", "b", "brightness"
    };
    unsigned int values[FIELD_COUNT] = {0};
    Command parsed = {0};
    jsmn_parser parser;
    jsmntok_t tokens[11]; // One object and at most five key/value pairs (set_led).
    size_t length = strlen(text);
    jsmn_init(&parser);
    int count = jsmn_parse(&parser, text, length, tokens, 11);
    unsigned int fields = 0;
    bool valid = count >= 3 && count % 2 == 1 && tokens[0].type == JSMN_OBJECT &&
                 tokens[0].size == (count - 1) / 2;
    int cursor = valid ? tokens[0].start + 1 : 0;
    if (valid && strspn(text, " \t\r\n") != (size_t)tokens[0].start)
    {
        valid = false;
    }

    for (int index = 1; valid && index < count; index += 2)
    {
        const jsmntok_t *key = &tokens[index];
        const jsmntok_t *value = &tokens[index + 1];
        if (key->type != JSMN_STRING || key->size != 1 || value->size != 0)
        {
            valid = false;
            break;
        }

        // jsmn is a tokenizer: also require the separators of this flat object.
        cursor += (int)strspn(text + cursor, " \t\r\n");
        if (cursor != key->start - 1)
        {
            valid = false;
            break;
        }
        cursor = key->end + 1;
        cursor += (int)strspn(text + cursor, " \t\r\n");
        if (text[cursor++] != ':')
        {
            valid = false;
            break;
        }
        cursor += (int)strspn(text + cursor, " \t\r\n");
        if (cursor != value->start - (value->type == JSMN_STRING ? 1 : 0))
        {
            valid = false;
            break;
        }
        cursor = value->end + (value->type == JSMN_STRING ? 1 : 0);
        cursor += (int)strspn(text + cursor, " \t\r\n");
        if (text[cursor++] != (index == count - 2 ? '}' : ','))
        {
            valid = false;
            break;
        }

        unsigned int field = 0;
        while (field < FIELD_COUNT && !token_matches(text, key, field_names[field])) ++field;
        if (field == FIELD_COUNT || (fields & (1u << field)))
        {
            valid = false;
            break;
        }
        if (field == TYPE)
        {
            if (token_matches(text, value, "probe")) parsed.type = COMMAND_PROBE;
            else if (token_matches(text, value, "scan_connections")) parsed.type = COMMAND_SCAN_CONNECTIONS;
            else if (token_matches(text, value, "set_led")) parsed.type = COMMAND_SET_LED;
            else if (token_matches(text, value, "fill_leds")) parsed.type = COMMAND_FILL_LEDS;
            else if (token_matches(text, value, "clear_leds")) parsed.type = COMMAND_CLEAR_LEDS;
            else if (token_matches(text, value, "set_brightness")) parsed.type = COMMAND_SET_BRIGHTNESS;
            valid = parsed.type != COMMAND_INVALID;
        }
        else
        {
            int digits = value->end - value->start;
            valid = value->type == JSMN_PRIMITIVE && digits >= 1 &&
                    !(digits > 1 && text[value->start] == '0');
            unsigned int number = 0;
            for (int digit = value->start; valid && digit < value->end; ++digit)
            {
                char character = text[digit];
                if (character < '0' || character > '9' ||
                    number > (UINT_MAX - (unsigned int)(character - '0')) / 10)
                {
                    valid = false;
                    break;
                }
                number = number * 10 + (unsigned int)(character - '0');
            }
            if (field == SOURCE || field == TARGET) valid = valid && number < channel_count;
            else if (field == INDEX) valid = valid && number < led_count;
            else valid = valid && number <= 255;
            values[field] = number;
        }
        fields |= 1u << field;
    }

    unsigned int required = 1u << TYPE;
    unsigned int rgb_fields = (1u << RED) | (1u << GREEN) | (1u << BLUE);
    switch (parsed.type)
    {
        case COMMAND_PROBE:
            required |= (1u << SOURCE) | (1u << TARGET);
            valid = valid && values[SOURCE] != values[TARGET];
            break;
        case COMMAND_SCAN_CONNECTIONS:
        case COMMAND_CLEAR_LEDS:
            break;
        case COMMAND_SET_LED:
            required |= (1u << INDEX) | rgb_fields;
            break;
        case COMMAND_FILL_LEDS:
            required |= rgb_fields;
            break;
        case COMMAND_SET_BRIGHTNESS:
            required |= 1u << BRIGHTNESS;
            break;
        default:
            valid = false;
            break;
    }
    if (!valid || fields != required || cursor != tokens[0].end ||
        (size_t)cursor + strspn(text + cursor, " \t\r\n") != length)
    {
        return false;
    }

    parsed.source = values[SOURCE];
    parsed.target = values[TARGET];
    parsed.index = values[INDEX];
    parsed.r = (uint8_t)values[RED];
    parsed.g = (uint8_t)values[GREEN];
    parsed.b = (uint8_t)values[BLUE];
    parsed.brightness = (uint8_t)values[BRIGHTNESS];
    *output = parsed;
    return true;
}
