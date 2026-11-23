import { CHANNEL_COUNT } from './serial.ts'

export const ROWS = { input: 0, resistorStart: 1, midpoint: 2, ground: 3 }
export const LED_FOR_CHANNEL = Array.from({ length: CHANNEL_COUNT }, (_, channel) => CHANNEL_COUNT - 1 - channel)
const RESISTANCE_KOHM = 1
export const PASSIVE_LIMIT = 0.3
export const CONNECTION_MIN_VOLTS = 2.0 // Match the firmware connectivity threshold.
export const MAX_READING_AGE_MS = 2500
export const DEMO_BRIGHTNESS = 3

export const INPUT_MIN = 4.75
const INPUT_MAX = 5.25
const MIDPOINT_TOLERANCE = 0.15
const ADC_LOAD_KOHM = 47 + 68

export const ASSEMBLY_STEPS = [
  { title: 'Place the jumper wire', component: 'a jumper wire', from: ROWS.input, to: ROWS.resistorStart },
  { title: 'Place the first resistor', component: 'a resistor', from: ROWS.resistorStart, to: ROWS.midpoint },
  { title: 'Place the second resistor', component: 'a resistor', from: ROWS.midpoint, to: ROWS.ground },
]
export const GROUND_STEP = ASSEMBLY_STEPS.length
export const POWER_STEP = GROUND_STEP + 1

export function checkPoweredDivider(voltages: number[]) {
  const input = voltages[ROWS.input]
  const afterJumper = voltages[ROWS.resistorStart]
  const midpoint = voltages[ROWS.midpoint]
  const ground = voltages[ROWS.ground]
  const expected = ground + (input - ground) * ADC_LOAD_KOHM / (2 * ADC_LOAD_KOHM + RESISTANCE_KOHM)
  const valid = input >= INPUT_MIN && input <= INPUT_MAX && ground <= PASSIVE_LIMIT &&
    Math.abs(afterJumper - input) <= MIDPOINT_TOLERANCE &&
    Math.abs(midpoint - expected) <= MIDPOINT_TOLERANCE
  return { input, afterJumper, midpoint, ground, expected, valid }
}
