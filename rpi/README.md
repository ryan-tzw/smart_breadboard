# Smart Breadboard firmware

Build from the repository root using the existing Pico SDK configuration:

```sh
cmake --build rpi/build
```

Output: `rpi/build/RP2040_Zero_Test.uf2`. Hold BOOT while pressing and releasing RESET, then release BOOT and copy the UF2 onto `RPI-RP2`. Flashing is manual.

`main.c` contains hardware initialization, passive monitoring, and the probe/scan sequence. `command_parser.c/.h` handles JSON parsing and validation without accessing GPIO or STDIO.

## Wiring

- GPIO0–3: MUX1 S0–S3; GPIO26: ADC0 through the existing 47 kΩ / 68 kΩ divider.
- GPIO4–7: MUX2 S0–S3; GPIO8: MUX2 active-low enable.
- GPIO27: injection through 10 kΩ to MUX2 COM.
- Both MUXes use the same channel-to-node mapping. Selection and enable signals use the existing level shifters. GPIO9 is untouched.

MUX2 is disabled during firmware startup, passive scans, command parsing, and between source injections. GPIO27 is an input without pulls when idle. It drives 3.3 V only during a probe. This is resistor-limited voltage injection, not a constant-current source.

## Passive monitoring

USB STDIO emits one NDJSON `voltage_scan` containing 16 channel-ordered voltages approximately once per second. Channel settling remains 1 ms, followed by a discarded conversion and one measurement. Conversion uses the nominal 3.3 V ADC reference and the existing divider correction.

## Individual probes (Milestone 3)

Use only known, externally unpowered circuits. Disconnect the powered resistor ladder before probing. The passive voltage pre-check is a precaution; it cannot establish that a circuit is unpowered or protect against arbitrary voltages or charged components.

Close the browser serial connection, then open:

```sh
picocom -b 115200 --echo --omap crlf /dev/ttyACM0
```

Adjust the device path if needed. `--omap crlf` makes Enter send LF. Paste a complete command and press Enter:

```json
{"type":"probe","source":2,"target":5}
```

The three fields may appear in any order, with JSON whitespace. Source and target must be distinct decimal integers from 0 to 15. Commands are tokenized by the vendored jsmn library in strict mode, with a fixed seven-token buffer and application validation. The interface accepts these literal field names and `"probe"`; escaped strings, extra or duplicate fields, fractional/exponent numbers, and trailing data are rejected. Lines may contain at most 127 bytes before LF. Oversized or invalid-byte lines are discarded through the next LF. No command executes before a newline is received.

Each probe:

1. Disables injection and measures all 16 nodes afresh.
2. Refuses injection if any reconstructed voltage exceeds `PROBE_MAX_PASSIVE_VOLTS` (0.3 V).
3. Selects MUX2's source while disabled, arms the timer, drives GPIO27 HIGH, and enables MUX2.
4. Measures the MUX1 target after 1 ms settling and a discarded conversion.
5. Disables MUX2 and returns GPIO27 to high impedance before printing the result.

An alarm interrupt also disables injection after `PROBE_TIMEOUT_MS` (20 ms). A single probe normally injects for approximately 1 ms; no USB output is attempted while it is enabled. If the alarm cannot be allocated, no injection occurs. These constants are configurable in `main.c`.

Example result (illustrative):

```json
{"type":"probe_result","source":2,"target":5,"voltage":3.036}
```

A direct jumper can measure around 3.0 V because the injection resistor and measurement divider load the signal. The result reports voltage only and does not classify connectivity. Passive scans continue between commands.

Errors use `type: "error"`, `command: "probe"`, and a `code`: `invalid_command`, `unexpected_voltage`, `timer_unavailable`, or `probe_timeout`. Scan errors use `command: "scan_connections"`; commands that cannot be validated use `command: "unknown"`. `unexpected_voltage` also reports the offending channel, measured voltage, and threshold. Errors are printed with injection disabled.

## Automatic connectivity scan (Milestone 4)

Using the same serial terminal and known, externally unpowered circuit, send:

```json
{"type":"scan_connections"}
```

This command accepts only the `type` field. For each of the 16 sources, the firmware disables injection, checks all nodes against the existing 0.3 V passive limit, then injects into that source while measuring the other 15 nodes. Injection normally lasts approximately 15 ms per source, with the same 20 ms timer cutoff. Injection is disabled before any progress or result output. Passive monitoring and command processing resume after the scan; no partial connectivity result is emitted on failure.

The configurable constants in `main.c` are:

- `CONNECTION_LOW_VOLTS` (0.3 V): both directions at or below this value indicate no detected connection.
- `CONNECTION_HIGH_VOLTS` (2.0 V): both directions at or above this value indicate a detected connection.
- Intermediate voltages or disagreement between directions make the pair ambiguous.

Pairs detected in both directions form candidate groups. A group is confirmed only if all its pairs agree and none of its nodes has an ambiguous link to another group. For example, A–B and B–C detected but A–C absent makes the entire candidate group ambiguous. Isolated nodes appear as singleton groups. Results are provisional voltage-response indications, not proof of direct wires or component type; grounded or heavily loaded nets may not produce a detectable response.

Progress messages contain `type: "scan_progress"`, `completed_sources` (0–16), and `total_sources` (16). The final NDJSON message has:

- `type: "connection_scan"` and `status: "complete"` or `"ambiguous"`.
- `provisional: true` and the applied `thresholds.low` / `thresholds.high`.
- `groups`: confirmed node groups, including singletons.
- `ambiguous_groups`: candidate groups whose membership cannot be confirmed.
- `ambiguous_pairs`: entries `[a, b, voltage_a_to_b, voltage_b_to_a]`, reporting intermediate/asymmetric pairs and missing pairwise detections within a candidate group.

The compact pair arrays keep even a fully ambiguous 16-node result below the existing browser's 4096-character line limit. The web app supports scan commands, progress, and results through its Scan Connections button (Milestone 5). Individual probe commands remain available through a serial terminal.

## Manual verification

Use an unpowered jumper between the requested nodes, compare the probe voltage with an open target, and verify GPIO8 is HIGH and injection inactive between commands. For a scan, try two disjoint jumper groups and verify the result lists each group and the remaining isolated nodes. Verify injection is disabled between sources and after the result or any error. Keep the browser disconnected during terminal testing.

References: [Pico SDK](https://www.raspberrypi.com/documentation/pico-sdk/runtime.html), [CD74HC4067](https://www.ti.com/product/CD74HC4067), [picocom](https://github.com/npat-efault/picocom/blob/master/picocom.1.html).
