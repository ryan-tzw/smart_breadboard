// Only the Web Serial surface used by this voltage monitor.
export interface SerialPort {
  readable: ReadableStream<Uint8Array> | null
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

export function parseVoltageScan(line: string): number[] {
  const message: unknown = JSON.parse(line)
  if (typeof message !== 'object' || message === null ||
      !('type' in message) || message.type !== 'voltage_scan' ||
      !('voltages' in message) || !Array.isArray(message.voltages) ||
      message.voltages.length !== 16 ||
      !message.voltages.every((value: unknown) => typeof value === 'number' && Number.isFinite(value))) {
    throw new Error('Expected a voltage_scan message with 16 finite voltages.')
  }
  return message.voltages
}

export class VoltageMonitor {
  private state: ConnectionState = 'disconnected'
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
  ) {
    this.serial = serial
    this.onState = onState
    this.onScan = onScan
    this.onError = onError
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
            this.onScan(parseVoltageScan(line))
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
