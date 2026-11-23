# Smart Breadboard monitor

From `web/`, run:

```sh
pnpm install
pnpm dev
```

Open the localhost URL printed by Vite in desktop Chrome or Edge. Web Serial requires a secure context; localhost is supported.

1. Flash the 15-node firmware UF2 onto the RP2040-Zero and connect it over USB.
2. Close picocom or any other application using the serial port.
3. Click **Connect** and select the board's USB serial port.
4. The voltage table updates approximately once per second.
5. On a known, externally unpowered circuit, click **Scan Connections**.
6. Watch progress and read detected groups, uncertain groups, and directional measurements for ambiguous pairs.
7. Use **LED Control** to choose an index and colour, set the selected LED, apply the colour to all LEDs, or clear them.
8. Move the brightness slider and click **Apply Brightness** to send that setting.
9. Click **Disconnect** before opening the port in another application.

The browser sends `{"type":"scan_connections"}` followed by LF. During a scan, Connect, Disconnect, and repeat scan actions are disabled. Passive voltage readings remain visible and update again after scanning. Results are provisional; they do not distinguish wires from component connections. Disconnect external circuit power before scanning; the firmware voltage pre-check cannot prove a circuit is unpowered.

Detected groups include isolated channels, labeled as having no detected connection. Uncertain groups are shown separately. The ambiguous-pair table labels A → B as the voltage measured at B while injecting at A, and B → A as the reverse measurement. The applied detection thresholds appear beneath the result.

Firmware refusals and serial errors are displayed. A scan with no progress or result for 10 seconds fails and closes the serial connection; reconnect before retrying. A failed command write also closes the connection to avoid queuing another command after a possibly partial write. Physical removal interrupts the scan and releases serial resources. Closing the browser connection does not send a firmware cancellation command; the firmware finishes its bounded scan independently.

The LED controls send `set_led`, `fill_leds`, `clear_leds`, or `set_brightness` commands over the same connection and wait for a matching `led_ack`. Controls are desired values; editing the index, colour, or brightness alone sends no command. A successful acknowledgement confirms firmware execution, not physical LED feedback. Brightness 0 preserves the stored colours; clearing removes the colours without resetting brightness.

Only one LED command can be pending at a time. LED controls are disabled while disconnected or scanning. Scan and Disconnect are disabled while awaiting an LED acknowledgement. Both serial command paths share a writer, preventing overlapping writes. Firmware errors end the pending action; missing acknowledgements time out after 10 seconds and close the connection before retrying.

`LED_COUNT` in `src/serial.ts` is 15 and must match `LED_STRIP_COUNT` in the firmware if you change the configured count. Inputs validate indices 0–14 and RGB/brightness integers 0–255. The web app does not query or persist strip state.

Incoming NDJSON is buffered until a complete line is received, validated, and dispatched by message type: `voltage_scan`, `scan_progress`, `connection_scan`, `probe_result`, `led_ack`, or `error`. Lines are bounded to 4096 characters. Invalid messages are reported and skipped. Scan results must account for all 15 channels without duplicates and contain finite directional voltages. Last readings/results remain visible with a disconnect indication until reconnecting. Floating nodes can show arbitrary readings.

Serial communication and message validation are in `src/serial.ts`; the React UI is in `src/App.tsx`. Firmware schemas and thresholds are described in `../rpi/README.md`.

## Guided divider demo

Connect the board and click **Start Demo** with the external supply disconnected. Place a jumper wire across channels **0–1**, a **47 kΩ** resistor across **1–2**, and a second **47 kΩ** resistor across **2–3**. Check each placement in the app. The jumper wire check uses a connectivity scan. Each resistor check probes in both directions, and an inconclusive reading can be confirmed manually. Blue LEDs indicate the current placement. On completion, a green wave with a fading trail crosses the strip before the next placement is highlighted. Wiring feedback appears in the app.

Connect channel **3** to the **− rail (GND)** and confirm in the app. The final step highlights channel **0** for the **+ rail (5 V)**. Both rail steps use passive readings. The demo shows the live source and divided voltages. Channel **2** should read about **2.08 V** at a 5.00 V input because the board's 115 kΩ measurement path loads the divider. Disconnect the external supply before restarting.

The demo uses LED index `14 - channel` and defaults to brightness 3. If USB disconnects, reconnect and start a new demo. The first action clears the strip. Channel assignments, LED mapping, brightness, probe bands, and voltage tolerances are in `src/guidedDemo.ts`. The starting probe bands are nominal. Confirm a jumper wire and each 47 kΩ resistor read in the expected bands on the prototype before presenting.

Checks:

```sh
pnpm build
pnpm lint
```

For manual verification, connect two disjoint jumper groups, confirm the live voltages appear, run a scan, and check both groups and remaining isolated channels. Verify repeat scans work and removing the USB cable clears the running state. For LEDs, set one LED to red, fill all with blue, apply low brightness, then clear them. Verify brightness 0 followed by restoring brightness retains the stored colour, and that voltage readings and connectivity scanning still work. Confirm real USB and LED behavior with the board.
