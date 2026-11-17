import { useEffect, useRef, useState } from 'react'
import { getSerialApi, VoltageMonitor } from './serial'
import type { ConnectionState, ScanState } from './serial'
import './App.css'

function App() {
  const [state, setState] = useState<ConnectionState>('disconnected')
  const [voltages, setVoltages] = useState<number[] | null>(null)
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null)
  const [error, setError] = useState('')
  const [scan, setScan] = useState<ScanState>({ status: 'idle' })
  const scanning = scan.status === 'scanning'
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
      (nextScan) => { if (active) setScan(nextScan) },
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
    setScan({ status: 'idle' })
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
          <button onClick={() => void monitor.current?.disconnect()} disabled={state !== 'connected' || scanning}>Disconnect</button>
        </div>
        <p role="status">Status: {supported ? state : 'Web Serial unavailable'}</p>
        {!supported && <p>Open this page in Chrome or Edge on localhost to use Web Serial.</p>}
        {error && <p className="error" role="alert">{error}</p>}
      </section>
      <section className="connectivity" aria-labelledby="connectivity-title" aria-busy={scanning}>
        <h2 id="connectivity-title">Connectivity</h2>
        <p className="note">Scan only known, externally unpowered circuits. Results are provisional connectivity indications.</p>
        <button
          disabled={state !== 'connected' || scanning}
          onClick={() => {
            setError('')
            void monitor.current?.scanConnections()
          }}
        >Scan Connections</button>
        {scan.status === 'idle' && <p role="status">No connectivity scan yet.</p>}
        {scan.status === 'scanning' && <>
          <p role="status">Scanning: {scan.completedSources} / 16 sources measured.</p>
          <progress max={16} value={scan.completedSources} aria-label="Connectivity scan progress" />
        </>}
        {scan.status === 'error' && <p className="error" role="alert">{scan.message}</p>}
        {scan.status === 'complete' && <>
          <p role="status">
            {scan.result.status === 'ambiguous' ? 'Scan completed with ambiguous results.' : 'Scan completed.'}
            {state !== 'connected' && ' Disconnected; showing the last result.'}
          </p>
          <h3>Detected groups</h3>
          {scan.result.groups.length === 0 ? <p>No groups could be confirmed.</p> : <ul>
            {scan.result.groups.map((group) => <li key={group.join('-')}>
              {group.length === 1 ? `Channel ${group[0]}: no connection detected` : `Channels ${group.join(', ')}`}
            </li>)}
          </ul>}
          {scan.result.ambiguous_groups.length > 0 && <>
            <h3>Uncertain groups</h3>
            <p>These candidate groups have uncertain or conflicting measurements.</p>
            <ul>{scan.result.ambiguous_groups.map((group) => <li key={group.join('-')}>Channels {group.join(', ')}</li>)}</ul>
          </>}
          {scan.result.ambiguous_pairs.length > 0 && <div className="pair-results">
            <table>
              <caption>Ambiguous pairs</caption>
              <thead><tr><th scope="col">Channels A / B</th><th scope="col">A → B</th><th scope="col">B → A</th></tr></thead>
              <tbody>{scan.result.ambiguous_pairs.map(([a, b, forward, reverse]) => <tr key={`${a}-${b}`}>
                <th scope="row">{a} / {b}</th><td>{forward.toFixed(3)} V</td><td>{reverse.toFixed(3)} V</td>
              </tr>)}</tbody>
            </table>
          </div>}
          <p className="note">Detection requires at least {scan.result.thresholds.high.toFixed(3)} V in both directions. Readings at or below {scan.result.thresholds.low.toFixed(3)} V indicate no detected connection.</p>
        </>}
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
