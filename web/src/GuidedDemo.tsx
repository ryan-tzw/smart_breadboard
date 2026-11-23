import { useEffect, useEffectEvent, useRef, useState } from "react";
import type { LedCommand, VoltageMonitor } from "./serial";
import {
  ASSEMBLY_STEPS, checkPoweredDivider, classifyResistor, DEMO_BRIGHTNESS,
  INPUT_MIN, LED_FOR_CHANNEL, MAX_READING_AGE_MS, PASSIVE_LIMIT, POWER_STEP, RESISTANCE_KOHM, ROWS,
} from "./guidedDemo";

type Reading = { voltages: number[]; receivedAt: number };
type Props = {
  available: boolean;
  reading: Reading | null;
  getMonitor: () => VoltageMonitor | null;
  getReading: () => Reading | null;
  onActiveChange: (active: boolean) => void;
};

const blue = { r: 0, g: 0, b: 255 };
const green = { r: 0, g: 255, b: 0 };
const red = { r: 255, g: 0, b: 0 };
const allRows = Object.values(ROWS);

export function GuidedDemo({ available, reading, getMonitor, getReading, onActiveChange }: Props) {
  const [step, setStep] = useState(-1);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [manual, setManual] = useState(false);
  const [powerSince, setPowerSince] = useState(0);
  const [completed, setCompleted] = useState<ReturnType<typeof checkPoweredDivider> | null>(null);
  const operation = useRef<AbortController | null>(null);

  useEffect(() => () => operation.current?.abort(), []);

  const assembly = ASSEMBLY_STEPS[step];
  const voltageDetected = reading?.voltages.some((voltage) => voltage > PASSIVE_LIMIT) ?? false;
  const powered = step === POWER_STEP && reading && reading.receivedAt > powerSince
    ? checkPoweredDivider(reading.voltages) : null;
  const shown = completed ?? powered;

  async function run(work: (monitor: VoltageMonitor, signal: AbortSignal) => Promise<void>) {
    const monitor = getMonitor();
    if (!available || !monitor || operation.current) return;
    const controller = new AbortController();
    operation.current = controller;
    setBusy(true);
    try {
      await work(monitor, controller.signal);
    } catch (error) {
      if (!controller.signal.aborted) setFeedback(error instanceof Error ? error.message : String(error));
    } finally {
      operation.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  function requireUnpowered() {
    const latest = getReading();
    if (!latest || Date.now() - latest.receivedAt > MAX_READING_AGE_MS) {
      throw new Error("Waiting for a fresh voltage scan. Try again in a moment.");
    }
    if (latest.voltages.some((voltage) => voltage > PASSIVE_LIMIT)) {
      throw new Error("Voltage detected. Disconnect the external supply and try again.");
    }
  }

  async function setLights(monitor: VoltageMonitor, signal: AbortSignal, commands: LedCommand[]) {
    for (const command of commands) {
      signal.throwIfAborted();
      const reply = await monitor.sendLedCommand(command);
      signal.throwIfAborted();
      if (reply?.status !== "success") {
        throw new Error(reply?.status === "error" ? reply.message : "The board did not acknowledge the LED update.");
      }
    }
  }

  function pixels(rows: number[], colour: typeof blue): LedCommand[] {
    return rows.map((row) => ({ type: "set_led", index: LED_FOR_CHANNEL[row], ...colour }));
  }

  function start() {
    void run(async (monitor, signal) => {
      requireUnpowered();
      onActiveChange(true);
      setStep(0);
      setCompleted(null);
      setFeedback("");
      setManual(false);
      const first = ASSEMBLY_STEPS[0];
      await setLights(monitor, signal, [
        { type: "clear_leds" }, { type: "set_brightness", brightness: DEMO_BRIGHTNESS },
        ...pixels([first.from, first.to], blue),
      ]);
    });
  }

  function check(manuallyConfirmed = false) {
    if (!assembly) return;
    void run(async (monitor, signal) => {
      requireUnpowered();
      setManual(false);
      setFeedback("Checking connection…");
      const { from, to } = assembly;
      let feedback = "Jumper connection detected.";

      if (!manuallyConfirmed && step === 0) {
        const reply = await monitor.scanConnections();
        signal.throwIfAborted();
        if (reply?.status !== "complete") {
          throw new Error(reply?.status === "error" ? reply.message : "The scan did not return a result.");
        }
        const group = reply.result.groups.find((nodes) => nodes.includes(from));
        if (reply.result.status === "ambiguous" || !group?.includes(to) || group.length > 2) {
          const unexpected = group?.filter((node) => node !== from && node !== to) ?? [];
          setFeedback(reply.result.status === "ambiguous"
            ? "Scan inconclusive. Check the wiring and try again."
            : unexpected.length
              ? `Unexpected connection to channel ${unexpected.join(", ")}. Move the jumper to channel ${to}.`
              : `No connection detected between channels ${from} and ${to}.`);
          await setLights(monitor, signal, pixels(unexpected.length ? unexpected : [from], red));
          return;
        }
      } else if (!manuallyConfirmed) {
        const forward = await monitor.probeNodes(from, to);
        signal.throwIfAborted();
        requireUnpowered();
        const reverse = await monitor.probeNodes(to, from);
        signal.throwIfAborted();
        const classification = classifyResistor(forward, reverse);
        const readings = `${forward.toFixed(3)} V forward, ${reverse.toFixed(3)} V reverse.`;
        if (classification !== "resistor") {
          setManual(classification === "inconclusive");
          setFeedback(classification === "open" ? `No connection detected. ${readings}`
            : classification === "jumper" ? `Readings look like a jumper. Use a ${RESISTANCE_KOHM} kΩ resistor. ${readings}`
            : `Inconclusive. Check the resistor placement or confirm it manually. ${readings}`);
          await setLights(monitor, signal, pixels([from, to], red));
          return;
        }
        feedback = `Readings consistent with ${RESISTANCE_KOHM} kΩ. ${readings}`;
      } else {
        feedback = "Placement confirmed manually. The powered check will verify the divider output.";
      }

      const next = ASSEMBLY_STEPS[step + 1];
      const targets = next ? [next.from, next.to] : [ROWS.input, ROWS.ground];
      await setLights(monitor, signal, [
        { type: "clear_leds" },
        ...pixels(targets, blue),
        ...pixels([from, to].filter((row) => !targets.includes(row)), manuallyConfirmed ? blue : green),
      ]);
      setFeedback(feedback);
      setStep(step + 1);
      if (!next) setPowerSince(Date.now());
    });
  }

  const completePoweredStep = useEffectEvent((result: ReturnType<typeof checkPoweredDivider>) => {
    void run(async (monitor, signal) => {
      setCompleted(result);
      setFeedback("The input, midpoint, and ground readings match the expected divider.");
      await setLights(monitor, signal, [{ type: "clear_leds" }, ...pixels(allRows, green)]);
    });
  });

  useEffect(() => {
    if (busy || completed || step !== POWER_STEP || !reading || reading.receivedAt <= powerSince) return;
    const result = checkPoweredDivider(reading.voltages);
    if (!result.valid || Date.now() - reading.receivedAt > MAX_READING_AGE_MS) return;
    const scheduled = setTimeout(() => completePoweredStep(result), 0);
    return () => clearTimeout(scheduled);
  }, [busy, completed, powerSince, reading, step]);

  function exit() {
    void run(async (monitor, signal) => {
      await setLights(monitor, signal, [{ type: "clear_leds" }]);
      setStep(-1);
      setFeedback("");
      onActiveChange(false);
    });
  }

  return (
    <section className="guided-demo" aria-labelledby="demo-title">
      <h2 id="demo-title">Guided Demo</h2>
      {step < 0 ? (
        <>
          <p>Build a voltage divider with a jumper and two {RESISTANCE_KOHM} kΩ resistors. Disconnect the external supply before starting.</p>
          <button disabled={!available || busy} onClick={start}>Start Demo</button>
        </>
      ) : (
        <>
          <p className="note">Step {step + 1} of {POWER_STEP + 1}</p>
          <progress aria-label="Demo progress" max={POWER_STEP + 1} value={completed ? POWER_STEP + 1 : step} />
          <h3>{completed ? "Divider complete" : assembly?.title ?? "Power the divider"}</h3>
          <p className="demo-circuit" aria-label="Divider wiring">
            5 V → Ch {ROWS.input} → jumper → Ch {ROWS.resistorStart} → {RESISTANCE_KOHM} kΩ → Ch {ROWS.midpoint} → {RESISTANCE_KOHM} kΩ → Ch {ROWS.ground} → GND
          </p>
          {assembly ? (
            <p>Connect {assembly.component} between channels {assembly.from} and {assembly.to}. Keep the external supply disconnected.</p>
          ) : !completed && (
            <p>Connect the supply ground to channel {ROWS.ground}, then connect 5 V to channel {ROWS.input}. The app checks the voltage automatically.</p>
          )}
          {shown && (
            <p>
              Input {shown.input.toFixed(2)} V · After jumper {shown.afterJumper.toFixed(2)} V · Midpoint {shown.midpoint.toFixed(2)} V
              {" "}(expected {shown.expected.toFixed(2)} V) · Ground {shown.ground.toFixed(2)} V
              {!shown.valid && (shown.input < INPUT_MIN ? " · Waiting for 5 V input." : " · Outside the expected range. Check the wiring.")}
            </p>
          )}
          {!assembly && <p>Disconnect the external supply before restarting or running an active check.</p>}
          {assembly && voltageDetected && <p className="error" role="alert">Voltage detected. Disconnect the external supply before checking connections.</p>}
          <div className="controls">
            {assembly && <button disabled={busy || !available || voltageDetected} onClick={() => check()}>Check Connection</button>}
            {assembly && manual && (
              <button disabled={busy || !available || voltageDetected} onClick={() => check(true)}>Confirm Placement Manually</button>
            )}
            <button disabled={busy || !available} onClick={start}>Restart Demo</button>
            <button disabled={busy || !available} onClick={exit}>Exit Demo</button>
          </div>
        </>
      )}
      {feedback && <p role="status">{feedback}</p>}
    </section>
  );
}
