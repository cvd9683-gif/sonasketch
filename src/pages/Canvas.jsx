import { useEffect, useRef, useState, useCallback, useMemo } from 'react'
import { useHandTracking } from '../hooks/useHandTracking.js'
import { useRoom } from '../hooks/useRoom.js'
import { getPinchRatio, getCursorLandmark } from '../lib/gestures.js'
// Re-imported for Edit mode (single-hand reuse, not a second-hand revival).
import {
  startAudio,
  setMasterMuted,
  playStrokePhrase,
  addDot as addDotAudio,
  clearAllStrokes,
  setOnNotePlay,
  setOnStrokeEvicted,
  getLoopPhase,
  getActiveSoundCount,
  getScheduledEventCount,
  getAudioStatus,
  disposeAudioEngine,
  stopStrokeSound,
  BPM,
  MAX_ACTIVE_STROKES,
  MAX_NOTES_PER_STROKE,
} from '../lib/audio.js'
import {
  createField,
  resizeField,
  setCursor,
  setEditingCursor,
  clearEditingCursor,
  findNearestObject,
  dissolveObject,
  setVisualOnly,
  beginStroke,
  appendActivePoint,
  endStroke,
  pulseStrokeAt,
  addDot as addDotVisual,
  pulseDot,
  setDotPreview,
  clearDotPreview,
  clearStrokes,
  clearInactive,
  setRemoteCursor,
  removeRemoteCursor,
  addRemoteStroke,
  step,
  render,
} from '../lib/visuals.js'
import { createPhraseFromStroke } from '../lib/phrase.js'

// ===== TUNABLE FEEL CONSTANTS =====
// Adjust these to dial the brush feel. Pixel distances are logical (CSS) px;
// they get DPR-scaled where needed before being compared to canvas pixels.

// ----- Cursor (less sensitive) -----
const CURSOR_SMOOTHING = 0.12
const PINCH_DISTANCE_SMOOTHING = 0.2
const MOVEMENT_DEADZONE = 8
const MIN_POINT_DISTANCE = 14
const RELEASE_FREEZE_MS = 150

// ----- Pinch hysteresis -----
// Hand-size-normalized: getPinchRatio = dist(thumb_tip, index_tip) / handScale,
// where handScale = dist(wrist, middle_MCP). Smaller value = fingers closer.
// Idle/pinchCandidate uses START (must dip below to start considering pinch).
// drawing/releaseCandidate uses END (must rise above to consider release).
const PINCH_START_THRESHOLD = 0.075
const PINCH_END_THRESHOLD = 0.11

// ----- State-machine confirmation windows -----
// Pinch must be detected for this many CONSECUTIVE frames before entering
// the drawing state — kills single-frame flicker.
const PINCH_CONFIRM_FRAMES = 4
// Release must hold for this many CONSECUTIVE frames before finalizing —
// prevents premature stroke endings when fingers wobble mid-stroke.
const RELEASE_CONFIRM_FRAMES = 4
// MediaPipe occasionally drops the hand for 1-2 frames. Don't cancel an
// in-progress draw until the hand has been missing this many frames.
const MAX_MISSING_HAND_FRAMES = 6

// ----- Dot vs stroke -----
// While pinching with little movement → dot preview.
// Once max-movement crosses STROKE_MIN_MOVEMENT, latch into stroke mode.
const DOT_MAX_MOVEMENT = 28        // soft hint, used by the debug panel
const STROKE_MIN_MOVEMENT = 32     // operational latch threshold

// ----- Edit mode -----
const EDIT_HOVER_RADIUS = 40

// ----- Network throttling -----
// Cap cursor broadcasts at ~30 Hz so two laptops on Wi-Fi don't saturate
// the channel with per-frame messages.
const CURSOR_SEND_INTERVAL_MS = 33

// ----- Multiplayer-ready scaffolding -----
// Participant shape (used for both local + future remote users):
//   {
//     id: string,
//     name: string,
//     color: string,           // hex assigned at join, used for cursor/strokes/border
//     status: 'drawing' | 'listening' | 'muted' | 'editing' | 'audio off',
//     stream?: MediaStream,    // local only — remote streams will arrive via WebRTC
//     isLocal?: boolean,
//   }
// Sketch shape — see strokeMeta comment in CanvasPage.
const LOCAL_USER_COLORS = ['#7ee2ff', '#c97bff', '#a08eff', '#ff8a5c', '#ff8ec7', '#ffd97e', '#7eff9c']

function makeUserId() {
  return 'local-' + Math.random().toString(36).slice(2, 8)
}

