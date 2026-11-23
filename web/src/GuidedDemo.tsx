import { useEffect, useEffectEvent, useRef, useState } from "react";
import type { LedCommand, VoltageMonitor } from "./serial";
import {
  ASSEMBLY_STEPS,
  checkPoweredDivider,
  CONNECTION_MIN_VOLTS,
  DEMO_BRIGHTNESS,
  GROUND_STEP,
  INPUT_MIN,
  LED_FOR_CHANNEL,
  MAX_READING_AGE_MS,
  PASSIVE_LIMIT,
  POWER_STEP,
  ROWS,
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
const sweepLedIndices = [...LED_FOR_CHANNEL].reverse();
// Brightness 3 gives us three visible levels on the physical strip.
const SWEEP_GREEN_LEVELS = [255, 170, 85, 0];
const SWEEP_FRAME_MS = 40;

export function GuidedDemo({ available, reading, getMonitor, getReading, onActiveChange }: Props) {
  const [step, setStep] = useState(-1);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [restartBlocked, setRestartBlocked] = useState(false);
  const [powerSince, setPowerSince] = useState(0);
  const [completed, setCompleted] = useState(false);
  const operation = useRef<AbortController | null>(null);

  useEffect(() => () => operation.current?.abort(), []);

  const assembly = ASSEMBLY_STEPS[step];
  const highChannel = reading?.voltages.findIndex((voltage) => voltage > PASSIVE_LIMIT) ?? -1;
  const showVoltageWarning = highChannel >= 0 && (step < POWER_STEP || restartBlocked);
  const powered =
    step === POWER_STEP && reading && reading.receivedAt > powerSince
      ? checkPoweredDivider(reading.voltages)
      : null;

  async function run(work: (monitor: VoltageMonitor, signal: AbortSignal) => Promise<void>) {
    const monitor = getMonitor();
    if (!available || !monitor || operation.current) return;
    const controller = new AbortController();
    operation.current = controller;
    setBusy(true);
    try {
      await work(monitor, controller.signal);
    } catch (error) {
      if (!controller.signal.aborted)
        setFeedback(error instanceof Error ? error.message : String(error));
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
    return latest.voltages.every((voltage) => voltage <= PASSIVE_LIMIT);
  }

  async function setLights(monitor: VoltageMonitor, signal: AbortSignal, commands: LedCommand[]) {
    for (const command of commands) {
      signal.throwIfAborted();
      const reply = await monitor.sendLedCommand(command);
      signal.throwIfAborted();
      if (reply?.status !== "success") {
        throw new Error(
          reply?.status === "error"
            ? reply.message
            : "The board did not acknowledge the LED update.",
        );
      }
    }
  }

  function pixels(rows: number[], colour: typeof blue): LedCommand[] {
    return rows.map((row) => ({ type: "set_led", index: LED_FOR_CHANNEL[row], ...colour }));
  }

  async function sweepSuccess(monitor: VoltageMonitor, signal: AbortSignal, nextRows: number[]) {
    await setLights(monitor, signal, [{ type: "clear_leds" }]);
    const tailLength = SWEEP_GREEN_LEVELS.length - 1;
    for (let head = 0; head < sweepLedIndices.length + tailLength; head++) {
      const frame: LedCommand[] = [];
      const first = Math.max(0, head - tailLength);
      const last = Math.min(head, sweepLedIndices.length - 1);
      for (let position = first; position <= last; position++) {
        frame.push({
          type: "set_led",
          index: sweepLedIndices[position],
          r: 0,
          g: SWEEP_GREEN_LEVELS[head - position],
          b: 0,
        });
      }
      await setLights(monitor, signal, frame);
      await new Promise<void>((resolve) => setTimeout(resolve, SWEEP_FRAME_MS));
    }
    await setLights(monitor, signal, [{ type: "clear_leds" }, ...pixels(nextRows, blue)]);
  }

  function start() {
    void run(async (monitor, signal) => {
      setFeedback("");
      if (!requireUnpowered()) {
        setRestartBlocked(step === POWER_STEP);
        return;
      }
      setRestartBlocked(false);
      onActiveChange(true);
      setStep(0);
      setCompleted(false);
      const first = ASSEMBLY_STEPS[0];
      await setLights(monitor, signal, [
        { type: "clear_leds" },
        { type: "set_brightness", brightness: DEMO_BRIGHTNESS },
        ...pixels([first.from, first.to], blue),
      ]);
    });
  }

  function check() {
    if (!assembly) return;
    void run(async (monitor, signal) => {
      setFeedback("");
      if (!requireUnpowered()) return;
      setFeedback("Checking connection…");
      const { from, to } = assembly;
      let feedback = "Electrical connection detected.";

      if (step === 0) {
        const reply = await monitor.scanConnections();
        signal.throwIfAborted();
        if (reply?.status !== "complete") {
          throw new Error(
            reply?.status === "error" ? reply.message : "The scan did not return a result.",
          );
        }
        const group = reply.result.groups.find((nodes) => nodes.includes(from));
        if (reply.result.status === "ambiguous" || !group?.includes(to) || group.length > 2) {
          const unexpected = group?.filter((node) => node !== from && node !== to) ?? [];
          setFeedback(
            reply.result.status === "ambiguous"
              ? "Scan inconclusive. Check the wiring and try again."
              : unexpected.length
                ? `Unexpected connection to channel ${unexpected.join(", ")}. Move the jumper wire to channel ${to}.`
                : `No connection detected between channels ${from} and ${to}.`,
          );
          return;
        }
        feedback = "Jumper wire connection detected.";
      } else {
        const forward = await monitor.probeNodes(from, to);
        signal.throwIfAborted();
        if (!requireUnpowered()) {
          setFeedback("");
          return;
        }
        const reverse = await monitor.probeNodes(to, from);
        signal.throwIfAborted();
        if (forward < CONNECTION_MIN_VOLTS || reverse < CONNECTION_MIN_VOLTS) {
          setFeedback(
            "Connection not confirmed in both directions. Check the two blue rows and try again.",
          );
          return;
        }
      }

      const next = ASSEMBLY_STEPS[step + 1];
      const targets = next ? [next.from, next.to] : [ROWS.ground];
      setFeedback(feedback);
      await sweepSuccess(monitor, signal, targets);
      setStep(step + 1);
    });
  }

  function confirmGround() {
    void run(async (monitor, signal) => {
      setFeedback("");
      if (!requireUnpowered()) return;
      await sweepSuccess(monitor, signal, [ROWS.input]);
      setPowerSince(Date.now());
      setStep(POWER_STEP);
    });
  }

  const completePoweredStep = useEffectEvent(() => {
    void run(async (monitor, signal) => {
      setCompleted(true);
      setFeedback("The input, midpoint, and ground readings match the expected divider.");
      await sweepSuccess(monitor, signal, []);
    });
  });

  useEffect(() => {
    if (busy || completed || step !== POWER_STEP || !reading || reading.receivedAt <= powerSince)
      return;
    const result = checkPoweredDivider(reading.voltages);
    if (!result.valid || Date.now() - reading.receivedAt > MAX_READING_AGE_MS) return;
    const scheduled = setTimeout(() => completePoweredStep(), 0);
    return () => clearTimeout(scheduled);
  }, [busy, completed, powerSince, reading, step]);

  function exit() {
    void run(async (monitor, signal) => {
      await setLights(monitor, signal, [{ type: "clear_leds" }]);
      setStep(-1);
      setFeedback("");
      setRestartBlocked(false);
      onActiveChange(false);
    });
  }

  return (
    <section className="guided-demo" aria-labelledby="demo-title">
      <h2 id="demo-title">Guided Demo</h2>
      {showVoltageWarning && (
        <p className="error" role="alert">
          Channel {highChannel} reads {reading?.voltages[highChannel].toFixed(3)} V. Active checks
          require all monitored nodes to read at or below {PASSIVE_LIMIT.toFixed(1)} V. Check
          whether the + rail is connected to a monitored row.
        </p>
      )}
      {step < 0 ? (
        <>
          <p>
            Build a voltage divider with a jumper wire and two matching resistors. Disconnect the
            external supply before starting.
          </p>
          <button disabled={!available || busy} onClick={start}>
            Start Demo
          </button>
        </>
      ) : (
        <>
          <p className="note">
            Step {step + 1} of {POWER_STEP + 1}
          </p>
          <progress
            aria-label="Demo progress"
            max={POWER_STEP + 1}
            value={completed ? POWER_STEP + 1 : step}
          />
          <div className="demo-instruction">
            <h3>
              {completed
                ? "Divider complete"
                : (assembly?.title ??
                  (step === GROUND_STEP ? "Connect the − rail" : "Connect the + rail"))}
            </h3>
            {assembly ? (
              <p>
                Connect {assembly.component} between the{" "}
                <strong className="demo-blue-rows">two rows lit by blue LEDs</strong> (channels{" "}
                {assembly.from} and {assembly.to}). Keep the external supply disconnected.
              </p>
            ) : step === GROUND_STEP ? (
              <p>
                Connect the row marked by the blue LED (channel {ROWS.ground}) to the{" "}
                <strong className="demo-negative-rail">− rail (GND)</strong>. Leave the{" "}
                <strong className="demo-positive-rail">+ rail</strong> disconnected from the divider
                for now.
              </p>
            ) : (
              !completed && (
                <p>
                  Connect the row marked by the blue LED (channel {ROWS.input}) to the{" "}
                  <strong className="demo-positive-rail">+ rail (5 V)</strong>. The app checks the
                  divider voltage automatically.
                </p>
              )
            )}
          </div>
          {!completed && powered && !powered.valid && (
            <p>
              {powered.input < INPUT_MIN
                ? "Waiting for 5 V input."
                : "Outside the expected range. Check the wiring."}
            </p>
          )}
          {step === POWER_STEP && (
            <p>Disconnect the external supply before restarting or running an active check.</p>
          )}
          <div className="controls">
            {assembly && (
              <button
                className="demo-continue"
                disabled={busy || !available || highChannel >= 0}
                onClick={check}
              >
                Check Connection &amp; Continue
              </button>
            )}
            {step === GROUND_STEP && (
              <button disabled={busy || !available || highChannel >= 0} onClick={confirmGround}>
                Confirm − Rail Connected
              </button>
            )}
            <button disabled={busy || !available} onClick={start}>
              Restart Demo
            </button>
            <button className="demo-exit" disabled={busy || !available} onClick={exit}>
              Exit Demo
            </button>
          </div>
          <dl className="demo-voltages">
            <div>
              <dt>Source voltage (channel {ROWS.input})</dt>
              <dd>{reading ? `${reading.voltages[ROWS.input].toFixed(2)} V` : "—"}</dd>
            </div>
            <div>
              <dt>Divided voltage (channel {ROWS.midpoint})</dt>
              <dd>{reading ? `${reading.voltages[ROWS.midpoint].toFixed(2)} V` : "—"}</dd>
            </div>
          </dl>
        </>
      )}
      {feedback && <p role="status">{feedback}</p>}
    </section>
  );
}
