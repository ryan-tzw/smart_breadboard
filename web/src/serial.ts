// Only the Web Serial surface used by this voltage monitor.
export interface SerialPort {
  readable: ReadableStream<Uint8Array> | null
  writable: WritableStream<Uint8Array> | null
  open(options: { baudRate: number }): Promise<void>
  close(): Promise<void>
}

export interface SerialApi {
  requestPort(): Promise<SerialPort>
}

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'disconnecting'

export function getSerialApi(): SerialApi | undefined {
  return (navigator as Navigator & { serial?: SerialApi }).serial
}

export interface ConnectionResult {
  type: 'connection_scan'
  status: 'complete' | 'ambiguous'
  provisional: true
  thresholds: { low: number; high: number }
  groups: number[][]
  ambiguous_groups: number[][]
  ambiguous_pairs: [number, number, number, number][]
}

export type ScanState =
  | { status: 'idle' }
  | { status: 'scanning'; completedSources: number }
  | { status: 'complete'; result: ConnectionResult }
  | { status: 'error'; message: string }

type DeviceMessage =
  | { type: 'voltage_scan'; voltages: number[] }
  | { type: 'scan_progress'; completed_sources: number; total_sources: number }
  | ConnectionResult
  | { type: 'error'; command: string; code: string; channel?: number; voltage?: number }

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function channel(value: unknown): value is number {
  return finite(value) && Number.isInteger(value) && value >= 0 && value < 16
}

export function parseDeviceMessage(line: string): DeviceMessage {
  const parsed: unknown = JSON.parse(line)
  if (typeof parsed !== 'object' || parsed === null) throw new Error('Expected a device message.')
  const message = parsed as Record<string, unknown>
  switch (message.type) {
    case 'voltage_scan':
      if (!Array.isArray(message.voltages) || message.voltages.length !== 16 ||
          !message.voltages.every(finite)) throw new Error('Expected 16 finite voltages.')
      break
    case 'scan_progress':
      if (message.total_sources !== 16 || !finite(message.completed_sources) ||
          !Number.isInteger(message.completed_sources) || message.completed_sources < 0 ||
          message.completed_sources > 16) throw new Error('Invalid connectivity scan progress.')
      break
    case 'connection_scan': {
      const thresholds = message.thresholds as Record<string, unknown> | null
      if ((message.status !== 'complete' && message.status !== 'ambiguous') || message.provisional !== true ||
          typeof thresholds !== 'object' || thresholds === null || !finite(thresholds.low) ||
          !finite(thresholds.high) || thresholds.low < 0 || thresholds.high <= thresholds.low ||
          !Array.isArray(message.groups) || !Array.isArray(message.ambiguous_groups) ||
          !Array.isArray(message.ambiguous_pairs) || message.ambiguous_pairs.length > 120) {
        throw new Error('Invalid connectivity scan result.')
      }
      const seen = new Set<number>()
      for (const group of [...message.groups, ...message.ambiguous_groups]) {
        if (!Array.isArray(group) || group.length === 0 || group.length > 16) throw new Error('Invalid node group.')
        for (const node of group) {
          if (!channel(node) || seen.has(node)) throw new Error('Invalid or repeated channel in scan result.')
          seen.add(node)
        }
      }
      if (seen.size !== 16) throw new Error('Scan result must account for all 16 channels.')
      const pairs = new Set<string>()
      for (const pair of message.ambiguous_pairs) {
        if (!Array.isArray(pair) || pair.length !== 4 || !channel(pair[0]) || !channel(pair[1]) ||
            pair[0] >= pair[1] || !finite(pair[2]) || !finite(pair[3])) throw new Error('Invalid ambiguous pair.')
        const key = `${pair[0]}:${pair[1]}`
        if (pairs.has(key)) throw new Error('Repeated ambiguous pair.')
        pairs.add(key)
      }
      const ambiguous = message.ambiguous_groups.length > 0 || message.ambiguous_pairs.length > 0
      if ((message.status === 'ambiguous') !== ambiguous) throw new Error('Inconsistent scan status.')
      break
    }
    case 'error':
      if (typeof message.command !== 'string' || typeof message.code !== 'string' ||
          (message.channel !== undefined && !channel(message.channel)) ||
          (message.voltage !== undefined && !finite(message.voltage))) throw new Error('Invalid device error.')
      break
    default:
      throw new Error('Unrecognized device message type.')
  }
  return message as DeviceMessage
}

export function parseVoltageScan(line: string): number[] {
  const message = parseDeviceMessage(line)
  if (message.type !== 'voltage_scan') throw new Error('Expected a voltage_scan message.')
  return message.voltages
}

export class VoltageMonitor {
  private state: ConnectionState = 'disconnected'
  private port: SerialPort | undefined
  private writer: WritableStreamDefaultWriter<Uint8Array> | undefined
  private scanPending = false
  private scanTimer: ReturnType<typeof setTimeout> | undefined
  private readonly onConnectionScan: (state: ScanState) => void
  private stopping = false
  private reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  private opening: Promise<void> | undefined
  private reading: Promise<void> | undefined
  private readonly serial: SerialApi
  private readonly onState: (state: ConnectionState) => void
  private readonly onScan: (voltages: number[]) => void
  private readonly onError: (message: string) => void

  constructor(
    serial: SerialApi,
    onState: (state: ConnectionState) => void,
    onScan: (voltages: number[]) => void,
    onError: (message: string) => void,
    onConnectionScan: (state: ScanState) => void = () => {},
  ) {
    this.serial = serial
    this.onState = onState
    this.onScan = onScan
    this.onError = onError
    this.onConnectionScan = onConnectionScan
  }

  private setState(state: ConnectionState) {
    this.state = state
    this.onState(state)
  }

