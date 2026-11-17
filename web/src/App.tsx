import { useEffect, useRef, useState } from 'react'
import { getSerialApi, VoltageMonitor } from './serial'
import type { ConnectionState } from './serial'
import './App.css'

function App() {
  const [state, setState] = useState<ConnectionState>('disconnected')
  const [voltages, setVoltages] = useState<number[] | null>(null)
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null)
  const [error, setError] = useState('')
  const monitor = useRef<VoltageMonitor | null>(null)
  const supported = Boolean(getSerialApi())

  useEffect(() => {
    const serial = getSerialApi()
    if (!serial) return
    let active = true
    const connection = new VoltageMonitor(
      serial,
      (nextState) => { if (active) setState(nextState) },
      (values) => {
        if (!active) return
        setVoltages(values)
        setUpdatedAt(new Date())
      },
      (message) => { if (active) setError(message) },
    )
    monitor.current = connection
    return () => {
      active = false
      monitor.current = null
      void connection.disconnect()
    }
  }, [])

  function connect() {
    setError('')
    setVoltages(null)
    setUpdatedAt(null)
    void monitor.current?.connect()
  }

  return (
    <main>
      <h1>Smart Breadboard</h1>
      <p>Live voltage readings from 16 breadboard nodes.</p>
      <section className="connection" aria-label="Serial connection">
        <div className="controls">
          <button onClick={connect} disabled={!supported || state !== 'disconnected'}>Connect</button>
          <button onClick={() => void monitor.current?.disconnect()} disabled={state !== 'connected'}>Disconnect</button>
        </div>
        <p role="status">Status: {supported ? state : 'Web Serial unavailable'}</p>
        {!supported && <p>Open this page in Chrome or Edge on localhost to use Web Serial.</p>}
        {error && <p className="error" role="alert">{error}</p>}
      </section>
      <p className="updated">
        {updatedAt ? `Last scan: ${updatedAt.toLocaleTimeString()}${state !== 'connected' ? ' (disconnected; readings retained)' : ''}` : 'Waiting for a voltage scan.'}
      </p>
      <table>
        <caption>Node voltages</caption>
        <thead><tr><th scope="col">Channel</th><th scope="col">Voltage</th></tr></thead>
        <tbody>
          {Array.from({ length: 16 }, (_, channel) => (
            <tr key={channel}>
              <th scope="row">{channel}</th>
              <td>{voltages ? `${voltages[channel].toFixed(3)} V` : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="note">Floating nodes can show arbitrary readings.</p>
    </main>
  )
}

export default App
