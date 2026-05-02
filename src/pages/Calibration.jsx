import { useEffect, useRef, useState } from 'react'
import { useHandTracking } from '../hooks/useHandTracking.js'
import { isPinching, getHandPosition } from '../lib/gestures.js'

export default function Calibration({ roomCode, onEnter, onCancel }) {
  const videoRef = useRef(null)
  const overlayRef = useRef(null)
  // Camera is OFF until the user explicitly clicks Enable Camera. Browsers
  // require a user gesture for the permission prompt anyway, and this lets
  // us surface clear messaging instead of a silent failure.
  const [enabled, setEnabled] = useState(false)
  const [debug, setDebug] = useState({
    handDetected: false,
    pinching: false,
    x: 0,
    y: 0,
    speed: 0,
  })

  const lastPos = useRef({ x: 0.5, y: 0.5, t: performance.now() })
  const speedSmooth = useRef(0)

  const onResults = (results) => {
    const lms = results.multiHandLandmarks || []
    if (lms.length === 0) {
      setDebug((d) => ({ ...d, handDetected: false, pinching: false, speed: 0 }))
      return
    }
    const lm = lms[0]
    const pos = getHandPosition(lm)
    const now = performance.now()
    const dt = Math.max(0.001, (now - lastPos.current.t) / 1000)
    const dist = Math.hypot(pos.x - lastPos.current.x, pos.y - lastPos.current.y)
    const speed = dist / dt
    speedSmooth.current = speedSmooth.current * 0.7 + speed * 0.3
    lastPos.current = { x: pos.x, y: pos.y, t: now }

    setDebug({
      handDetected: true,
      pinching: isPinching(lm, 0.45),
      x: pos.x,
      y: pos.y,
      speed: speedSmooth.current,
    })
  }

  const { status, error, info } = useHandTracking({
    videoRef, overlayRef, enabled, onResults, maxNumHands: 1,
  })

  useEffect(() => {
    const video = videoRef.current
    const overlay = overlayRef.current
    if (!video || !overlay) return
    const sync = () => {
      overlay.width = video.videoWidth || 640
      overlay.height = video.videoHeight || 480
    }
    video.addEventListener('loadedmetadata', sync)
    sync()
    return () => video.removeEventListener('loadedmetadata', sync)
  }, [status])

  // Read once, on render — values are reactive via window/navigator only
  // through user navigation, so a per-render snapshot is fine here.
  const isSecure = typeof window !== 'undefined' ? !!window.isSecureContext : false
  const hasMD = typeof navigator !== 'undefined'
    && !!navigator.mediaDevices
    && typeof navigator.mediaDevices.getUserMedia === 'function'
  const onLanHttp = typeof window !== 'undefined'
    && window.location.protocol === 'http:'
    && !/^(localhost|127\.|\[?::1)/.test(window.location.hostname)

  const statusText = (() => {
    if (status === 'ready') return 'Camera ready · move your hand · pinch to test'
    if (status === 'requesting') return 'Asking for camera permission…'
    if (status === 'loading') return 'Loading hand-tracking model…'
    if (status === 'error') return `Error: ${error}`
    return enabled ? 'Starting camera…' : 'Camera not started'
  })()

  return (
    <div className="calibration">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <div>
          <h2>Calibration</h2>
          <p className="calibration-tagline">Your hands will shape the sound.</p>
        </div>
        <span style={{ fontSize: '0.85rem', color: 'var(--fg-dim)' }}>{statusText}</span>
      </div>

      {/* Pre-flight warnings — shown before the user clicks Enable. */}
      {!enabled && onLanHttp && (
        <div className="cam-warning">
          <strong>Heads up:</strong> you're on an http:// LAN URL. Most browsers
          block <code>navigator.mediaDevices</code> here, so the camera won't
          start. Open the <strong>https://</strong> URL printed in the dev
          server banner instead (you'll get a one-time "Not secure" warning —
          click Advanced → Proceed). On <em>this</em> machine you can also use
          <code> http://localhost:PORT</code>.
        </div>
      )}
      {!enabled && !hasMD && (
        <div className="cam-warning error">
          <strong>Camera API unavailable in this browser.</strong> {' '}
          {isSecure
            ? 'Try Chrome, Edge, or Firefox.'
            : 'You need a secure context (HTTPS or localhost).'}
        </div>
      )}

      <div className="preview-shell">
        <video ref={videoRef} playsInline muted autoPlay />
        <canvas ref={overlayRef} className="overlay" />

        {/* Big enable-camera button overlay, only when camera is off. */}
        {!enabled && (
          <div className="enable-cam-overlay">
            <button
              className="primary enable-cam-btn"
              onClick={() => setEnabled(true)}
              disabled={!hasMD}
              title={hasMD ? 'Start camera' : 'Camera API unavailable'}
            >
              Enable Camera
            </button>
            <p className="enable-cam-hint">
              You'll be asked to allow camera access. Nothing is recorded or sent.
            </p>
          </div>
        )}

        {enabled && status === 'error' && (
          <div className="enable-cam-overlay">
            <p className="cam-error-msg">{error}</p>
            <button onClick={() => { setEnabled(false); setTimeout(() => setEnabled(true), 50) }}>
              Retry
            </button>
          </div>
        )}

        <div className="debug">
          <div>secure context: {isSecure ? 'yes' : 'no'}</div>
          <div>mediaDevices: {info.mediaDevicesAvailable ? 'available' : 'missing'}</div>
          <div>permission: {info.permissionState}</div>
          <div>camera active: {info.cameraActive ? 'yes' : 'no'}</div>
          <div>stream tracks: {info.trackCount}</div>
          <div>error: {error || '—'}</div>
          <div className="debug-divider" />
          <div>hand detected: {debug.handDetected ? 'yes' : 'no'}</div>
          <div>pinch active: {debug.pinching ? 'yes' : 'no'}</div>
          <div>x: {debug.x.toFixed(2)}, y: {debug.y.toFixed(2)}</div>
          <div>movement speed: {debug.speed.toFixed(3)}</div>
        </div>
      </div>

      <div className="footer">
        <div className="role-pill">room · {roomCode || '----'}</div>
        <div style={{ display: 'flex', gap: '0.6rem' }}>
          <button onClick={onCancel}>Cancel</button>
          <button
            className="primary"
            onClick={onEnter}
            disabled={status !== 'ready'}
            title={status === 'ready' ? '' : 'Enable camera first'}
          >
            Enter Canvas →
          </button>
        </div>
      </div>
    </div>
  )
}