// In-UI mirror of the LAN URL the dev server printed in the terminal —
// useful for forwarding the link without alt-tabbing.
function ShareLinkChip() {
  const isLocal = typeof window !== 'undefined' &&
    /^(localhost|127\.|\[?::1)/.test(window.location.hostname)
  const url = typeof window !== 'undefined' ? window.location.origin : ''
  const handleCopy = () => {
    if (typeof navigator === 'undefined') return
    navigator.clipboard?.writeText(url).catch(() => {})
  }
  return (
    <button
      type="button"
      className="share-chip"
      onClick={handleCopy}
      title={isLocal
        ? 'Open the printed http://192.168.x.x URL on your other laptop'
        : 'Click to copy this link'}
    >
      <span className="share-label">Share</span>
      <span className="share-url">{url || 'connecting…'}</span>
    </button>
  )
}

// ParticipantTile renders the local user with a real video (passed via
// `videoEl` ref-callback so we can srcObject-share the camera stream),
// and renders mock/remote users as a colored gradient placeholder.
// Border + status text use the participant's color so a glance ties
// each tile to that person's drawings.
function ParticipantTile({ name, color, status, isLocal, videoEl }) {
  return (
    <div
      className={`participant-tile${isLocal ? ' is-local' : ''}`}
      style={{ borderColor: color, '--tile-color': color }}
    >
      <div className="tile-camera">
        {isLocal ? (
          <video ref={videoEl} playsInline muted autoPlay />
        ) : (
          <div
            className="tile-placeholder"
            style={{ background: `linear-gradient(135deg, ${color}55, ${color}10)` }}
          />
        )}
      </div>
      <div className="tile-info">
        <span className="tile-name">
          {name}
          {isLocal && <span className="tile-you"> · you</span>}
        </span>
        <span className="tile-status" style={{ color }}>{status}</span>
      </div>
    </div>
  )
}

export default function CanvasPage({ roomCode, displayName = 'Guest', onLeave }) {
  const stageRef = useRef(null)
  const videoRef = useRef(null)
  const tileVideoRef = useRef(null)
  const overlayRef = useRef(null)
  const fieldRef = useRef(null)
  const rafRef = useRef(0)
  const dprRef = useRef(1)

  const [localUser] = useState(() => ({
    id: makeUserId(),
    name: displayName || 'Guest',
    color: LOCAL_USER_COLORS[Math.floor(Math.random() * LOCAL_USER_COLORS.length)],
    isLocal: true,
  }))

  // Sketch metadata — multiplayer-ready records keyed by sketch id.
  // Audio engine and visuals each track their own slice; this Map holds
  // the rich record we'd broadcast over Socket.io.
  // Shape: {
  //   id, userId, userName, userColor,
  //   type: 'dot' | 'stroke',
  //   points: [{x, y}, ...] // normalized 0..1
  //   createdAt: number,    // Date.now()
  //   soundState: 'active' | 'visualOnly' | 'muted',
  //   isLocal: boolean,
  // }
  const strokeMeta = useRef(new Map())

  const cursorState = useRef({
    x: 0, y: 0, initialized: false,
    lastX: 0, lastY: 0, speedNorm: 0,
    lastDelta: 0,
    rawTargetX: 0, rawTargetY: 0,
  })

  // Wall-clock until which cursor smoothing is suppressed (post-release freeze).
  const releaseFreezeUntil = useRef(0)

  // 4-state gesture FSM:
  //   idle              → pinchCandidate (pinch detected this frame)
  //   pinchCandidate    → drawing       (pinch held PINCH_CONFIRM_FRAMES)
  //   pinchCandidate    → idle          (pinch lost before confirmation — never drew)
  //   drawing           → releaseCandidate (pinch lost this frame)
  //   releaseCandidate  → drawing       (pinch returned — keep going)
  //   releaseCandidate  → idle          (release held RELEASE_CONFIRM_FRAMES — finalize)
  // mode is the in-drawing sub-state: 'dot-preview' | 'stroke-preview'.
  const pinchState = useRef({
    state: 'idle',
    pinchFrames: 0,
    releaseFrames: 0,
    missingFrames: 0,
    mode: 'unknown',
    startTime: 0,
    startX: 0,
    startY: 0,
    points: [],
    lastPointX: 0,
    lastPointY: 0,
    maxMovement: 0,
    pinchRatioSmooth: 1,
    strokeBegun: false,
  })

  const lastPhrase = useRef({
    strokePoints: 0,
    direction: '—',
    notes: [],
    phraseLength: 0,
    smoothness: 0,
    lengthCategory: '—',
  })

  // Debug-panel updates are pure visualization — at 60Hz they cause a
  // React re-render every frame. Throttle to ~10Hz so the panel stays
  // useful without being a perf tax during dense drawings.
  const lastDebugAt = useRef(0)
  const DEBUG_INTERVAL_MS = 100

  // Multiplayer wiring. roomApiRef is set when the socket hook is ready;
  // every emit is opportunistic so the canvas works fine offline too.
  const roomApiRef = useRef(null)
  const lastCursorSendAt = useRef(0)
  // Snapshot of peers, keyed by id, so onRemoteCursor can fill in
  // color + name without forcing the cursor handler to be recreated
  // (and re-subscribe the socket) every time someone joins.
  const peersRef = useRef(new Map())

  const [audioOn, setAudioOn] = useState(false)
  const [muted, setMuted] = useState(false)
  const [enabled, setEnabled] = useState(false)
  // 'create' (draw) | 'edit' (hover + pinch-to-delete). Single-hand throughout —
  // the hand's role changes by mode, never by which hand it is.
  const [mode, setMode] = useState('create')
  const modeRef = useRef('create')
  useEffect(() => { modeRef.current = mode }, [mode])
  const [debug, setDebug] = useState({
    handDetected: false,
    pinching: false,
    pinchDistance: 0,
    pinchDuration: 0,
    mode: 'idle',
    movementPx: 0,
    rawX: 0,
    rawY: 0,
    mappedX: 0,
    mappedY: 0,
    canvasW: 0,
    canvasH: 0,
    videoW: 0,
    videoH: 0,
    mirror: 'selfieMode',
    speed: 0,
    cursorDelta: 0,
    activePoints: 0,
    visualStrokes: 0,
    visualDots: 0,
    activeSounds: 0,
    scheduledEvents: 0,
    audioStatus: 'idle',
    strokePoints: 0,
    direction: '—',
    notes: [],
    phraseLength: 0,
    smoothness: 0,
    lengthCategory: '—',
  })

  useEffect(() => { setEnabled(true) }, [])

  // ---------- Stage canvas + animation loop ----------
  useEffect(() => {
    const canvas = stageRef.current
    if (!canvas) return

    const ctx = canvas.getContext('2d')

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      dprRef.current = dpr
      canvas.width = window.innerWidth * dpr
      canvas.height = window.innerHeight * dpr
      canvas.style.width = `${window.innerWidth}px`
      canvas.style.height = `${window.innerHeight}px`
      if (!fieldRef.current) {
        fieldRef.current = createField({ width: canvas.width, height: canvas.height })
      } else {
        resizeField(fieldRef.current, canvas.width, canvas.height)
      }
    }
    resize()
    window.addEventListener('resize', resize)

    let last = performance.now()
    const loop = (now) => {
      const dt = Math.min(0.05, (now - last) / 1000)
      last = now
      const field = fieldRef.current
      if (field) {
        step(field, dt)
        render(ctx, field, { loopPhase: getLoopPhase() })
      }
      rafRef.current = requestAnimationFrame(loop)
    }
    rafRef.current = requestAnimationFrame(loop)

    return () => {
      cancelAnimationFrame(rafRef.current)
      window.removeEventListener('resize', resize)
    }
  }, [])

  // On unmount: tear down the audio engine + Tone transport, and detach
  // the shared MediaStream from the tile video so it can be released.
  // (Camera tracks are stopped inside useHandTracking's cleanup.)
  useEffect(() => {
    return () => {
      try { disposeAudioEngine() } catch {}
      const t = tileVideoRef.current
      if (t) {
        try { t.pause() } catch {}
        try { t.srcObject = null } catch {}
      }
    }
  }, [])

  // C / E keyboard shortcuts for mode toggle. Ignore when typing in inputs.
  useEffect(() => {
    const onKey = (e) => {
      if (e.target?.matches?.('input, textarea')) return
      if (e.key === 'c' || e.key === 'C') setMode('create')
      else if (e.key === 'e' || e.key === 'E') setMode('edit')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // When mode changes, abandon any in-progress draw/hover so the new mode
  // starts with a clean slate.
  useEffect(() => {
    const field = fieldRef.current
    const ps = pinchState.current
    ps.state = 'idle'
    ps.pinchFrames = 0
    ps.releaseFrames = 0
    ps.mode = 'unknown'
    ps.points = []
    ps.maxMovement = 0
    ps.strokeBegun = false
    if (field) {
      field.activeStroke = null
      clearDotPreview(field)
      clearEditingCursor(field)
    }
  }, [mode])

  useEffect(() => {
    setOnNotePlay((id, nx, ny) => {
      const field = fieldRef.current
      if (!field) return
      if (field.dots.has(id)) pulseDot(field, id)
      else pulseStrokeAt(field, id, nx, ny)
    })
    return () => setOnNotePlay(null)
  }, [])

  // When the audio engine evicts a stroke at the cap, keep visual on canvas
  // but transition the meta to soundState='visualOnly' and ask visuals to
  // switch to the cheap render path.
  useEffect(() => {
    setOnStrokeEvicted((id) => {
      const meta = strokeMeta.current.get(id)
      if (meta) meta.soundState = 'visualOnly'
      const field = fieldRef.current
      if (field) setVisualOnly(field, id)
    })
    return () => setOnStrokeEvicted(null)
  }, [])

  // ---------- Multiplayer ----------
  // Handlers read fieldRef.current at call time, so the hook only needs
  // to re-subscribe when the user identity changes. Cursor color/name come
  // from peersRef, which is updated whenever the participants list changes.
  const room = useRoom({
    enabled: enabled && !!roomCode,
    roomCode,
    user: localUser,
    handlers: {
      onRemoteCursor: ({ userId, x, y, pinching, visible }) => {
        const field = fieldRef.current
        if (!field) return
        if (visible === false) { removeRemoteCursor(field, userId); return }
        const peer = peersRef.current.get(userId)
        setRemoteCursor(field, userId, {
          x, y, pinching,
          color: peer?.color || '#ffffff',
          name: peer?.name || '',
        })
      },
      onRemoteStroke: (meta) => {
        const field = fieldRef.current
        if (!field) return
        addRemoteStroke(field, meta)
        strokeMeta.current.set(meta.id, { ...meta, isLocal: false })
      },
      onRemoteRemove: (id) => {
        const field = fieldRef.current
        if (!field) return
        dissolveObject(field, id)
        strokeMeta.current.delete(id)
      },
      onRemoteClear: () => {
        const field = fieldRef.current
        if (field) {
          // Drop only remote sketches; keep local audio/visuals intact.
          for (const [id, m] of strokeMeta.current) {
            if (!m.isLocal) {
              dissolveObject(field, id)
              strokeMeta.current.delete(id)
            }
          }
        }
      },
      onParticipantLeft: (userId) => {
        const field = fieldRef.current
        if (field) removeRemoteCursor(field, userId)
      },
    },
  })

  // Keep peersRef in sync with the latest participants list.
  useEffect(() => {
    const m = new Map()
    for (const p of room.participants) m.set(p.id, p)
    peersRef.current = m
  }, [room.participants])

  // Hand the room senders to the FSM via a ref (so we don't reallocate
  // onResults on every reconnect).
  useEffect(() => {
    roomApiRef.current = {
      sendCursor: room.sendCursor,
      sendStrokeComplete: room.sendStrokeComplete,
      sendStrokeRemove: room.sendStrokeRemove,
      sendStrokesClear: room.sendStrokesClear,
    }
  }, [room.sendCursor, room.sendStrokeComplete, room.sendStrokeRemove, room.sendStrokesClear])

  // ---------- Hand tracking ----------
  // Single-hand mode. The first detected hand is the drawing hand.
  const onResults = useCallback((results) => {
    const lms = results.multiHandLandmarks || []
    const field = fieldRef.current
    if (!field) return
    const ps = pinchState.current
    const c = cursorState.current
    const now = performance.now()

    // Finalize an in-progress draw. Used both on confirmed release and on
    // forced-cancel after the hand has been missing too long.
    const finalizeDraw = () => {
      clearDotPreview(field)
      if (ps.mode === 'stroke-preview' && ps.strokeBegun) {
        const finished = endStroke(field)
        if (finished) {
          const normalizedPoints = finished.pixelPoints.map((p) => ({
            x: p.x / finished.width,
            y: p.y / finished.height,
          }))
          const meta = {
            id: finished.id,
            userId: localUser.id,
            userName: localUser.name,
            userColor: localUser.color,
            type: 'stroke',
            points: normalizedPoints,
            createdAt: Date.now(),
            soundState: 'active',
            isLocal: true,
          }
          strokeMeta.current.set(finished.id, meta)
          roomApiRef.current?.sendStrokeComplete?.(meta)

          const phrase = createPhraseFromStroke(
            finished.pixelPoints, finished.width, finished.height, BPM,
          )
          if (phrase) {
            playStrokePhrase(finished.id, phrase)
            lastPhrase.current = {
              strokePoints: finished.pixelPoints.length,
              direction: phrase.analysis.direction,
              notes: phrase.notes.map((n) => n.note),
              phraseLength: phrase.notes.length,
              smoothness: phrase.analysis.smoothness,
              lengthCategory: phrase.analysis.lengthCategory,
            }
          }
        }
      } else if (ps.mode === 'dot-preview') {
        if (field.activeStroke) field.activeStroke = null
        const dot = addDotVisual(field, ps.startX, ps.startY, localUser.color)
        if (dot) {
          const meta = {
            id: dot.id,
            userId: localUser.id,
            userName: localUser.name,
            userColor: localUser.color,
            type: 'dot',
            points: [{ x: dot.normX, y: dot.normY }],
            createdAt: Date.now(),
            soundState: 'active',
            isLocal: true,
          }
          strokeMeta.current.set(dot.id, meta)
          roomApiRef.current?.sendStrokeComplete?.(meta)
          addDotAudio(dot.id, dot.normX, dot.normY)
        }
      }
      ps.state = 'idle'
      ps.pinchFrames = 0
      ps.releaseFrames = 0
      ps.mode = 'unknown'
      ps.points = []
      ps.maxMovement = 0
      ps.strokeBegun = false
      releaseFreezeUntil.current = now + RELEASE_FREEZE_MS
    }

    // ---------- Missing-hand handling ----------
    if (lms.length === 0) {
      ps.missingFrames++
      // Tolerate brief dropouts so the FSM doesn't lose state from one bad
      // frame. Once the budget is exhausted, treat it as a release.
      if (ps.missingFrames > MAX_MISSING_HAND_FRAMES) {
        if (ps.state === 'drawing' || ps.state === 'releaseCandidate') {
          finalizeDraw()
        } else if (ps.state === 'pinchCandidate') {
          ps.state = 'idle'
          ps.pinchFrames = 0
        }
        setCursor(field, field.cursor.x, field.cursor.y, {
          visible: false, pinching: false, color: localUser.color,
        })
        clearEditingCursor(field)
        roomApiRef.current?.sendCursor?.({ visible: false })
      }
      const tNow = performance.now()
      if (tNow - lastDebugAt.current > DEBUG_INTERVAL_MS) {
        lastDebugAt.current = tNow
        setDebug((d) => ({
          ...d,
          handDetected: false, pinching: false,
          pinchDistance: 0, pinchDuration: 0,
          mode: 'idle', movementPx: 0,
          audioStatus: getAudioStatus(),
          activeSounds: getActiveSoundCount(),
          scheduledEvents: getScheduledEventCount(),
        }))
      }
      return
    }
    ps.missingFrames = 0

    const lm = lms[0]

    // Smooth pinch ratio so single-frame outliers can't toggle state.
    const raw = getPinchRatio(lm)
    ps.pinchRatioSmooth =
      ps.pinchRatioSmooth * (1 - PINCH_DISTANCE_SMOOTHING) +
      raw * PINCH_DISTANCE_SMOOTHING

    // Hysteresis: from idle/pinchCandidate, must dip BELOW start (stricter);
    // from drawing/releaseCandidate, only triggers release when ABOVE end
    // (more permissive). Prevents oscillation around a single threshold.
    const inHeldStates = ps.state === 'drawing' || ps.state === 'releaseCandidate'
    const pinchDetected = inHeldStates
      ? ps.pinchRatioSmooth < PINCH_END_THRESHOLD
      : ps.pinchRatioSmooth < PINCH_START_THRESHOLD

    // Cursor (smoothed, with deadzone, frozen briefly post-release).
    const cursorPos = getCursorLandmark(lm)
    const targetX = cursorPos.x * field.width
    const targetY = cursorPos.y * field.height
    c.rawTargetX = targetX
    c.rawTargetY = targetY
    const cursorFrozen = now < releaseFreezeUntil.current

    if (!c.initialized) {
      c.x = targetX; c.y = targetY; c.initialized = true
      c.lastX = targetX; c.lastY = targetY
    } else if (!cursorFrozen) {
      const dx = targetX - c.x
      const dy = targetY - c.y
      const dpr = dprRef.current
      const distPx = Math.hypot(dx, dy)
      if (distPx > MOVEMENT_DEADZONE * dpr) {
        c.x += dx * CURSOR_SMOOTHING
        c.y += dy * CURSOR_SMOOTHING
      }
    }
    const stepPx = Math.hypot(c.x - c.lastX, c.y - c.lastY)
    c.lastDelta = stepPx / dprRef.current
    c.lastX = c.x; c.lastY = c.y
    c.speedNorm = c.speedNorm * 0.7 + (stepPx / field.width) * 0.3

    const movementThreshold = STROKE_MIN_MOVEMENT * dprRef.current
    const editMode = modeRef.current === 'edit'

    // ---------- FSM ----------
    switch (ps.state) {
      case 'idle': {
        if (pinchDetected) {
          ps.state = 'pinchCandidate'
          ps.pinchFrames = 1
          ps.startTime = now
          ps.startX = c.x
          ps.startY = c.y
        }
        break
      }
      case 'pinchCandidate': {
        if (pinchDetected) {
          ps.pinchFrames++
          if (ps.pinchFrames >= PINCH_CONFIRM_FRAMES) {
            // Confirmed → enter drawing. Mode-specific entry.
            ps.state = 'drawing'
            ps.releaseFrames = 0
            if (editMode) {
              const hovered = findNearestObject(
                field, c.x, c.y, EDIT_HOVER_RADIUS * dprRef.current,
              )
              if (hovered) {
                try { stopStrokeSound(hovered.id) } catch {}
                dissolveObject(field, hovered.id)
                strokeMeta.current.delete(hovered.id)
                roomApiRef.current?.sendStrokeRemove?.(hovered.id)
              }
            } else {
              ps.mode = 'dot-preview'
              ps.points = [{ x: c.x, y: c.y, speed: 0 }]
              ps.lastPointX = c.x
              ps.lastPointY = c.y
              ps.maxMovement = 0
              ps.strokeBegun = false
              // Re-anchor start to the (now-stable) cursor at confirmation,
              // not the noisy first-detection sample.
              ps.startX = c.x
              ps.startY = c.y
              setDotPreview(field, c.x, c.y)
            }
          }
        } else {
          // Cancel — never drew, no points to discard.
          ps.state = 'idle'
          ps.pinchFrames = 0
        }
        break
      }
      case 'drawing': {
        if (!pinchDetected) {
          // Begin release confirmation. Don't add this frame's point —
          // the user spec is "do NOT add points after release".
          ps.state = 'releaseCandidate'
          ps.releaseFrames = 1
        } else if (!editMode) {
          // Continue collecting in create mode. Edit mode just holds.
          const distFromStart = Math.hypot(c.x - ps.startX, c.y - ps.startY)
          ps.maxMovement = Math.max(ps.maxMovement, distFromStart)
          const minStep = MIN_POINT_DISTANCE * dprRef.current
          const dx = c.x - ps.lastPointX
          const dy = c.y - ps.lastPointY
          const farEnough = Math.hypot(dx, dy) >= minStep

          if (ps.maxMovement >= movementThreshold) {
            if (!ps.strokeBegun) {
              ps.mode = 'stroke-preview'
              clearDotPreview(field)
              beginStroke(field, localUser.color)
              for (const p of ps.points) {
                appendActivePoint(field, p.x, p.y, p.speed)
              }
              ps.strokeBegun = true
            }
            if (farEnough) {
              ps.points.push({ x: c.x, y: c.y, speed: c.speedNorm })
              ps.lastPointX = c.x
              ps.lastPointY = c.y
              appendActivePoint(field, c.x, c.y, c.speedNorm)
            }
          } else {
            ps.mode = 'dot-preview'
            setDotPreview(field, c.x, c.y)
            if (farEnough) {
              ps.points.push({ x: c.x, y: c.y, speed: c.speedNorm })
              ps.lastPointX = c.x
              ps.lastPointY = c.y
            }
          }
        }
        break
      }
      case 'releaseCandidate': {
        if (!pinchDetected) {
          ps.releaseFrames++
          if (ps.releaseFrames >= RELEASE_CONFIRM_FRAMES) {
            if (editMode) {
              ps.state = 'idle'
              ps.pinchFrames = 0
              ps.releaseFrames = 0
            } else {
              finalizeDraw()
            }
          }
          // No point collection during release — see spec.
        } else {
          // False alarm — pinch is back. Resume drawing.
          ps.state = 'drawing'
          ps.releaseFrames = 0
        }
        break
      }
    }

    // ---------- Cursor + remote broadcast ----------
    const isHeld = ps.state === 'drawing' || ps.state === 'releaseCandidate'
    if (editMode) {
      const hovered = findNearestObject(
        field, c.x, c.y, EDIT_HOVER_RADIUS * dprRef.current,
      )
      setCursor(field, c.x, c.y, { visible: false, pinching: false, color: localUser.color })
      setEditingCursor(field, c.x, c.y, {
        gesture: isHeld ? 'fist' : 'palm',
        hoveredId:
          hovered &&
          !field.dots.get(hovered.id)?.dissolving &&
          !field.strokes.get(hovered.id)?.dissolving
            ? hovered.id
            : null,
      })
    } else {
      clearEditingCursor(field)
      setCursor(field, c.x, c.y, {
        visible: true, pinching: isHeld, color: localUser.color,
      })
    }

    // Broadcast cursor at ~30Hz throttle.
    if (now - lastCursorSendAt.current > CURSOR_SEND_INTERVAL_MS) {
      lastCursorSendAt.current = now
      roomApiRef.current?.sendCursor?.({
        x: c.x / field.width,
        y: c.y / field.height,
        pinching: isHeld,
        editing: editMode,
        visible: true,
      })
    }

    if (now - lastDebugAt.current > DEBUG_INTERVAL_MS) {
      lastDebugAt.current = now
      const v = videoRef.current
      setDebug({
        handDetected: true,
        pinching: isHeld,
        pinchDistance: ps.pinchRatioSmooth,
        pinchDuration: ps.state === 'drawing' || ps.state === 'releaseCandidate'
          ? Math.round(now - ps.startTime) : 0,
        mode: editMode ? `edit/${ps.state}` : (isHeld ? ps.mode : ps.state),
        movementPx: Math.round(ps.maxMovement / dprRef.current),
        rawX: lm[8].x,
        rawY: lm[8].y,
        mappedX: Math.round(c.x / dprRef.current),
        mappedY: Math.round(c.y / dprRef.current),
        canvasW: Math.round(field.width / dprRef.current),
        canvasH: Math.round(field.height / dprRef.current),
        videoW: v ? v.videoWidth : 0,
        videoH: v ? v.videoHeight : 0,
        mirror: 'selfieMode',
        speed: c.speedNorm,
        cursorDelta: c.lastDelta,
        activePoints: ps.points.length,
        visualStrokes: field.strokes.size,
        visualDots: field.dots.size,
        activeSounds: getActiveSoundCount(),
        scheduledEvents: getScheduledEventCount(),
        audioStatus: getAudioStatus(),
        ...lastPhrase.current,
      })
    }
  }, [localUser])

  const { status: trackingStatus, error: trackingError, info: cameraInfo } = useHandTracking({
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
  }, [trackingStatus])

  // Mirror the camera MediaStream from the self-view <video> into the
  // top-row tile <video>. Multiple <video> elements can share one
  // MediaStream via srcObject — both will play the same live frames.
  // Polls briefly because MediaPipe's Camera assigns srcObject async.
  useEffect(() => {
    const main = videoRef.current
    let cancelled = false
    const sync = () => {
      if (cancelled) return
      const tile = tileVideoRef.current
      if (main && tile && main.srcObject && tile.srcObject !== main.srcObject) {
        tile.srcObject = main.srcObject
        tile.play().catch(() => {})
      }
    }
    sync()
    const interval = setInterval(sync, 400)
    return () => { cancelled = true; clearInterval(interval) }
  }, [trackingStatus])

  // ---------- Controls ----------
  const handleStartAudio = async () => {
    try {
      await startAudio()
      setAudioOn(true)
    } catch (err) {
      console.error('audio start failed', err)
    }
  }

  const handleToggleMute = () => {
    setMuted((m) => {
      const next = !m
      setMasterMuted(next)
      return next
    })
  }

  const handleClear = () => {
    const field = fieldRef.current
    if (field) clearStrokes(field)
    clearAllStrokes()
    strokeMeta.current.clear()
    lastPhrase.current = {
      strokePoints: 0, direction: '—', notes: [],
      phraseLength: 0, smoothness: 0, lengthCategory: '—',
    }
    roomApiRef.current?.sendStrokesClear?.()
  }

  // Clear only sketches whose audio has already been evicted (visualOnly).
  // Keeps the live sound-producing layers, removes the cosmetic clutter.
  const handleClearInactive = () => {
    const field = fieldRef.current
    if (!field) return
    const removed = clearInactive(field)
    for (const id of removed) strokeMeta.current.delete(id)
  }

  const localStatus = useMemo(() => {
    if (!audioOn) return 'audio off'
    if (muted) return 'muted'
    if (mode === 'edit') return debug.pinching ? 'deleting' : 'editing'
    if (debug.pinching) return 'drawing'
    return 'listening'
  }, [audioOn, muted, debug.pinching, mode])

  return (
    <div className="canvas-page">
      <canvas ref={stageRef} className="stage" />

      <header className="participant-row">
        <div className="room-chip">
          <span className="label">Room</span>
          <span className="code">{roomCode}</span>
          <span
            className={`live-dot ${room.connected ? 'on' : 'off'}`}
            title={room.connected ? 'Connected to room' : 'Connecting…'}
          />
        </div>
        <ShareLinkChip />


        <div className="mode-toggle" role="tablist" aria-label="Interaction mode">
          <button
            role="tab"
            aria-selected={mode === 'create'}
            className={mode === 'create' ? 'active' : ''}
            onClick={() => setMode('create')}
          >
            Create<span className="key">C</span>
          </button>
          <button
            role="tab"
            aria-selected={mode === 'edit'}
            className={mode === 'edit' ? 'active' : ''}
            onClick={() => setMode('edit')}
          >
            Edit<span className="key">E</span>
          </button>
        </div>

        <div className="tiles-scroll">
          <ParticipantTile
            name={localUser.name}
            color={localUser.color}
            status={localStatus}
            isLocal
            videoEl={tileVideoRef}
          />
          {room.participants.map((p) => (
            <ParticipantTile
              key={p.id}
              name={p.name}
              color={p.color}
              status="listening"
            />
          ))}
        </div>

        <div className="hint-chip">
          {mode === 'create' ? (
            <>
              <span className="hint-title">Sketch to compose.</span>
              <span className="hint-sub">Listen to what takes form.</span>
            </>
          ) : (
            <>
              <span className="hint-title">Hover to select.</span>
              <span className="hint-sub">Pinch to remove.</span>
            </>
          )}
        </div>
      </header>

      {/* Active sound layers indicator */}
      <div
        className={`layer-indicator${debug.activeSounds >= MAX_ACTIVE_STROKES ? ' at-cap' : ''}`}
        title="When the cap is reached, the oldest sketch fades to visual-only."
      >
        <span className="layer-label">Active sound layers</span>
        <span className="layer-count">
          <b>{debug.activeSounds}</b>
          <span> / {MAX_ACTIVE_STROKES}</span>
        </span>
      </div>

      <div
        className="self-view"
        style={{ '--user-color': localUser.color }}
      >
        <video ref={videoRef} playsInline muted autoPlay />
        <canvas ref={overlayRef} />
        {trackingStatus !== 'ready' && (
          <span className="self-view-tracking">{trackingStatus}</span>
        )}
        <div className="self-view-label">
          <span className="self-view-name">{localUser.name}</span>
          <span className="self-view-status" style={{ color: localUser.color }}>
            {localStatus}
          </span>
        </div>
      </div>

      <div className="controls">
        {!audioOn ? (
          <button className="primary" onClick={handleStartAudio}>Start Audio</button>
        ) : (
          <button onClick={handleToggleMute}>{muted ? 'Unmute' : 'Mute'}</button>
        )}
        <button onClick={handleClearInactive}>Clear Inactive</button>
        <button onClick={handleClear}>Clear Canvas</button>
        <button onClick={onLeave}>Back</button>
      </div>

      <div className="debug-panel">
        <div className="row"><span>hand</span><b>{debug.handDetected ? 'yes' : 'no'}</b></div>
        <div className="row"><span>pinch active</span><b>{debug.pinching ? 'true' : 'false'}</b></div>
        <div className="row"><span>pinch distance</span><b>{debug.pinchDistance.toFixed(3)}</b></div>
        <div className="row"><span>pinch start ≤</span><b>{PINCH_START_THRESHOLD.toFixed(3)}</b></div>
        <div className="row"><span>pinch end ≥</span><b>{PINCH_END_THRESHOLD.toFixed(3)}</b></div>
        <div className="row"><span>mode</span><b>{debug.mode}</b></div>
        <div className="row"><span>movement</span><b>{debug.movementPx}px</b></div>
        <div className="row"><span>speed</span><b>{debug.speed.toFixed(3)}</b></div>
        <div className="row"><span>cursor delta</span><b>{debug.cursorDelta?.toFixed(1) || 0}px</b></div>
        <div className="row"><span>active points</span><b>{debug.activePoints || 0}</b></div>
        <div className="row separator"><span>camera</span><b>—</b></div>
        <div className="row"><span>secure context</span><b>{cameraInfo.secureContext ? 'yes' : 'no'}</b></div>
        <div className="row"><span>mediaDevices</span><b>{cameraInfo.mediaDevicesAvailable ? 'yes' : 'no'}</b></div>
        <div className="row"><span>permission</span><b>{cameraInfo.permissionState}</b></div>
        <div className="row"><span>camera active</span><b>{cameraInfo.cameraActive ? 'yes' : 'no'}</b></div>
        <div className="row"><span>stream tracks</span><b>{cameraInfo.trackCount}</b></div>
        <div className="row"><span>tracking status</span><b>{trackingStatus}</b></div>
        <div className="row"><span>camera error</span><b>{trackingError || '—'}</b></div>
        <div className="row separator"><span>tracking</span><b>—</b></div>
        <div className="row"><span>raw mp x/y</span><b>{debug.rawX.toFixed(3)}, {debug.rawY.toFixed(3)}</b></div>
        <div className="row"><span>smoothed x/y</span><b>{debug.mappedX}, {debug.mappedY}</b></div>
        <div className="row"><span>canvas w/h</span><b>{debug.canvasW}×{debug.canvasH}</b></div>
        <div className="row"><span>video w/h</span><b>{debug.videoW}×{debug.videoH}</b></div>
        <div className="row"><span>mirror</span><b>{debug.mirror}</b></div>
        <div className="row separator"><span>audio</span><b>—</b></div>
        <div className="row"><span>status</span><b>{debug.audioStatus}</b></div>
        <div className="row"><span>active sounds</span><b>{debug.activeSounds} / {MAX_ACTIVE_STROKES}</b></div>
        <div className="row"><span>scheduled events</span><b>{debug.scheduledEvents}</b></div>
        <div className="row"><span>visual strokes</span><b>{debug.visualStrokes}</b></div>
        <div className="row"><span>visual dots</span><b>{debug.visualDots}</b></div>
        <div className="row separator"><span>last stroke</span><b>—</b></div>
        <div className="row"><span>stroke points</span><b>{debug.strokePoints}</b></div>
        <div className="row"><span>direction</span><b>{debug.direction}</b></div>
        <div className="row"><span>length</span><b>{debug.lengthCategory}</b></div>
        <div className="row"><span>smoothness</span><b>{debug.smoothness.toFixed(2)}</b></div>
        <div className="row"><span>phrase length</span><b>{debug.phraseLength} / {MAX_NOTES_PER_STROKE}</b></div>
        <div className="row notes-row">
          <span>generated notes</span>
          <b>{debug.notes.length ? debug.notes.join(' · ') : '—'}</b>
        </div>
      </div>
    </div>
  )
}
