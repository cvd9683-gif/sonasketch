import { useEffect, useRef, useState } from 'react'

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
export function useHandTracking({ videoRef, overlayRef, enabled, onResults, maxNumHands = 1 }) {
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
        const handsMod = await import('@mediapipe/hands')
        Hands = handsMod.Hands
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
        drawOverlay(overlayRef.current, results)
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

function drawOverlay(canvas, results) {
  if (!canvas) return
  const ctx = canvas.getContext('2d')
  const w = canvas.width
  const h = canvas.height
  ctx.clearRect(0, 0, w, h)
  if (!results.multiHandLandmarks) return

  for (const landmarks of results.multiHandLandmarks) {
    ctx.lineWidth = 2
    ctx.strokeStyle = 'rgba(126, 226, 255, 0.85)'
    ctx.beginPath()
    for (const [a, b] of HAND_CONNECTIONS) {
      const pa = landmarks[a]
      const pb = landmarks[b]
      ctx.moveTo(pa.x * w, pa.y * h)
      ctx.lineTo(pb.x * w, pb.y * h)
    }
    ctx.stroke()

    ctx.fillStyle = 'rgba(201, 123, 255, 0.95)'
    for (const lm of landmarks) {
      ctx.beginPath()
      ctx.arc(lm.x * w, lm.y * h, 3.5, 0, Math.PI * 2)
      ctx.fill()
    }
  }
}
