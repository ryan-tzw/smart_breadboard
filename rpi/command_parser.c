#include "command_parser.h"

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

bool parse_probe_command(const char *text, unsigned int channel_count,
                         unsigned int *source_out, unsigned int *target_out)
{
    jsmn_parser parser;
    jsmntok_t tokens[7]; // One object and exactly three key/value pairs.
    size_t length = strlen(text);
    jsmn_init(&parser);
    int count = jsmn_parse(&parser, text, length, tokens, 7);
    unsigned int source = 0;
    unsigned int target = 0;
    unsigned int fields = 0;
    bool valid = count == 7 && tokens[0].type == JSMN_OBJECT && tokens[0].size == 3;
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
        if (text[cursor++] != (index == 5 ? '}' : ','))
        {
            valid = false;
            break;
        }

        unsigned int field;
        if (token_matches(text, key, "type"))
        {
            field = 1;
            valid = token_matches(text, value, "probe");
        }
        else if (token_matches(text, key, "source") || token_matches(text, key, "target"))
        {
            field = token_matches(text, key, "source") ? 2 : 4;
            int digits = value->end - value->start;
            valid = value->type == JSMN_PRIMITIVE && digits >= 1 && digits <= 2;
            unsigned int channel = 0;
            for (int digit = value->start; valid && digit < value->end; ++digit)
            {
                char character = text[digit];
                valid = character >= '0' && character <= '9';
                if (valid)
                {
                    channel = channel * 10 + (unsigned int)(character - '0');
                }
            }
            valid = valid && channel < channel_count &&
                    !(digits > 1 && text[value->start] == '0');
            if (field == 2)
            {
                source = channel;
            }
            else
            {
                target = channel;
            }
        }
        else
        {
            valid = false;
            break;
        }
        valid = valid && (fields & field) == 0;
        fields |= field;
    }
    if (!valid || fields != 7 || source == target || cursor != tokens[0].end ||
        (size_t)cursor + strspn(text + cursor, " \t\r\n") != length)
    {
        return false;
    }

    *source_out = source;
    *target_out = target;
    return true;
}
