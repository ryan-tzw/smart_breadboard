import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { parseVoltageScan, VoltageMonitor } from '../src/serial.ts'
import type { ConnectionState, SerialPort } from '../src/serial.ts'

const voltages = Array.from({ length: 16 }, (_, channel) => channel / 3)
const scan = JSON.stringify({ type: 'voltage_scan', voltages })
const encoder = new TextEncoder()

function setup() {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  let closed = 0
  let cancelled = 0
  const stream = new ReadableStream<Uint8Array>({
    start(value) { controller = value },
    cancel() { cancelled++ },
  })
  const port: SerialPort = {
    readable: stream,
    async open(options) { assert.equal(options.baudRate, 115200) },
    async close() {
      assert.equal(stream.locked, false)
      closed++
    },
  }
  const states: ConnectionState[] = []
  const readings: number[][] = []
  const errors: string[] = []
  const monitor = new VoltageMonitor(
    { async requestPort() { return port } },
    (state) => states.push(state),
    (values) => readings.push(values),
    (error) => errors.push(error),
  )
  return { monitor, controller, states, readings, errors, get closed() { return closed }, get cancelled() { return cancelled } }
}

test('validates message type, array length and finite numeric values', () => {
  assert.deepEqual(parseVoltageScan(scan), voltages)
  for (const invalid of ['no JSON', 'null', '{}',
    JSON.stringify({ type: 'other', voltages }),
    JSON.stringify({ type: 'voltage_scan', voltages: voltages.slice(1) }),
    JSON.stringify({ type: 'voltage_scan', voltages: [...voltages, 1] }),
    JSON.stringify({ type: 'voltage_scan', voltages: [...voltages.slice(1), '3'] }),
    JSON.stringify({ type: 'voltage_scan', voltages: [...voltages.slice(1), null] }),
    `{"type":"voltage_scan","voltages":[${Array(16).fill('1e999').join(',')}]}`,
  ]) assert.throws(() => parseVoltageScan(invalid))
})

test('buffers fragments, handles CRLF and multiple lines, recovers after malformed JSON', async () => {
  const context = setup()
  await context.monitor.connect()
  context.controller.enqueue(encoder.encode(scan.slice(0, 25)))
  await setImmediate()
  assert.equal(context.readings.length, 0)
  context.controller.enqueue(encoder.encode(`${scan.slice(25)}\r\ninvalid\n\n${scan}\n`))
  await setImmediate()
  assert.deepEqual(context.readings, [voltages, voltages])
  assert.equal(context.errors.length, 1)
  await context.monitor.disconnect()
  assert.equal(context.cancelled, 1)
  assert.equal(context.closed, 1)
  assert.equal(context.states.at(-1), 'disconnected')
})

test('drops oversized lines and resumes on the following line', async () => {
  const context = setup()
  await context.monitor.connect()
  context.controller.enqueue(encoder.encode('x'.repeat(5000)))
  await setImmediate()
  context.controller.enqueue(encoder.encode(`${scan}\n${scan}\n`))
  await setImmediate()
  assert.deepEqual(context.readings, [voltages])
  assert.equal(context.errors.length, 1)
  await context.monitor.disconnect()
})

test('read failure releases the stream and closes the port', async () => {
  const context = setup()
  await context.monitor.connect()
  context.controller.error(new Error('Device removed'))
  await setImmediate()
  assert.match(context.errors[0], /Device removed/)
  assert.equal(context.closed, 1)
  assert.equal(context.states.at(-1), 'disconnected')
})

test('stream ending reports disconnection and drops an incomplete scan', async () => {
  const context = setup()
  await context.monitor.connect()
  context.controller.enqueue(encoder.encode(scan.slice(0, 30)))
  context.controller.close()
  await setImmediate()
  assert.equal(context.readings.length, 0)
  assert.match(context.errors[0], /stream ended/)
  assert.equal(context.closed, 1)
  assert.equal(context.states.at(-1), 'disconnected')
})

test('chooser cancellation is quiet and an open failure is reported', async () => {
  const errors: string[] = []
  const states: ConnectionState[] = []
  const monitor = new VoltageMonitor({
    async requestPort() { throw new DOMException('Cancelled', 'NotFoundError') },
  }, (state) => states.push(state), () => {}, (error) => errors.push(error))
  await monitor.connect()
  assert.deepEqual(errors, [])
  assert.equal(states.at(-1), 'disconnected')
  const failing = new VoltageMonitor({
    async requestPort() {
      return { readable: null, async open() { throw new Error('Port busy') }, async close() {} }
    },
  }, () => {}, () => {}, (error) => errors.push(error))
  await failing.connect()
  assert.match(errors[0], /Port busy/)
})

test('disconnect during opening closes the port without starting a reader', async () => {
  let finishOpen!: () => void
  let closed = 0
  const states: ConnectionState[] = []
  const monitor = new VoltageMonitor({
    async requestPort() {
      return {
        readable: null,
        open() { return new Promise<void>((resolve) => { finishOpen = resolve }) },
        async close() { closed++ },
      }
    },
  }, (state) => states.push(state), () => assert.fail('Unexpected scan'), () => assert.fail('Unexpected error'))
  const connecting = monitor.connect()
  await setImmediate()
  const disconnecting = monitor.disconnect()
  finishOpen()
  await Promise.all([connecting, disconnecting])
  assert.equal(closed, 1)
  assert.equal(states.at(-1), 'disconnected')
})
