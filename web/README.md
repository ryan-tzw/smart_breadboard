# Smart Breadboard voltage monitor

From `web/`, run:

```sh
pnpm install
pnpm dev
```

Open the localhost URL printed by Vite in desktop Chrome or Edge. Web Serial requires a secure context; localhost is supported.

1. Flash the Milestone 1 UF2 onto the RP2040-Zero and connect it over USB.
2. Close picocom or any other application using the serial port.
3. Click **Connect** and select the board's USB serial port.
4. The table updates when a complete voltage scan arrives, approximately once per second.
5. Click **Disconnect** before opening the port in another application.

Each NDJSON message must have `type: "voltage_scan"` and a `voltages` array containing exactly 16 finite numbers in channel order. Malformed messages are reported and skipped. Readings remain visible with a disconnect indication if the connection ends. Floating nodes can show arbitrary readings.

Serial handling is in `src/serial.ts`; the React UI is in `src/App.tsx`. No commands are sent to the board.

Checks:

```sh
pnpm build
pnpm lint
node --experimental-strip-types --test tests/serial.test.ts
```

Automated serial checks use simulated streams. Confirm real USB readings manually with the board.
