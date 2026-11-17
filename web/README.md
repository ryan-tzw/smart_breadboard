# Smart Breadboard monitor

From `web/`, run:

```sh
pnpm install
pnpm dev
```

Open the localhost URL printed by Vite in desktop Chrome or Edge. Web Serial requires a secure context; localhost is supported.

1. Flash the Milestone 4 UF2 onto the RP2040-Zero and connect it over USB.
2. Close picocom or any other application using the serial port.
3. Click **Connect** and select the board's USB serial port.
4. The voltage table updates approximately once per second.
5. On a known, externally unpowered circuit, click **Scan Connections**.
6. Watch progress and read detected groups, uncertain groups, and directional measurements for ambiguous pairs.
7. Click **Disconnect** before opening the port in another application.

The browser sends `{"type":"scan_connections"}` followed by LF. During a scan, Connect, Disconnect, and repeat scan actions are disabled. Passive voltage readings remain visible and update again after scanning. Results are provisional; they do not distinguish wires from component connections. Disconnect external circuit power before scanning; the firmware voltage pre-check cannot prove a circuit is unpowered.

Detected groups include isolated channels, labeled as having no detected connection. Uncertain groups are shown separately. The ambiguous-pair table labels A → B as the voltage measured at B while injecting at A, and B → A as the reverse measurement. The applied detection thresholds appear beneath the result.

Firmware refusals and serial errors are displayed. A scan with no progress or result for 10 seconds fails and closes the serial connection; reconnect before retrying. A failed command write also closes the connection to avoid queuing another command after a possibly partial write. Physical removal interrupts the scan and releases serial resources. Closing the browser connection does not send a firmware cancellation command; the firmware finishes its bounded scan independently.

Incoming NDJSON is buffered until a complete line is received, validated, and dispatched by message type: `voltage_scan`, `scan_progress`, `connection_scan`, or `error`. Lines are bounded to 4096 characters. Invalid messages are reported and skipped. Scan results must account for all 16 channels without duplicates and contain finite directional voltages. Last readings/results remain visible with a disconnect indication until reconnecting. Floating nodes can show arbitrary readings.

Serial communication and message validation are in `src/serial.ts`; the React UI is in `src/App.tsx`. Firmware schemas and thresholds are described in `../rpi/README.md`.

Checks:

```sh
pnpm build
pnpm lint
```

For manual verification, connect two disjoint jumper groups, confirm the live voltages appear, run a scan, and check both groups and remaining isolated channels. Verify repeat scans work and removing the USB cable clears the running state. Confirm real USB behavior with the board.
