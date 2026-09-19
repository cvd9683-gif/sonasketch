import { useEffect, useRef, useState } from 'react'

// Load @mediapipe/hands via a <script> tag from CDN instead of an ES import.
// The npm package is UMD with eval-ish patterns that Vite mangles in
// production builds, causing the dynamic import to hang. Loading the
// official CDN bundle as a global script avoids the bundler entirely;
// `locateFile` then points the WASM/model fetches at the same CDN.
let handsScriptPromise = null
function loadHandsScript() {
  if (typeof window === 'undefined') return Promise.reject(new Error('no window'))
  if (window.Hands) return Promise.resolve(window.Hands)
  if (handsScriptPromise) return handsScriptPromise
  handsScriptPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script')
    s.src = 'https://cdn.jsdelivr.net/npm/@mediapipe/hands/hands.js'
    s.crossOrigin = 'anonymous'
    s.onload = () => {
      if (window.Hands) resolve(window.Hands)
      else reject(new Error('hands.js loaded but window.Hands missing'))
    }
    s.onerror = () => reject(new Error('failed to fetch hands.js from CDN'))
    document.head.appendChild(s)
  })
  return handsScriptPromise
}

const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
]

// Why we own getUserMedia instead of MediaPipe's Camera helper:
//   - MediaPipe's Camera.start() calls navigator.mediaDevices.getUserMedia
//     unconditionally. On http://192.168.x.x (non-secure context) browsers
//     don't expose mediaDevices at all, so MediaPipe crashes deep in its
//     wrapper with "Cannot read properties of undefined (reading
//     'getUserMedia')". Owning the call lets us preflight, fail loudly with
//     an actionable message, and report tracks/permission state to the UI.
//   - It also lets us reliably stop every track on unmount so the camera
//     light goes off (the helper sometimes leaks the underlying stream).
export function useHandTracking({ videoRef, overlayRef, enabled, onResults, maxNumHands = 1, debugOverlay = true }) {
  const handsRef = useRef(null)
  const streamRef = useRef(null)
  const rafRef = useRef(0)
  const onResultsRef = useRef(onResults)
  const [status, setStatus] = useState('idle') // idle | requesting | loading | ready | error
  const [error, setError] = useState(null)
  const [info, setInfo] = useState({
    secureContext: typeof window !== 'undefined' ? !!window.isSecureContext : false,
    mediaDevicesAvailable:
      typeof navigator !== 'undefined' &&
      !!navigator.mediaDevices &&
      typeof navigator.mediaDevices.getUserMedia === 'function',
    permissionState: 'unknown',
    cameraActive: false,
    trackCount: 0,
  })

  useEffect(() => { onResultsRef.current = onResults }, [onResults])
  const debugOverlayRef = useRef(debugOverlay)
  useEffect(() => { debugOverlayRef.current = debugOverlay }, [debugOverlay])

  useEffect(() => {
    if (!enabled) return
    if (!videoRef.current) return

    let cancelled = false

    const fail = (msg) => {
      if (cancelled) return
      console.error('[useHandTracking]', msg)
      setError(msg)
      setStatus('error')
    }

    ;(async () => {
      // ---------- Preflight: secure context + mediaDevices ----------
      const secure = !!window.isSecureContext
      const hasMD = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)
      setInfo((i) => ({ ...i, secureContext: secure, mediaDevicesAvailable: hasMD }))

      if (!hasMD) {
        const detail = secure
          ? 'navigator.mediaDevices.getUserMedia is not available in this browser.'
          : 'Camera access requires a secure context (HTTPS or localhost). ' +
            'You appear to be on a plain http:// LAN URL — switch to the https:// ' +
            'URL printed in the dev server banner, or open localhost on this machine.'
        fail(detail)
        return
      }

      // Best-effort permission check — not all browsers support querying
      // 'camera', but when they do it's a clean signal.
      try {
        if (navigator.permissions?.query) {
          const perm = await navigator.permissions.query({ name: 'camera' })
          if (!cancelled) setInfo((i) => ({ ...i, permissionState: perm.state }))
          perm.onchange = () => {
            if (!cancelled) setInfo((i) => ({ ...i, permissionState: perm.state }))
          }
        }
      } catch { /* permission name unsupported on this browser */ }

      // ---------- Acquire camera ----------
      setStatus('requesting')
      let stream
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
          audio: false,
        })
      } catch (err) {
        const name = err?.name || 'Error'
        const friendly = ({
          NotAllowedError: 'Permission denied. Click the camera icon in the address bar to allow camera access, then try again.',
          NotFoundError: 'No camera found on this device.',
          NotReadableError: 'Camera is in use by another app. Close that app and retry.',
          OverconstrainedError: 'Requested camera settings not supported.',
          SecurityError: 'Browser blocked camera access (insecure origin?).',
        })[name] || `${name}: ${err?.message || 'failed to start camera'}`
        fail(friendly)
        return
      }
      if (cancelled) {
        stream.getTracks().forEach((t) => t.stop())
        return
      }
      streamRef.current = stream
      setInfo((i) => ({
        ...i,
        cameraActive: true,
        trackCount: stream.getTracks().length,
        permissionState: i.permissionState === 'unknown' ? 'granted' : i.permissionState,
      }))

      // Attach to <video> and wait for metadata so dimensions are known.
      const video = videoRef.current
      if (!video) {
        stream.getTracks().forEach((t) => t.stop())
        return
      }
      video.srcObject = stream
      try { await video.play() } catch { /* autoplay quirks — ignore */ }
      await new Promise((res) => {
        if (video.readyState >= 2) return res()
        video.addEventListener('loadedmetadata', () => res(), { once: true })
      })
      if (cancelled) return

      // ---------- MediaPipe Hands ----------
      setStatus('loading')
      let Hands
      try {
        Hands = await loadHandsScript()
      } catch (err) {
        fail('Could not load hand-tracking model: ' + (err?.message || err))
        return
      }
      if (cancelled) return

      const hands = new Hands({
        locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`,
      })
      // selfieMode: true → MediaPipe pre-flips landmark x to match the
      // mirrored video, so JS never needs (1 - x) anywhere downstream.
      hands.setOptions({
        selfieMode: true,
        maxNumHands,
        modelComplexity: 1,
        minDetectionConfidence: 0.6,
        minTrackingConfidence: 0.5,
      })
      hands.onResults((results) => {
        drawOverlay(overlayRef.current, results, debugOverlayRef.current)
        onResultsRef.current?.(results)
      })
      handsRef.current = hands

      // Manual RAF loop in place of MediaPipe's Camera helper. Skips
      // frames if the previous send is still in flight to avoid backlog.
      let inFlight = false
      const tick = async () => {
        if (cancelled) return
        const v = videoRef.current
        const h = handsRef.current
        if (v && h && v.readyState >= 2 && !inFlight) {
          inFlight = true
          try { await h.send({ image: v }) } catch { /* swallow occasional WASM hiccups */ }
          inFlight = false
        }
        rafRef.current = requestAnimationFrame(tick)
      }
      rafRef.current = requestAnimationFrame(tick)

      if (!cancelled) setStatus('ready')
    })()

    return () => {
      cancelled = true
      cancelAnimationFrame(rafRef.current)
      try { handsRef.current?.close() } catch { /* model already torn down */ }
      const stream = streamRef.current
      if (stream) {
        try { stream.getTracks().forEach((t) => t.stop()) } catch { /* tracks already stopped */ }
      }
      const v = videoRef.current
      if (v) {
        try { v.pause() } catch { /* already paused */ }
        try { v.srcObject = null } catch { /* element gone */ }
      }
      const ov = overlayRef.current
      if (ov) {
        try { ov.getContext('2d').clearRect(0, 0, ov.width, ov.height) } catch { /* canvas detached */ }
      }
      streamRef.current = null
      handsRef.current = null
      setInfo((i) => ({ ...i, cameraActive: false, trackCount: 0 }))
    }
  }, [enabled, videoRef, overlayRef, maxNumHands])

  return { status, error, info }
}

// Pinch thresholds duplicated here for the overlay annotation. Kept in sync
// manually with PINCH_START_PX / PINCH_END_PX in Canvas.jsx — the overlay's
// PINCHED/OPEN label is purely visual proof that detection is right.
const OVERLAY_PINCH_START_PX = 45
const OVERLAY_PINCH_END_PX = 70

// debug=false (canvas page) keeps the skeleton but drops the pixel-distance
// label and the PINCHED/OPEN pill, and uses the app palette for the tips.
function drawOverlay(canvas, results, debug = true) {
  if (!canvas) return
  const ctx = canvas.getContext('2d')
  const w = canvas.width
  const h = canvas.height
  ctx.clearRect(0, 0, w, h)
  if (!results.multiHandLandmarks || results.multiHandLandmarks.length === 0) return

  for (const landmarks of results.multiHandLandmarks) {
    // Skeleton (dim, so the highlighted thumb/index pop)
    ctx.lineWidth = 2
    ctx.strokeStyle = 'rgba(126, 226, 255, 0.55)'
    ctx.beginPath()
    for (const [a, b] of HAND_CONNECTIONS) {
      const pa = landmarks[a]
      const pb = landmarks[b]
      ctx.moveTo(pa.x * w, pa.y * h)
      ctx.lineTo(pb.x * w, pb.y * h)
    }
    ctx.stroke()

    // All other landmarks (small, dim)
    ctx.fillStyle = 'rgba(201, 123, 255, 0.55)'
    for (let i = 0; i < landmarks.length; i++) {
      if (i === 4 || i === 8) continue
      const lm = landmarks[i]
      ctx.beginPath()
      ctx.arc(lm.x * w, lm.y * h, 3, 0, Math.PI * 2)
      ctx.fill()
    }

    // Thumb tip (4) — red. Index tip (8) — cyan. Line between them.
    const thumb = landmarks[4]
    const index = landmarks[8]
    const tx = thumb.x * w, ty = thumb.y * h
    const ix = index.x * w, iy = index.y * h
    const distPx = Math.hypot(tx - ix, ty - iy)
    const isPinched = distPx < OVERLAY_PINCH_START_PX
    const isNear = !isPinched && distPx < OVERLAY_PINCH_END_PX
    const lineColor = isPinched ? '#6dffb1' : (isNear ? '#ffd97e' : '#ff6d8e')

    if (!debug) {
      ctx.strokeStyle = isPinched ? '#ff8ec7' : 'rgba(255, 255, 255, 0.35)'
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.moveTo(tx, ty)
      ctx.lineTo(ix, iy)
      ctx.stroke()
      ctx.fillStyle = isPinched ? '#ff8ec7' : '#c97bff'
      for (const [x, y] of [[tx, ty], [ix, iy]]) {
        ctx.beginPath()
        ctx.arc(x, y, 6, 0, Math.PI * 2)
        ctx.fill()
      }
      continue
    }

    ctx.strokeStyle = lineColor
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.moveTo(tx, ty)
    ctx.lineTo(ix, iy)
    ctx.stroke()

    // Thumb tip — red
    ctx.fillStyle = '#ff6d8e'
    ctx.beginPath()
    ctx.arc(tx, ty, 7, 0, Math.PI * 2)
    ctx.fill()
    ctx.strokeStyle = '#ffffff'
    ctx.lineWidth = 1.5
    ctx.stroke()

    // Index tip — cyan
    ctx.fillStyle = '#7ee2ff'
    ctx.beginPath()
    ctx.arc(ix, iy, 7, 0, Math.PI * 2)
    ctx.fill()
    ctx.strokeStyle = '#ffffff'
    ctx.lineWidth = 1.5
    ctx.stroke()

    // Distance label near the midpoint
    const mx = (tx + ix) / 2
    const my = (ty + iy) / 2
    ctx.font = 'bold 14px ui-monospace, monospace'
    const distText = `${Math.round(distPx)}px`
    const tw = ctx.measureText(distText).width
    ctx.fillStyle = 'rgba(0,0,0,0.7)'
    ctx.fillRect(mx - tw / 2 - 4, my - 18, tw + 8, 16)
    ctx.fillStyle = '#ffffff'
    ctx.fillText(distText, mx - tw / 2, my - 6)

    // Big PINCHED/OPEN/NEAR pill in the top-left of the overlay
    const label = isPinched ? 'PINCHED' : (isNear ? 'NEAR' : 'OPEN')
    ctx.font = 'bold 16px system-ui, sans-serif'
    const lw = ctx.measureText(label).width
    ctx.fillStyle = lineColor
    ctx.fillRect(8, 8, lw + 16, 22)
    ctx.fillStyle = '#0b0d14'
    ctx.fillText(label, 16, 24)
  }
}