  async connect() {
    if (this.state !== 'disconnected') return
    this.stopping = false
    this.setState('connecting')
    this.opening = this.open()
    await this.opening
  }

  private async open() {
    let port: SerialPort | undefined
    let opened = false
    try {
      port = await this.serial.requestPort()
      if (this.stopping) return
      await port.open({ baudRate: 115200 })
      opened = true
      if (this.stopping) return
      if (!port.readable) throw new Error('The selected port has no readable stream.')
      this.reader = port.readable.getReader()
      this.port = port
      this.setState('connected')
      this.reading = this.read(port, this.reader)
      // The read loop now owns closing the port.
      opened = false
    } catch (error) {
      if (!this.stopping && !(error instanceof DOMException && error.name === 'NotFoundError')) {
        this.onError(`Could not connect: ${String(error)}`)
      }
    } finally {
      if (opened && port) await this.closePort(port)
      if (!this.reader) this.setState('disconnected')
    }
  }

  private async closePort(port: SerialPort) {
    this.port = undefined
    if (this.scanPending) this.updateScan({ status: 'error', message: 'Connection closed before the scan completed.' })
    const writer = this.writer
    if (writer) {
      try { await writer.abort() } catch { /* The device may already be gone. */ }
      if (this.writer === writer) {
        writer.releaseLock()
        this.writer = undefined
      }
    }
    try {
      await port.close()
    } catch (error) {
      this.onError(`Could not close serial port: ${String(error)}`)
    }
  }

  private async read(port: SerialPort, reader: ReadableStreamDefaultReader<Uint8Array>) {
    const decoder = new TextDecoder()
    let pending = ''
    let droppingLine = false
    try {
      while (!this.stopping) {
        const { value, done } = await reader.read()
        if (done) {
          if (!this.stopping) this.onError('Serial stream ended. Reconnect to resume readings.')
          break
        }
        pending += decoder.decode(value, { stream: true })
        let newline: number
        while ((newline = pending.indexOf('\n')) !== -1) {
          const line = pending.slice(0, newline).trim()
          pending = pending.slice(newline + 1)
          if (droppingLine) {
            droppingLine = false
            continue
          }
          if (!line) continue
          if (line.length > 4096) {
            this.onError('Ignored an oversized serial message.')
            continue
          }
          try {
            const message = parseDeviceMessage(line)
            if (message.type === 'voltage_scan') {
              this.onScan(message.voltages)
            } else if (message.type === 'scan_progress') {
              this.updateScan({ status: 'scanning', completedSources: message.completed_sources })
            } else if (message.type === 'connection_scan') {
              this.updateScan({ status: 'complete', result: message })
            } else {
              let detail = `Device error: ${message.code}.`
              if (message.code === 'unexpected_voltage') {
                detail = message.channel !== undefined && message.voltage !== undefined
                  ? `Scan refused: channel ${message.channel} measured ${message.voltage.toFixed(3)} V. Disconnect external circuit power before scanning.`
                  : 'Scan refused: unexpected voltage detected.'
              } else if (message.code === 'probe_timeout') {
                detail = 'Scan stopped: the firmware injection cutoff was reached.'
              } else if (message.code === 'timer_unavailable') {
                detail = 'Scan refused: the firmware could not arm the injection cutoff.'
              }
              if (this.scanPending && (message.command === 'scan_connections' || message.command === 'unknown')) {
                this.updateScan({ status: 'error', message: detail })
              } else {
                this.onError(detail)
              }
            }
          } catch (error) {
            this.onError(`Ignored invalid serial message: ${String(error)}`)
          }
        }
        // Bound memory if the device sends data without a newline.
        if (pending.length > 4096) {
          pending = ''
          droppingLine = true
          this.onError('Ignored an oversized serial message.')
        }
      }
    } catch (error) {
      if (!this.stopping) this.onError(`Serial read failed: ${String(error)}`)
    } finally {
      reader.releaseLock()
      this.reader = undefined
      await this.closePort(port)
      this.setState('disconnected')
    }
  }

  private updateScan(state: ScanState) {
    clearTimeout(this.scanTimer)
    this.scanPending = state.status === 'scanning'
    if (this.scanPending) {
      this.scanTimer = setTimeout(() => {
        this.updateScan({ status: 'error', message: 'Scan timed out. Reconnect before retrying.' })
        void this.disconnect()
      }, 10000)
    }
    this.onConnectionScan(state)
  }

  async scanConnections() {
    if (this.state !== 'connected' || this.stopping || !this.port?.writable) {
      this.onError('Connect to a writable serial port before scanning.')
      return
    }
    if (this.scanPending || this.writer) return
    this.updateScan({ status: 'scanning', completedSources: 0 })
    let writer: WritableStreamDefaultWriter<Uint8Array> | undefined
    try {
      writer = this.port.writable.getWriter()
      this.writer = writer
      await writer.write(new TextEncoder().encode('{"type":"scan_connections"}\n'))
    } catch (error) {
      if (!this.stopping) {
        this.updateScan({ status: 'error', message: `Could not send scan command: ${String(error)}` })
        // A failed write may have been partially delivered; reconnect before retrying.
        void this.disconnect()
      }
    } finally {
      if (writer && this.writer === writer) {
        writer.releaseLock()
        this.writer = undefined
      }
    }
  }

  async disconnect() {
    this.stopping = true
    if (this.state === 'disconnected') return
    this.setState('disconnecting')
    // Also handles unmounting while the chooser or port opening is pending.
    await this.opening
    try {
      await this.reader?.cancel()
    } catch (error) {
      this.onError(`Could not cancel serial reader: ${String(error)}`)
    }
    await this.reading
  }
}
