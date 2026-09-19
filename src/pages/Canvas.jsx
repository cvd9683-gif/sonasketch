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
  getLayers,
  isAudioReady,
  isMasterMuted,
  disposeAudioEngine,
  stopStrokeSound,
  BPM,
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
import SoundLayers, { MAX_SLOTS } from '../components/SoundLayers.jsx'
import GestureIndicator from '../components/GestureIndicator.jsx'

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
const DOT_MAX_MOVEMENT = 28        // soft hint (unused since the debug panel was removed)
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
  const [copied, setCopied] = useState(false)
  const handleCopy = () => {
    if (typeof navigator === 'undefined') return
    navigator.clipboard?.writeText(url)
      .then(() => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1600)
      })
      .catch(() => {})
  }
  return (
    <button
      type="button"
      className="share-chip text-btn"
      onClick={handleCopy}
      title={isLocal
        ? 'Open the printed http://192.168.x.x URL on your other laptop'
        : `Copy ${url}`}
    >
      {copied ? 'Link copied' : 'Copy link'}
    </button>
  )
}

// ParticipantTile renders one participant. Local user gets the live camera;
// remote users get their captured photo, falling back to colored initials.
// Border + glow + status text use the participant's color so a glance ties
// each tile to that person's drawings.
function ParticipantTile({ name, color, status, isLocal, avatar, videoEl }) {
  return (
    <div
      className={`participant-tile${isLocal ? ' is-local' : ''}`}
      style={{ '--tile-color': color }}
      title={`${name}${isLocal ? ' (you)' : ''} — ${status}`}
    >
      <div className="tile-camera">
        {isLocal ? (
          <video ref={videoEl} playsInline muted autoPlay />
        ) : avatar ? (
          <img className="tile-photo" src={avatar} alt="" />
        ) : (
          <div className="tile-placeholder">
            <span className="tile-initials" style={{ color }}>
              {tileInitials(name)}
            </span>
          </div>
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

// Miniature of a sketch's own shape for its sound layer row. Points are
// normalized 0..1; `aspect` restores the canvas proportions first.
const GLYPH_W = 44
const GLYPH_H = 24
function glyphFromPoints(points, aspect) {
  if (!points || points.length < 2) return { type: 'dot' }
  const step = Math.max(1, Math.floor(points.length / 28))
  const pts = []
  for (let i = 0; i < points.length; i += step) pts.push(points[i])
  if (pts[pts.length - 1] !== points[points.length - 1]) pts.push(points[points.length - 1])
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const p of pts) {
    const x = p.x * aspect
    minX = Math.min(minX, x); maxX = Math.max(maxX, x)
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y)
  }
  const bw = Math.max(maxX - minX, 1e-4)
  const bh = Math.max(maxY - minY, 1e-4)
  const pad = 3
  const k = Math.min((GLYPH_W - pad * 2) / bw, (GLYPH_H - pad * 2) / bh)
  const ox = (GLYPH_W - bw * k) / 2
  const oy = (GLYPH_H - bh * k) / 2
  const d = pts.map((p, i) => {
    const x = ((p.x * aspect - minX) * k + ox).toFixed(1)
    const y = ((p.y - minY) * k + oy).toFixed(1)
    return `${i ? 'L' : 'M'}${x} ${y}`
  }).join('')
  return { type: 'stroke', d }
}

function tileInitials(name) {
  const parts = (name || '').trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0][0].toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

export default function CanvasPage({ roomCode, displayName = 'Guest', avatar = '', onLeave }) {
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
    avatar: avatar || '',
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

  // Open / pinch readout for the gesture indicator. Only pushed into React
  // state when it changes, so tracking frames don't re-render the page.
  const [gesture, setGesture] = useState('none') // 'none' | 'open' | 'pinch'
  const gestureRef = useRef('none')
  const updateGesture = useCallback((g) => {
    if (gestureRef.current === g) return
    gestureRef.current = g
    setGesture(g)
  }, [])

  // ---------- Sound layer panel ----------
  // slot i (0..7) → sketch id. Slots are sticky so a mark keeps its number
  // for as long as it sounds; the number is drawn beside the mark on canvas.
  const slotsRef = useRef(new Array(MAX_SLOTS).fill(null))
  const [layerSlots, setLayerSlots] = useState(() => new Array(MAX_SLOTS).fill(null))
  const layerSigRef = useRef('')
  // Per-id cache of { instrument, notes, glyph } so phrases/paths are
  // computed once per sketch, not on every poll.
  const layerInfoCache = useRef(new Map())
  // id → { row, glyph, meter, ring } DOM nodes, animated on each note.
  const layerElsRef = useRef(new Map())
  const playheadRef = useRef(null)
  const lastStepRef = useRef(-1)
  const reducedMotionRef = useRef(
    typeof window !== 'undefined' &&
      !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches,
  )

  // Multiplayer wiring. roomApiRef is set when the socket hook is ready;
  // every emit is opportunistic so the canvas works fine offline too.
  const roomApiRef = useRef(null)
  const lastCursorSendAt = useRef(0)
  // Snapshot of peers, keyed by id, so onRemoteCursor can fill in
  // color + name without forcing the cursor handler to be recreated
  // (and re-subscribe the socket) every time someone joins.
  const peersRef = useRef(new Map())
  // Server-assigned color (single source of truth for "my color"). The
  // initial localUser.color is only used until the server replies.
  const userColorRef = useRef(localUser.color)
  // Cache of decoded avatar HTMLImageElement keyed by user id. Decoding is
  // async — we kick it off when the participant list updates and read it
  // synchronously from the cursor render path.
  const avatarImgRef = useRef(new Map())
  // Decoded image of the LOCAL user's avatar (or null until ready).
  const myAvatarImgRef = useRef(null)

  const [audioOn, setAudioOn] = useState(false)
  // Ref mirror so the (stable) socket handlers can read current value
  // without re-subscribing every time audioOn flips.
  const audioOnRef = useRef(false)
  useEffect(() => { audioOnRef.current = audioOn }, [audioOn])
  const [muted, setMuted] = useState(false)
  const [enabled, setEnabled] = useState(false)
  // 'create' (draw) | 'edit' (hover + pinch-to-delete). Single-hand throughout —
  // the hand's role changes by mode, never by which hand it is.
  const [mode, setMode] = useState('create')
  const modeRef = useRef('create')
  useEffect(() => { modeRef.current = mode }, [mode])
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
        // Globally unique stroke/dot ids: prefix with this user's id so two
        // clients drawing simultaneously can't collide on numeric counters.
        fieldRef.current.idPrefix = localUser.id
        fieldRef.current.reducedMotion = reducedMotionRef.current
      } else {
        resizeField(fieldRef.current, canvas.width, canvas.height)
      }
    }
    resize()
    window.addEventListener('resize', resize)

    let last = performance.now()
    let frameCount = 0
    let lastHeartbeat = last
    const loop = (now) => {
      const dt = Math.min(0.05, (now - last) / 1000)
      last = now
      const field = fieldRef.current
      if (field) {
        step(field, dt)
        render(ctx, field, { loopPhase: getLoopPhase() })
      }
      // Loop strip: light the current 16th from the Tone transport. Written
      // straight to the DOM (only when the step changes) to stay off React.
      const strip = playheadRef.current
      if (strip) {
        const stepIdx = isAudioReady() ? Math.floor(getLoopPhase() * 16) % 16 : -1
        if (stepIdx !== lastStepRef.current) {
          const kids = strip.children
          if (lastStepRef.current >= 0) kids[lastStepRef.current]?.classList.remove('is-now')
          if (stepIdx >= 0) kids[stepIdx]?.classList.add('is-now')
          lastStepRef.current = stepIdx
        }
      }
      frameCount++
      if (now - lastHeartbeat >= 1000) {
        const f = fieldRef.current
        console.log('[render-loop]', frameCount, 'fps · field:',
          f ? `strokes=${f.strokes.size} dots=${f.dots.size} active=${!!f.activeStroke}` : 'null')
        frameCount = 0
        lastHeartbeat = now
      }
      rafRef.current = requestAnimationFrame(loop)
    }
    rafRef.current = requestAnimationFrame(loop)
    console.log('[render-loop] mounted, canvas', canvas.width, 'x', canvas.height)

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

  // C / E mode toggle. Plus debug keys:
  //   D = drop a test dot at center (proves render path is alive)
  //   L = draw a test horizontal stroke at center
  //   X = clear everything
  useEffect(() => {
    const onKey = (e) => {
      if (e.target?.matches?.('input, textarea')) return
      if (e.key === 'c' || e.key === 'C') setMode('create')
      else if (e.key === 'e' || e.key === 'E') setMode('edit')
      else if (e.key === 'd' || e.key === 'D') {
        const field = fieldRef.current
        if (!field) return console.warn('[debug-D] no field')
        const dot = addDotVisual(field, field.width / 2, field.height / 2, '#ffffff')
        console.log('[debug-D] forced dot →', dot, 'dots.size=', field.dots.size)
      }
      else if (e.key === 'l' || e.key === 'L') {
        const field = fieldRef.current
        if (!field) return
        beginStroke(field, '#ffffff')
        const y = field.height / 2
        for (let i = 0; i <= 20; i++) {
          appendActivePoint(field, field.width * (0.2 + 0.6 * i / 20), y, 0)
        }
        const finished = endStroke(field)
        console.log('[debug-L] forced stroke →', finished, 'strokes.size=', field.strokes.size)
      }
      else if (e.key === 'x' || e.key === 'X') {
        const field = fieldRef.current
        if (field) clearStrokes(field)
        console.log('[debug-X] cleared')
      }
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

  // Each scheduled note (real Tone.Part trigger, skipped while muted) pulses
  // its mark on the canvas AND its row in the sound layer panel.
  const flashLayer = useCallback((id, velocity = 0.6) => {
    const els = layerElsRef.current.get(id)
    if (!els) return
    const reduce = reducedMotionRef.current
    const level = Math.max(0.3, Math.min(1, 0.25 + velocity))
    const ease = 'cubic-bezier(0.2, 0.7, 0.2, 1)'
    els.meter?.animate(
      reduce
        ? [{ opacity: 1 }, { opacity: 0.35 }]
        : [
            { transform: `scaleX(${level})`, opacity: 1 },
            { transform: 'scaleX(0.08)', opacity: 0.35 },
          ],
      { duration: 700, easing: ease },
    )
    els.glyph?.animate(
      [{ opacity: 1, strokeWidth: 2.6 }, { opacity: 0.8, strokeWidth: 1.6 }],
      { duration: 520, easing: ease },
    )
    els.ring?.animate(
      reduce
        ? [{ opacity: 1 }, { opacity: 0.8 }]
        : [{ transform: 'scale(1.7)', opacity: 1 }, { transform: 'scale(1)', opacity: 0.8 }],
      { duration: 480, easing: ease },
    )
  }, [])

  useEffect(() => {
    setOnNotePlay((id, nx, ny, velocity) => {
      const field = fieldRef.current
      if (!field) return
      if (field.dots.has(id)) pulseDot(field, id)
      else pulseStrokeAt(field, id, nx, ny)
      flashLayer(id, velocity)
    })
    return () => setOnNotePlay(null)
  }, [flashLayer])

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
          avatarImg: avatarImgRef.current.get(userId) || null,
        })
      },
      onRemoteStroke: (meta) => {
        const field = fieldRef.current
        if (!field) return
        // De-dupe: ignore if we already have it (server replays history on
        // join, and re-broadcasts can land if another client retries).
        if (strokeMeta.current.has(meta.id)) return
        addRemoteStroke(field, meta)
        strokeMeta.current.set(meta.id, { ...meta, isLocal: false })

        // Audio-for-remote: each client schedules its own copy locally.
        // Skip silently if local audio isn't unlocked yet — the user can
        // start audio later and any further remote strokes will play.
        if (!audioOnRef.current) return
        try {
          if (meta.type === 'dot') {
            const p = meta.points?.[0]
            if (p) addDotAudio(meta.id, p.x, p.y)
          } else if (meta.type === 'stroke') {
            // Reconstruct pixelPoints in this client's canvas size for the
            // phrase analyzer (it uses absolute distances).
            const pts = (meta.points || []).map((p) => ({
              x: p.x * field.width, y: p.y * field.height,
            }))
            if (pts.length >= 2) {
              const phrase = createPhraseFromStroke(pts, field.width, field.height, BPM)
              if (phrase) playStrokePhrase(meta.id, phrase)
            }
          }
        } catch (err) {
          console.warn('[remote-audio] failed to schedule', meta.id, err)
        }
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
      onAudioStart: async () => {
        // Host (or any peer) said "audio is on" — try to unlock locally.
        // If the browser blocks (no user gesture yet), surface a banner.
        if (audioOnRef.current) return
        const ok = await tryStartLocalAudioRef.current?.()
        if (!ok) setAudioPending(true)
      },
      onAudioStop: () => {
        setMasterMuted(true)
        setMuted(true)
      },
    },
  })

  // Keep peersRef in sync with the latest participants list. Also pre-decode
  // any new avatar dataURLs into HTMLImageElements so the cursor render path
  // can blit them directly without paying the decode cost on a hot frame.
  useEffect(() => {
    const m = new Map()
    for (const p of room.participants) m.set(p.id, p)
    peersRef.current = m
    const cache = avatarImgRef.current
    for (const p of room.participants) {
      if (!p.avatar) { cache.delete(p.id); continue }
      const existing = cache.get(p.id)
      if (existing && existing.src === p.avatar) continue
      const img = new Image()
      img.src = p.avatar
      cache.set(p.id, img)
      // The render loop reads img.complete; no listener needed.
    }
    // Drop cache entries for departed participants.
    for (const id of cache.keys()) {
      if (!m.has(id)) cache.delete(id)
    }
    // Self avatar (only this client's local cursor uses it).
    const meSelf = room.me || localUser
    if (meSelf?.avatar) {
      if (!myAvatarImgRef.current || myAvatarImgRef.current.src !== meSelf.avatar) {
        const img = new Image()
        img.src = meSelf.avatar
        myAvatarImgRef.current = img
      }
    } else {
      myAvatarImgRef.current = null
    }
  }, [room.participants, room.me, localUser])

  // Keep userColorRef synced with the server-assigned color.
  useEffect(() => {
    if (room.me?.color) userColorRef.current = room.me.color
  }, [room.me?.color])

  // Hand the room senders to the FSM via a ref (so we don't reallocate
  // onResults on every reconnect).
  useEffect(() => {
    roomApiRef.current = {
      sendCursor: room.sendCursor,
      sendStrokeComplete: room.sendStrokeComplete,
      sendStrokeRemove: room.sendStrokeRemove,
      sendStrokesClear: room.sendStrokesClear,
      sendAudioStart: room.sendAudioStart,
      sendAudioStop: room.sendAudioStop,
    }
  }, [room.sendCursor, room.sendStrokeComplete, room.sendStrokeRemove, room.sendStrokesClear,
    room.sendAudioStart, room.sendAudioStop])

  // ---------- Hand tracking ----------
  // Single-hand mode. The first detected hand is the drawing hand.
  // ===== SIMPLE BASELINE GESTURE PIPELINE =====
  // Replaces the 4-state FSM with the smallest correct implementation:
  //   pinch-down  → record start, prep buffer, show dot preview
  //   still pinching, moved enough → start a stroke, append points
  //   pinch-up    → finalize as stroke (if moved) or dot (if not)
  // No confirmation frames, no hysteresis, no edit branch, no broadcasts.
  // Once this is visibly working we can layer the smoothing/FSM back on.
  // ===== PINCH DETECTION (pixel-distance in video coords) =====
  // Replaces the normalized-ratio approach because that one was hiding the
  // actual sense of "are the fingers close in the image".
  // Distance is measured in VIDEO pixels (typically 640×480 from MediaPipe):
  //   pinch begins when thumb→index distance is BELOW PINCH_START_PX
  //   pinch ends   when distance is ABOVE PINCH_END_PX
  // END > START gives hysteresis so the stroke survives small finger relaxation.
  // Tuned for beginner comfort — fingers don't have to fully close to start,
  // and a wide END window means relaxing slightly mid-stroke is fine.
  const PINCH_START_PX = 55
  const PINCH_END_PX = 85
  const NEAR_PINCH_PX = 120  // visual cue only — not used for drawing decisions
  const SIMPLE_PINCH_CONFIRM_FRAMES = 2
  // Re-add release-frame tolerance for beginners — flickering pinch shouldn't
  // tear a stroke. 4 frames ≈ 65 ms, fast enough to feel responsive.
  const SIMPLE_RELEASE_CONFIRM_FRAMES = 4
  const SIMPLE_MIN_POINT_PX = 8        // beginner-tuned (was 6)
  const SIMPLE_STROKE_MIN_PX = 25
  const SIMPLE_DEADZONE_PX = 5         // beginner-tuned (was 3)
  const SIMPLE_CURSOR_LERP = 0.10      // beginner-tuned: heavier follow (was 0.14)
  const SIMPLE_RELEASE_FREEZE_MS = 120
  // Pinch-drop grace shortened to 8 since hysteresis already absorbs most
  // flicker; 8 still survives a bad ~130 ms patch at 60 Hz.
  const SIMPLE_PINCH_DROP_GRACE_FRAMES = 8
  const SIMPLE_HAND_MISSING_GRACE_FRAMES = 10
  // Throttle cursor broadcasts at ~30 Hz so two laptops on Wi-Fi don't
  // saturate the channel with per-frame messages.
  const SIMPLE_CURSOR_SEND_MS = 33

  const onResults = useCallback((results) => {
    const lms = results.multiHandLandmarks || []
    const field = fieldRef.current
    if (!field) return
    const ps = pinchState.current
    const c = cursorState.current
    const now = performance.now()

    // Finalize the in-progress draw — produces either a stroke or a dot
    // based on whether enough movement occurred to "begin" a stroke.
    const finalizeDraw = () => {
      clearDotPreview(field)
      if (ps.strokeBegun) {
        const finished = endStroke(field)
        console.log('[draw] END (stroke) →', finished ? `id=${finished.id}` : 'null')
        if (finished) {
          // Broadcast: every peer in the room replicates this stroke visually.
          // Audio stays local — each client schedules its own copy.
          const meta = {
            id: finished.id,
            userId: localUser.id,
            userName: localUser.name,
            userColor: userColorRef.current,
            type: 'stroke',
            points: finished.pixelPoints.map((p) => ({
              x: p.x / finished.width,
              y: p.y / finished.height,
            })),
            createdAt: Date.now(),
            soundState: 'active',
            isLocal: true,
          }
          strokeMeta.current.set(finished.id, meta)
          roomApiRef.current?.sendStrokeComplete?.(meta)

          const phrase = createPhraseFromStroke(
            finished.pixelPoints, finished.width, finished.height, BPM,
          )
          if (phrase) playStrokePhrase(finished.id, phrase)
        }
      } else {
        if (field.activeStroke) field.activeStroke = null
        const dot = addDotVisual(field, ps.startX, ps.startY, userColorRef.current)
        console.log('[draw] END (dot) →', dot ? `id=${dot.id}` : 'null',
          '· at', Math.round(ps.startX), Math.round(ps.startY))
        if (dot) {
          const meta = {
            id: dot.id,
            userId: localUser.id,
            userName: localUser.name,
            userColor: userColorRef.current,
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
      ps.points = []
      ps.maxMovement = 0
      ps.strokeBegun = false
      // Freeze cursor briefly so the next-frame jitter can't drag the
      // smoothed cursor away from where the user actually let go.
      releaseFreezeUntil.current = now + SIMPLE_RELEASE_FREEZE_MS
    }

    // ---------- Missing-hand grace ----------
    // MediaPipe drops a frame here and there — don't end the stroke on the
    // first miss. Keep the in-progress draw alive until the hand has been
    // gone for SIMPLE_HAND_MISSING_GRACE_FRAMES consecutive frames.
    if (lms.length === 0) {
      ps.missingFrames = (ps.missingFrames || 0) + 1
      if (ps.wasPinching && ps.missingFrames > SIMPLE_HAND_MISSING_GRACE_FRAMES) {
        console.log('[draw] hand missing for', ps.missingFrames, 'frames — forcing finalize')
        ps.lastFinalizedReason = 'hand missing'
        finalizeDraw()
        ps.wasPinching = false
        ps.missingFrames = 0
      }
      // Only hide the cursor once the grace expires; otherwise leave it where
      // it was so the in-progress stroke doesn't visually flicker.
      if (ps.missingFrames > SIMPLE_HAND_MISSING_GRACE_FRAMES) {
        updateGesture('none')
        setCursor(field, field.cursor.x, field.cursor.y, {
          visible: false,
          pinching: false,
          color: userColorRef.current,
          avatarImg: myAvatarImgRef.current,
          name: localUser.name,
        })
        clearEditingCursor(field)
      }
      return
    }
    ps.missingFrames = 0

    const lm = lms[0]
    // ----- Pinch detection: pixel distance between thumb tip + index tip -----
    // Landmarks are normalized 0..1 in video frame; multiply by video px so
    // the threshold is intuitive ("fingers within ~45 px of each other").
    const v = videoRef.current
    const videoW = v?.videoWidth || 640
    const videoH = v?.videoHeight || 480
    const thumb = lm[4]   // THUMB_TIP
    const index = lm[8]   // INDEX_TIP
    const tx = thumb.x * videoW
    const ty = thumb.y * videoH
    const ix = index.x * videoW
    const iy = index.y * videoH
    const pinchPxRaw = Math.hypot(tx - ix, ty - iy)
    // Light smoothing on the px distance.
    ps.pinchPxSmooth = ps.pinchPxSmooth == null
      ? pinchPxRaw
      : ps.pinchPxSmooth * 0.7 + pinchPxRaw * 0.3
    // HYSTERESIS — wider window once committed so light finger relaxation
    // mid-stroke does not end the stroke.
    const pinchHeld = !!ps.wasPinching
    const pinchRawNow = pinchHeld
      ? ps.pinchPxSmooth < PINCH_END_PX     // sticky: fingers must clearly separate
      : ps.pinchPxSmooth < PINCH_START_PX   // strict: fingers must be close to begin
    // Near-pinch: fingers approaching but not committed. Visual cue only.
    const nearPinch = !pinchHeld
      && !pinchRawNow
      && ps.pinchPxSmooth < NEAR_PINCH_PX
    // 2-frame onset confirmation only for the FIRST entry into a pinch.
    // Once held, isPinching FOLLOWS the raw (hysteresis-thresholded) state
    // so release fires the moment the smoothed distance crosses END_PX.
    // The previous logic used `pinchHeld || ...` which made isPinching
    // sticky-true forever — that's the "pinch never releases" bug.
    if (pinchRawNow) ps.pinchFrames = (ps.pinchFrames || 0) + 1
    else ps.pinchFrames = 0
    const isPinching = pinchHeld
      ? pinchRawNow
      : ps.pinchFrames >= SIMPLE_PINCH_CONFIRM_FRAMES

    // Cursor: lerp toward target, clamp to canvas bounds, with deadzone +
    // post-release freeze. The smoothed cursor (c.x/c.y) is what feeds the
    // gesture pipeline AND what gets drawn — raw target is debug-only.
    const cursorPos = getCursorLandmark(lm)
    const dpr = dprRef.current
    const targetX = Math.max(0, Math.min(field.width,  cursorPos.x * field.width))
    const targetY = Math.max(0, Math.min(field.height, cursorPos.y * field.height))
    c.rawTargetX = targetX
    c.rawTargetY = targetY
    const cursorFrozen = now < releaseFreezeUntil.current

    if (!c.initialized) {
      c.x = targetX; c.y = targetY; c.initialized = true
      c.lastX = targetX; c.lastY = targetY
    } else if (!cursorFrozen) {
      const dx = targetX - c.x
      const dy = targetY - c.y
      const distPx = Math.hypot(dx, dy)
      // Deadzone: only move the smoothed cursor if the target is more than
      // SIMPLE_DEADZONE_PX away. Kills the micro-twitch when the hand is
      // basically still.
      if (distPx > SIMPLE_DEADZONE_PX * dpr) {
        c.x += dx * SIMPLE_CURSOR_LERP
        c.y += dy * SIMPLE_CURSOR_LERP
      }
    }
    const stepPx = Math.hypot(c.x - c.lastX, c.y - c.lastY)
    c.lastDelta = stepPx / dpr
    c.lastX = c.x; c.lastY = c.y

    // ---------- Two-edge gesture detection ----------
    // Pure hysteresis on the smoothed pixel distance: pinchRawNow already
    // returns false the moment distance > PINCH_END_PX, so pinch release is
    // immediate and finalize fires from the (wasPinching && !isPinching) branch.
    // Smoothing on pinchPxSmooth (0.7 prev + 0.3 new) absorbs single-frame
    // noise — no separate grace counter needed.
    const wasPinching = !!ps.wasPinching
    const justStarted = !wasPinching && isPinching
    const justReleased = wasPinching && !isPinching

    if (justStarted) {
      // Pinch-down: prep buffer, show dot preview at anchor.
      ps.startX = c.x
      ps.startY = c.y
      ps.points = [{ x: c.x, y: c.y }]
      ps.lastPointX = c.x
      ps.lastPointY = c.y
      ps.maxMovement = 0
      ps.strokeBegun = false
      ps.lastFinalizedType = null
      setDotPreview(field, c.x, c.y)
      console.log('[draw] PINCH START · cursor=', Math.round(c.x), Math.round(c.y),
        '· px=', Math.round(ps.pinchPxSmooth))
    } else if (wasPinching && isPinching) {
      // Drag: collect points + maybe begin a stroke. Returning pinch resets
      // any pending release-grace (we got pulled back from a near-release).
      ps.releaseFrames = 0
      const distFromStart = Math.hypot(c.x - ps.startX, c.y - ps.startY)
      ps.maxMovement = Math.max(ps.maxMovement, distFromStart)
      const stepFromLast = Math.hypot(c.x - ps.lastPointX, c.y - ps.lastPointY)

      if (ps.maxMovement >= SIMPLE_STROKE_MIN_PX * dpr && !ps.strokeBegun) {
        clearDotPreview(field)
        beginStroke(field, userColorRef.current)
        for (const p of ps.points) appendActivePoint(field, p.x, p.y, 0)
        ps.strokeBegun = true
        console.log('[draw] stroke begun · seeded', ps.points.length, 'points')
      }
      if (stepFromLast >= SIMPLE_MIN_POINT_PX * dpr) {
        ps.points.push({ x: c.x, y: c.y })
        ps.lastPointX = c.x
        ps.lastPointY = c.y
        if (ps.strokeBegun) appendActivePoint(field, c.x, c.y, 0)
      }
      if (!ps.strokeBegun) setDotPreview(field, c.x, c.y)
    } else if (justReleased) {
      // Release-flicker grace: count non-pinch frames; finalize only after
      // SIMPLE_RELEASE_CONFIRM_FRAMES consecutive ones. Cursor updates
      // continue normally below — we just override the wasPinching commit
      // so next frame still re-enters this branch.
      ps.releaseFrames = (ps.releaseFrames || 0) + 1
      if (ps.releaseFrames >= SIMPLE_RELEASE_CONFIRM_FRAMES) {
        console.log('[draw] PINCH RELEASE · maxMovement=',
          Math.round(ps.maxMovement / dpr), 'px · strokeBegun=', ps.strokeBegun,
          '· px=', Math.round(ps.pinchPxSmooth))
        const finalizedType = ps.strokeBegun ? 'stroke' : 'dot'
        ps.lastFinalizedType = finalizedType
        ps.lastFinalizedReason = 'release'
        finalizeDraw()
        ps.releaseFrames = 0
        console.log(finalizedType === 'stroke'
          ? '[draw] FINALIZED STROKE'
          : '[draw] FINALIZED DOT')
      }
    }
    // (drag branch above already runs while wasPinching && isPinching)

    // Commit pinch state. During release-grace (justReleased but counter
    // not yet at threshold), pretend we're still pinching so we re-enter
    // the justReleased branch next frame and the in-progress draw stays alive.
    const inReleaseGrace = wasPinching && !isPinching
      && (ps.releaseFrames || 0) > 0
      && (ps.releaseFrames || 0) < SIMPLE_RELEASE_CONFIRM_FRAMES
    ps.wasPinching = inReleaseGrace ? true : isPinching

    // Always-visible cursor; hide editing cursor (edit mode disabled).
    clearEditingCursor(field)
    setCursor(field, c.x, c.y, {
      visible: true,
      pinching: isPinching,
      nearPinch,
      color: userColorRef.current,
      avatarImg: myAvatarImgRef.current,
      name: localUser.name,
    })

    // Multiplayer: broadcast cursor at ~30 Hz throttle. Normalized 0..1 so
    // peers on different canvas sizes see it in the right place.
    if (now - lastCursorSendAt.current > SIMPLE_CURSOR_SEND_MS) {
      lastCursorSendAt.current = now
      roomApiRef.current?.sendCursor?.({
        x: c.x / field.width,
        y: c.y / field.height,
        pinching: isPinching,
        visible: true,
      })
    }

    updateGesture(isPinching ? 'pinch' : 'open')
  }, [localUser, updateGesture])

  const { status: trackingStatus, error: trackingError } = useHandTracking({
    videoRef, overlayRef, enabled, onResults, maxNumHands: 1, debugOverlay: false,
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

  // ---------- Sound layer polling ----------
  // Source of truth is the audio engine's scheduled Parts (getLayers). Before
  // audio is unlocked nothing is scheduled, so the newest sketches are shown
  // as silent layers instead — the same marks that will sound on start.
  useEffect(() => {
    const layerInfo = (meta) => {
      const cache = layerInfoCache.current
      let info = cache.get(meta.id)
      if (info) return info
      const field = fieldRef.current
      const aspect = window.innerWidth / Math.max(1, window.innerHeight)
      if (meta.type === 'dot') {
        info = { instrument: 'Pluck', notes: 1, glyph: { type: 'dot' } }
      } else {
        let instrument = 'Pluck', notes = 0
        const pts = (meta.points || []).map((p) => ({
          x: p.x * (field?.width || 1), y: p.y * (field?.height || 1),
        }))
        if (field && pts.length >= 2) {
          const phrase = createPhraseFromStroke(pts, field.width, field.height, BPM)
          if (phrase) {
            instrument = phrase.synthHint === 'pad' ? 'Pad' : 'Pluck'
            notes = Math.min(phrase.notes.length, MAX_NOTES_PER_STROKE)
          }
        }
        info = { instrument, notes, glyph: glyphFromPoints(meta.points, aspect) }
      }
      cache.set(meta.id, info)
      return info
    }

    const poll = () => {
      const metas = strokeMeta.current
      const ready = isAudioReady()
      const masterMuted = isMasterMuted()
      const entries = ready
        ? getLayers()
            .filter((l) => metas.has(l.id))
            .map((l) => ({
              id: l.id,
              fading: l.fading,
              instrument: l.synthHint === 'pad' ? 'Pad' : 'Pluck',
              notes: l.eventCount,
            }))
        : [...metas.values()].slice(-MAX_SLOTS).map((m) => ({ id: m.id, fading: false }))
      const byId = new Map(entries.map((e) => [e.id, e]))

      // Sticky slot assignment: free vanished ids, then place new ones.
      // Sounding layers may take a slot from one that is fading out.
      const slots = slotsRef.current
      for (let i = 0; i < slots.length; i++) {
        if (slots[i] && !byId.has(slots[i])) slots[i] = null
      }
      const placed = new Set(slots.filter(Boolean))
      for (const e of entries) {
        if (placed.has(e.id)) continue
        let i = slots.indexOf(null)
        if (i < 0 && !e.fading) i = slots.findIndex((id) => byId.get(id)?.fading)
        if (i < 0) continue
        slots[i] = e.id
        placed.add(e.id)
      }

      const next = slots.map((id, i) => {
        if (!id) return null
        const e = byId.get(id)
        const meta = metas.get(id)
        const info = layerInfo(meta)
        return {
          id,
          slot: i + 1,
          type: meta.type,
          instrument: e.instrument || info.instrument,
          notes: e.notes ?? info.notes,
          state: !ready ? 'silent' : e.fading ? 'fading' : masterMuted ? 'muted' : 'playing',
          color: meta.userColor || '#7ee2ff',
          glyph: info.glyph,
          author: meta.isLocal ? 'you' : (meta.userName || 'guest'),
          suggestion: null,
        }
      })

      const field = fieldRef.current
      if (field) {
        field.layerLabels = new Map(next.filter(Boolean).map((l) => [l.id, l.slot]))
        // A row that unmounts never fires mouseleave — drop stale highlights.
        if (field.highlightId && !field.layerLabels.has(field.highlightId)) field.highlightId = null
      }
      for (const id of layerInfoCache.current.keys()) {
        if (!metas.has(id)) layerInfoCache.current.delete(id)
      }

      const sig = next.map((l) => (l ? `${l.slot}:${l.id}:${l.state}:${l.instrument}:${l.notes}` : '-')).join('|')
      if (sig !== layerSigRef.current) {
        layerSigRef.current = sig
        setLayerSlots(next)
      }
    }

    poll()
    const interval = setInterval(poll, 150)
    return () => clearInterval(interval)
  }, [])

  const registerLayerEls = useCallback((id, key, el) => {
    const map = layerElsRef.current
    let entry = map.get(id)
    if (!el) {
      if (entry) {
        delete entry[key]
        if (!Object.keys(entry).length) map.delete(id)
      }
      return
    }
    if (!entry) { entry = {}; map.set(id, entry) }
    entry[key] = el
  }, [])

  const highlightLayer = useCallback((id) => {
    const field = fieldRef.current
    if (field) field.highlightId = id
  }, [])

  const registerPlayhead = useCallback((el) => {
    playheadRef.current = el
    lastStepRef.current = -1
  }, [])

  // ---------- Controls ----------
  // Pending = host has started audio for the room, but local audio is not
  // yet unlocked (browser autoplay policy needs a user gesture).
  const [audioPending, setAudioPending] = useState(false)

  // Schedule audio playback for every drawing currently in the field —
  // both local and remote. Used when audio unlocks after drawings already
  // exist so the user immediately hears the shared composition.
  // Determinism: each client uses the same drawing id, same normalized
  // points, same BPM, so createPhraseFromStroke yields the same phrase
  // and addDotAudio uses the same id-keyed handle. No randomness per call.
  const scheduleAllExistingAudio = useCallback(() => {
    const field = fieldRef.current
    if (!field) return
    let count = 0
    for (const meta of strokeMeta.current.values()) {
      try {
        if (meta.type === 'dot') {
          const p = meta.points?.[0]
          if (p) { addDotAudio(meta.id, p.x, p.y); count++ }
        } else if (meta.type === 'stroke') {
          const pts = (meta.points || []).map((p) => ({
            x: p.x * field.width, y: p.y * field.height,
          }))
          if (pts.length >= 2) {
            const phrase = createPhraseFromStroke(pts, field.width, field.height, BPM)
            if (phrase) { playStrokePhrase(meta.id, phrase); count++ }
          }
        }
      } catch (err) {
        console.warn('[audio] failed to schedule', meta.id, err)
      }
    }
    console.log('[audio] scheduled', count, 'existing drawings')
  }, [])

  // Try to unlock local audio. Returns true on success. After unlocking,
  // immediately schedule every drawing already on canvas so the listener
  // joins the same composition everyone else is hearing.
  const tryStartLocalAudio = useCallback(async () => {
    try {
      await startAudio()
      setAudioOn(true)
      setAudioPending(false)
      scheduleAllExistingAudio()
      return true
    } catch (err) {
      console.warn('[audio] startAudio failed (likely autoplay block):', err?.message || err)
      return false
    }
  }, [scheduleAllExistingAudio])
  // Mirror in a ref so socket handlers can call it without re-subscribing.
  const tryStartLocalAudioRef = useRef(tryStartLocalAudio)
  useEffect(() => { tryStartLocalAudioRef.current = tryStartLocalAudio }, [tryStartLocalAudio])

  // Local-only "Start Audio" (still works offline). When in a room, also
  // tells the room so other clients try to start.
  const handleStartAudio = async () => {
    const ok = await tryStartLocalAudio()
    if (ok) roomApiRef.current?.sendAudioStart?.()
  }

  // Host-broadcast Start/Stop (room-wide).
  const handleHostStartAudio = async () => {
    await tryStartLocalAudio()
    // Always emit, even if local unlock failed — peers may unlock fine.
    roomApiRef.current?.sendAudioStart?.()
  }
  const handleHostStopAudio = () => {
    setMasterMuted(true)
    setMuted(true)
    roomApiRef.current?.sendAudioStop?.()
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
    pinchState.current.lastFinalizedReason = 'manual clear'
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
    const pinching = gesture === 'pinch'
    if (mode === 'edit') return pinching ? 'deleting' : 'editing'
    if (pinching) return 'drawing'
    return 'listening'
  }, [audioOn, muted, gesture, mode])

  // Host = first joiner of the room (server-assigned); we are host when our
  // user id matches room.hostId. Falls back to "treat me as host" if there's
  // no server connection yet so the offline UX doesn't lose the buttons.
  const isHost = !room.hostId || room.hostId === localUser.id
  // Effective local user (server-assigned color overrides client placeholder).
  const me = room.me || localUser
  // Single source of truth for the top bar. The server's participants list
  // already contains everyone (incl. self), but if the socket hasn't connected
  // yet we still want to render *something* — so fall back to a synthetic
  // [me]. Always self-first for stable layout.
  const participantList = useMemo(() => {
    const list = room.participants && room.participants.length
      ? room.participants
      : [me]
    const self = list.find((p) => p.id === localUser.id)
    const others = list.filter((p) => p.id !== localUser.id)
    return self ? [self, ...others] : [me, ...others]
  }, [room.participants, me, localUser.id])

  const trackingMessage = trackingStatus === 'ready'
    ? null
    : trackingStatus === 'error'
      ? (trackingError || 'Camera unavailable')
      : ({
          idle: 'Starting camera…',
          requesting: 'Allow camera access to draw',
          loading: 'Loading hand tracking…',
        })[trackingStatus] || 'Starting camera…'

  const roomAudioControl = isHost
    ? (room.audioPlaying
        ? { label: 'Stop Room Audio', onClick: handleHostStopAudio, title: 'Stop audio for everyone in the room', live: true }
        : { label: 'Start Room Audio', onClick: handleHostStartAudio, title: 'Start audio for everyone in the room', live: false })
    : null

  return (
    <div className={`canvas-page mode-${mode}`}>
      <canvas ref={stageRef} className="stage" aria-label="Drawing canvas" />

      <header className="topbar">
        <div className="topbar-id">
          <h1 className="wordmark">SonaSketch</h1>
          <div className="room-chip">
            <span className="label">Room</span>
            <span className="code">{roomCode}</span>
            <span
              className={`live-dot ${room.connected ? 'on' : 'off'}`}
              role="img"
              aria-label={room.connected ? 'Connected to room' : 'Connecting…'}
              title={room.connected ? 'Connected to room' : 'Connecting…'}
            />
            <ShareLinkChip />
          </div>
        </div>

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

        <p className="hint-chip">
          {mode === 'create' ? (
            <>
              <span className="hint-title">Pinch to draw.</span>{' '}
              <span className="hint-sub">Move to compose.</span>
            </>
          ) : (
            <>
              <span className="hint-title">Hover to select.</span>{' '}
              <span className="hint-sub">Pinch to remove.</span>
            </>
          )}
        </p>

        <div className="tiles-scroll" aria-label="People in this room">
          {participantList.map((p) => {
            const isLocal = p.id === localUser.id
            return (
              <ParticipantTile
                key={p.id}
                name={p.name}
                color={p.color}
                avatar={p.avatar}
                status={isLocal ? localStatus : 'listening'}
                isLocal={isLocal}
                videoEl={isLocal ? tileVideoRef : undefined}
              />
            )
          })}
        </div>
      </header>

      <GestureIndicator state={trackingStatus === 'ready' ? gesture : 'none'} />

      <SoundLayers
        slots={layerSlots}
        audioOn={audioOn}
        muted={muted}
        bpm={BPM}
        onHighlight={highlightLayer}
        registerEls={registerLayerEls}
        registerPlayhead={registerPlayhead}
      />

      <div
        className={`self-view${muted ? ' is-muted' : ''}`}
        style={{ '--user-color': me.color }}
      >
        <video ref={videoRef} playsInline muted autoPlay />
        <canvas ref={overlayRef} />
        {trackingMessage && (
          <span className={`self-view-tracking${trackingStatus === 'error' ? ' is-error' : ''}`}>
            {trackingMessage}
          </span>
        )}
        <div className="self-view-label">
          <span className="self-view-name">{me.name}</span>
          <span className="self-view-status" style={{ color: me.color }}>
            {localStatus}
          </span>
          {muted && (
            <svg className="self-view-muted" viewBox="0 0 16 16" role="img" aria-label="Muted">
              <path d="M2.5 6h2.5l3.5-3v10L5 10H2.5z" />
              <path d="M11 6l4 4M15 6l-4 4" />
            </svg>
          )}
        </div>
      </div>

      <nav className="controls" aria-label="Session controls">
        <div className="controls-primary">
          {roomAudioControl ? (
            <button
              className={`primary${roomAudioControl.live ? ' is-live' : ''}`}
              onClick={roomAudioControl.onClick}
              title={roomAudioControl.title}
            >
              <span className="primary-glyph" aria-hidden="true" />
              {roomAudioControl.label}
            </button>
          ) : !audioOn ? (
            <button className="primary" onClick={handleStartAudio}>
              <span className="primary-glyph" aria-hidden="true" />
              Start Audio
            </button>
          ) : null}
        </div>

        <div className="controls-secondary">
          {!audioOn
            ? (roomAudioControl && (
                <button className="quiet" onClick={handleStartAudio} title="Unlock sound on this device only">
                  Start Audio
                </button>
              ))
            : (
                <button className="quiet" onClick={handleToggleMute} aria-pressed={muted}>
                  {muted ? 'Unmute' : 'Mute'}
                </button>
              )}
          <button className="quiet" onClick={handleClear}>Clear Canvas</button>
        </div>

        <div className="controls-tertiary">
          <button className="text-btn" onClick={handleClearInactive} title="Remove sketches whose sound has faded out">
            Clear Inactive
          </button>
          <button className="text-btn" onClick={onLeave}>Back</button>
        </div>
      </nav>

      {audioPending && (
        <button
          className="audio-pending-banner"
          onClick={tryStartLocalAudio}
        >
          The host started room audio — <b>tap to listen</b>
        </button>
      )}
    </div>
  )
}
