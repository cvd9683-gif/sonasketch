// Sound Canvas field state.
// Owns: cursor, in-progress active stroke, completed strokes, per-note pulses.

const DEFAULT_COLOR = '#7ee2ff'

// Visual point cap per stroke. Anything beyond this is decimated to keep
// per-frame redraw cost bounded as the canvas fills up.
const MAX_VISUAL_POINTS_PER_STROKE = 80

// Decimate evenly-along-the-array. Preserves first + last; samples evenly
// between. Cheap, good enough — strokes already have ~uniform spacing
// because Canvas filters by MIN_POINT_DISTANCE.
function decimatePoints(pts, maxN) {
  if (pts.length <= maxN) return pts
  const out = new Array(maxN)
  const step = (pts.length - 1) / (maxN - 1)
  for (let i = 0; i < maxN; i++) out[i] = pts[Math.round(i * step)]
  return out
}

// One pass of weighted moving-average smoothing. Cleans residual hand
// shake without flattening the gesture. First/last points are preserved
// so the stroke still anchors at the user's pinch points.
function smoothPointsOnce(pts) {
  if (pts.length < 3) return pts
  const out = [pts[0]]
  for (let i = 1; i < pts.length - 1; i++) {
    const a = pts[i - 1], b = pts[i], c = pts[i + 1]
    out.push({
      x: (a.x + b.x * 2 + c.x) / 4,
      y: (a.y + b.y * 2 + c.y) / 4,
      speed: b.speed,
    })
  }
  out.push(pts[pts.length - 1])
  return out
}

export function createField({ width, height }) {
  return {
    width,
    height,
    cursor: { x: width / 2, y: height / 2, visible: false, pinching: false, color: DEFAULT_COLOR },
    // Editing-hand cursor (second hand). Only set when the editing hand
    // is detected; rendered as an outlined ring that turns into an X on fist.
    editingCursor: null, // { x, y, visible, gesture: 'palm'|'fist'|'idle' }
    hoveredId: null,     // id of the dot/stroke under the editing cursor, if any
    activeStroke: null, // { points: [{x,y,speed}], color }
    strokes: new Map(), // id → { points, color, pulses, soundActive, fading? }
    dots: new Map(),    // id → { x, y, color, scale, pulse, soundActive, fading? }
    dotPreview: null,   // { x, y, age } — live "you'll get a dot" indicator while pinching
    // Remote participants' cursors. userId → { nx, ny, pinching, color, name, lastSeen }
    // Stored in normalized 0..1 so we don't have to rescale on resize.
    remoteCursors: new Map(),
    nextId: 1,
    // Prefix every locally-generated id with this so the same numeric counter
    // on two clients can't collide. Set by Canvas.jsx after construction.
    idPrefix: 'local',
  }
}

export function resizeField(field, width, height) {
  const sx = width / field.width
  const sy = height / field.height
  field.width = width
  field.height = height
  field.cursor.x *= sx
  field.cursor.y *= sy
  for (const stroke of field.strokes.values()) {
    for (const p of stroke.points) { p.x *= sx; p.y *= sy }
    for (const pulse of stroke.pulses) { pulse.x *= sx; pulse.y *= sy }
  }
  for (const dot of field.dots.values()) {
    dot.x *= sx
    dot.y *= sy
  }
  if (field.dotPreview) {
    field.dotPreview.x *= sx
    field.dotPreview.y *= sy
  }
  if (field.activeStroke) {
    for (const p of field.activeStroke.points) { p.x *= sx; p.y *= sy }
  }
}

export function setCursor(field, x, y, { visible = true, pinching = false, nearPinch = false, color } = {}) {
  field.cursor.x = x
  field.cursor.y = y
  field.cursor.visible = visible
  field.cursor.pinching = pinching
  field.cursor.nearPinch = nearPinch
  if (color) field.cursor.color = color
}

// Editing cursor (second hand, never produces sound).
// gesture: 'palm' | 'fist' | 'idle'
// hoveredId: id of the dot/stroke under it, or null.
export function setEditingCursor(field, x, y, { gesture = 'idle', hoveredId = null } = {}) {
  if (!field.editingCursor) {
    field.editingCursor = { x, y, visible: true, gesture, hoveredId }
  } else {
    field.editingCursor.x = x
    field.editingCursor.y = y
    field.editingCursor.visible = true
    field.editingCursor.gesture = gesture
    field.editingCursor.hoveredId = hoveredId
  }
  field.hoveredId = hoveredId
}

export function clearEditingCursor(field) {
  if (field.editingCursor) field.editingCursor.visible = false
  field.hoveredId = null
}

// Find the nearest dot/stroke under (x, y) in pixel space, within maxDist px.
// Returns { type: 'dot'|'stroke', id } or null.
export function findNearestObject(field, x, y, maxDist = 32) {
  let best = null
  let bestD = maxDist

  for (const [id, dot] of field.dots) {
    const d = Math.hypot(dot.x - x, dot.y - y)
    if (d < bestD) {
      bestD = d
      best = { type: 'dot', id }
    }
  }

  for (const [id, stroke] of field.strokes) {
    const pts = stroke.points
    for (let i = 1; i < pts.length; i++) {
      const d = pointToSegmentDistance(x, y, pts[i - 1], pts[i])
      if (d < bestD) {
        bestD = d
        best = { type: 'stroke', id }
      }
    }
  }
  return best
}

function pointToSegmentDistance(px, py, a, b) {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len2 = dx * dx + dy * dy
  if (len2 === 0) return Math.hypot(px - a.x, py - a.y)
  let t = ((px - a.x) * dx + (py - a.y) * dy) / len2
  t = Math.max(0, Math.min(1, t))
  const cx = a.x + t * dx
  const cy = a.y + t * dy
  return Math.hypot(px - cx, py - cy)
}

// Remove a dot or stroke from the field (called when editing-hand fist deletes).
export function removeObject(field, id) {
  if (field.dots.has(id)) {
    field.dots.delete(id)
    if (field.hoveredId === id) field.hoveredId = null
    return true
  }
  if (field.strokes.has(id)) {
    field.strokes.delete(id)
    if (field.hoveredId === id) field.hoveredId = null
    return true
  }
  return false
}

// Mark a stroke or dot as visual-only (no sound). Renders dimmer + no strong pulse.
export function setVisualOnly(field, id) {
  const s = field.strokes.get(id)
  if (s) { s.visualOnly = true; return }
  const d = field.dots.get(id)
  if (d) d.visualOnly = true
}

// Begin a dissolve animation for a dot/stroke. The object stays in the
// field for the duration of the animation (~250ms via dissolveLife→0 in step)
// then auto-removes. Audio should be stopped by the caller.
export function dissolveObject(field, id) {
  if (field.hoveredId === id) field.hoveredId = null
  const dot = field.dots.get(id)
  if (dot) { dot.dissolving = true; dot.dissolveLife = 1; return true }
  const stroke = field.strokes.get(id)
  if (stroke) { stroke.dissolving = true; stroke.dissolveLife = 1; return true }
  return false
}

export function beginStroke(field, color = DEFAULT_COLOR) {
  field.activeStroke = { points: [], color }
}

export function appendActivePoint(field, x, y, speed = 0) {
  if (!field.activeStroke) return
  const last = field.activeStroke.points[field.activeStroke.points.length - 1]
  if (last && Math.hypot(last.x - x, last.y - y) < 2) return
  field.activeStroke.points.push({ x, y, speed })
}

/**
 * Finalize the active stroke. Returns:
 *   { id, pixelPoints, width, height }
 * where pixelPoints are in canvas-pixel space (so the phrase analyzer can
 * use canvas-relative thresholds). Returns null if the stroke is too short.
 */
export function endStroke(field) {
  const active = field.activeStroke
  field.activeStroke = null
  if (!active || active.points.length < 3) return null

  // The phrase analyzer gets the lightly-smoothed points so the musical
  // contour matches the cleaned-up visual gesture (still arc-length-faithful;
  // smoothing doesn't materially change overall shape).
  const smoothed = smoothPointsOnce(smoothPointsOnce(active.points))
  // Visual cache is decimated for cheap redraw.
  const visualPoints = decimatePoints(smoothed, MAX_VISUAL_POINTS_PER_STROKE)

  const id = `${field.idPrefix}-s${field.nextId++}`
  field.strokes.set(id, {
    points: visualPoints,
    color: active.color,
    pulses: [],
  })

  return {
    id,
    pixelPoints: smoothed,
    width: field.width,
    height: field.height,
  }
}

/** Audio fired a note at normalized (nx, ny) for this stroke. Add a pulse. */
export function pulseStrokeAt(field, strokeId, nx, ny) {
  const s = field.strokes.get(strokeId)
  if (!s) return
  const x = nx * field.width
  const y = ny * field.height
  s.pulses.push({ x, y, life: 1 })
  if (s.pulses.length > 24) s.pulses.shift()
}

/**
 * Drop a permanent dot at canvas pixel (x, y).
 * Pop animation: scale starts at 1.5 and eases back to 1 over ~300ms.
 * Returns id + normalized coords for audio scheduling.
 */
export function addDot(field, x, y, color = DEFAULT_COLOR) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  const id = `${field.idPrefix}-d${field.nextId++}`
  field.dots.set(id, {
    x, y, color,
    scale: 1.5,
    pulse: { life: 1 },
  })
  return {
    id,
    normX: Math.max(0, Math.min(1, x / field.width)),
    normY: Math.max(0, Math.min(1, y / field.height)),
  }
}

/** Audio fired the dot's note — pulse it visually. */
export function pulseDot(field, dotId) {
  const d = field.dots.get(dotId)
  if (!d) return
  d.pulse.life = 1
  d.scale = Math.max(d.scale, 1.25)
}

/**
 * Set or update the live "dot preview" indicator. Shown only while a pinch
 * is in dot-preview mode (movement still under the stroke threshold).
 * Mutually exclusive with activeStroke at the render level.
 */
export function setDotPreview(field, x, y) {
  if (!field.dotPreview) {
    field.dotPreview = { x, y, age: 0 }
  } else {
    field.dotPreview.x = x
    field.dotPreview.y = y
  }
}

export function clearDotPreview(field) {
  field.dotPreview = null
}

export function clearStrokes(field) {
  field.strokes.clear()
  field.dots.clear()
  field.dotPreview = null
  field.activeStroke = null
  field.hoveredId = null
}

// Multiplayer: write/clear a remote participant's cursor.
// position is normalized 0..1; rendered in the participant's color so each
// person's cursor reads as theirs.
export function setRemoteCursor(field, userId, { x, y, pinching, color, name, visible = true }) {
  if (!visible) {
    field.remoteCursors.delete(userId)
    return
  }
  const existing = field.remoteCursors.get(userId)
  if (existing) {
    existing.nx = x; existing.ny = y
    existing.pinching = !!pinching
    if (color) existing.color = color
    if (name) existing.name = name
    existing.lastSeen = performance.now()
  } else {
    field.remoteCursors.set(userId, {
      nx: x, ny: y,
      pinching: !!pinching,
      color: color || '#ffffff',
      name: name || '',
      lastSeen: performance.now(),
    })
  }
}

export function removeRemoteCursor(field, userId) {
  field.remoteCursors.delete(userId)
}

// Multiplayer: replicate a stroke or dot finalized on a remote client.
// Points arrive normalized 0..1; we materialize at the local canvas size
// so it scales to whatever resolution this laptop is running at.
// Remote sketches are visual-only here — audio is local-only by design.
export function addRemoteStroke(field, meta) {
  if (!meta || !meta.id) return
  // Idempotent: server replays history on join, so guard against dupes.
  if (field.dots.has(meta.id) || field.strokes.has(meta.id)) return

  const color = meta.userColor || DEFAULT_COLOR
  if (meta.type === 'dot') {
    const p = meta.points?.[0]
    if (!p) return
    field.dots.set(meta.id, {
      x: p.x * field.width,
      y: p.y * field.height,
      color,
      scale: 1.5,
      pulse: { life: 1 },
      remote: true,
    })
  } else if (meta.type === 'stroke') {
    const pts = (meta.points || []).map((p) => ({
      x: p.x * field.width,
      y: p.y * field.height,
      speed: 0,
    }))
    if (pts.length < 2) return
    field.strokes.set(meta.id, {
      points: pts,
      color,
      pulses: [],
      remote: true,
    })
  }
}

// Remove only visual-only (audio-evicted) sketches; keep active ones.
// Returns the list of removed ids so the caller can also clear strokeMeta.
export function clearInactive(field) {
  const removed = []
  for (const [id, s] of field.strokes) {
    if (s.visualOnly) { removed.push(id); field.strokes.delete(id) }
  }
  for (const [id, d] of field.dots) {
    if (d.visualOnly) { removed.push(id); field.dots.delete(id) }
  }
  if (removed.includes(field.hoveredId)) field.hoveredId = null
  return removed
}

export function step(field, dt) {
  // Strokes: pulses fade; dissolving strokes drop dissolveLife and self-remove.
  for (const [id, s] of field.strokes) {
    for (const p of s.pulses) p.life -= dt * 3.5
    s.pulses = s.pulses.filter((p) => p.life > 0)
    if (s.dissolving) {
      s.dissolveLife -= dt * 4 // ~250ms full dissolve
      if (s.dissolveLife <= 0) field.strokes.delete(id)
    }
  }
  for (const [id, d] of field.dots) {
    // ease scale back toward 1 (creation pop + per-note nudges)
    d.scale += (1 - d.scale) * Math.min(1, dt * 5)
    d.pulse.life = Math.max(0, d.pulse.life - dt * 2.5)
    if (d.dissolving) {
      d.dissolveLife -= dt * 4
      if (d.dissolveLife <= 0) field.dots.delete(id)
    }
  }
  if (field.dotPreview) {
    field.dotPreview.age += dt
  }
}

export function render(ctx, field, { loopPhase = 0 } = {}) {
  const { width, height } = field

  // Soft motion-blur fill so strokes feel like they're glowing on a slate
  ctx.fillStyle = 'rgba(7, 8, 13, 0.22)'
  ctx.fillRect(0, 0, width, height)

  ctx.globalCompositeOperation = 'lighter'

  // gentle whole-stroke loop pulse: 0.7..1.0 modulation
  const breath = 0.78 + 0.22 * Math.sin(loopPhase * Math.PI * 2)

  for (const [id, stroke] of field.strokes) {
    drawStroke(ctx, stroke, breath, id === field.hoveredId)
  }

  for (const [id, dot] of field.dots) {
    drawDot(ctx, dot, breath, id === field.hoveredId)
  }

  // Mutually exclusive: never both at once.
  // - dotPreview is set while pinching with little movement.
  // - activeStroke is set the moment movement crosses the stroke threshold.
  // The state machine in Canvas.jsx clears the preview when it begins the
  // active stroke; the gate here is just a defensive belt.
  if (field.activeStroke) {
    drawActiveStroke(ctx, field.activeStroke)
  } else if (field.dotPreview) {
    drawDotPreview(ctx, field.dotPreview)
  }

  // Remote cursors render under the local cursor so the local one always
  // reads as "yours" on top.
  if (field.remoteCursors && field.remoteCursors.size) {
    for (const rc of field.remoteCursors.values()) {
      drawRemoteCursor(ctx, rc, field.width, field.height)
    }
  }

  if (field.cursor.visible) {
    drawCursor(ctx, field.cursor)
  }

  if (field.editingCursor && field.editingCursor.visible) {
    drawEditingCursor(ctx, field.editingCursor)
  }

  ctx.globalCompositeOperation = 'source-over'
}

// Remote cursors render as a small circular avatar with the user's color
// glowing behind. The avatar shows initials (1-2 chars from the name) on
// a colored disc — no floating name pill. Easier to scan when multiple
// peers are drawing at once. Photo support could replace the initials disc
// later (rc.avatar would carry an HTMLImageElement or dataURL).
function getInitials(name) {
  const parts = (name || '').trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0][0].toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

function drawRemoteCursor(ctx, rc, width, height) {
  const x = rc.nx * width
  const y = rc.ny * height
  const avatarR = rc.pinching ? 14 : 18  // disc radius
  const ringR = avatarR + 4               // outer color ring

  // Soft outer glow in user's color
  const glow = ctx.createRadialGradient(x, y, 0, x, y, ringR * 2.2)
  glow.addColorStop(0, hexToRgba(rc.color, 0))
  glow.addColorStop(0.4, hexToRgba(rc.color, rc.pinching ? 0.35 : 0.22))
  glow.addColorStop(1, hexToRgba(rc.color, 0))
  ctx.fillStyle = glow
  ctx.beginPath()
  ctx.arc(x, y, ringR * 2.2, 0, Math.PI * 2)
  ctx.fill()

  // Color ring
  ctx.strokeStyle = rc.color
  ctx.lineWidth = rc.pinching ? 3 : 2
  ctx.beginPath()
  ctx.arc(x, y, ringR, 0, Math.PI * 2)
  ctx.stroke()

  // Avatar disc (filled with darker shade of user color)
  ctx.fillStyle = '#11141d'
  ctx.beginPath()
  ctx.arc(x, y, avatarR, 0, Math.PI * 2)
  ctx.fill()

  // Initials
  const initials = getInitials(rc.name)
  ctx.fillStyle = rc.color
  ctx.font = `bold ${avatarR * 0.95}px system-ui, sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(initials, x, y + 1)
  // Reset text alignment for any other consumers.
  ctx.textAlign = 'start'
  ctx.textBaseline = 'alphabetic'
}

// Permanent dot: glowing orb with outer ring. Distinct from strokes' lines.
function drawDot(ctx, dot, breath, hovered = false) {
  // Dissolve alpha multiplier. 1 normally; <1 while animating delete.
  const dissolve = dot.dissolving ? Math.max(0, dot.dissolveLife) : 1
  // Slight expansion during dissolve for a "pop out" feel
  const dissolveScale = dot.dissolving ? (1 + (1 - dissolve) * 0.6) : 1
  const baseR = 18 * dot.scale * dissolveScale
  // Visual-only dots (audio evicted) render dimmer with no strong pulse.
  const dim = (dot.visualOnly ? 0.4 : 1) * dissolve
  const pulseLife = dot.visualOnly ? 0 : dot.pulse.life
  const intensity = breath * (0.85 + pulseLife * 0.6) * dim

  ctx.strokeStyle = hexToRgba(dot.color, (0.45 * intensity + pulseLife * 0.4))
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.arc(dot.x, dot.y, baseR * 1.7, 0, Math.PI * 2)
  ctx.stroke()

  const halo = ctx.createRadialGradient(dot.x, dot.y, 0, dot.x, dot.y, baseR * 2.6)
  halo.addColorStop(0, hexToRgba('#ffffff', (0.55 + pulseLife * 0.4) * dim))
  halo.addColorStop(0.35, hexToRgba(dot.color, 0.55 * intensity))
  halo.addColorStop(1, hexToRgba(dot.color, 0))
  ctx.fillStyle = halo
  ctx.beginPath()
  ctx.arc(dot.x, dot.y, baseR * 2.6, 0, Math.PI * 2)
  ctx.fill()

  ctx.fillStyle = hexToRgba('#ffffff', 0.95 * intensity)
  ctx.beginPath()
  ctx.arc(dot.x, dot.y, baseR * 0.32, 0, Math.PI * 2)
  ctx.fill()

  if (hovered) {
    ctx.strokeStyle = hexToRgba('#ffffff', 0.85)
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.arc(dot.x, dot.y, baseR * 2.1, 0, Math.PI * 2)
    ctx.stroke()
  }
}

// Live preview during dot-preview mode. Continuous pulse so the user can
// see "this is going to become a dot if I release now."
function drawDotPreview(ctx, preview) {
  // 0..1 oscillation at ~0.8 Hz
  const t = preview.age * 5
  const pulse = 0.5 + 0.5 * Math.sin(t)
  const r = 18 + pulse * 8

  // pulsing pink ring (matches the pinch-cursor's pink so the user reads
  // it as "still in the pinch, just no movement yet")
  ctx.strokeStyle = `rgba(255, 142, 199, ${0.45 + pulse * 0.35})`
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.arc(preview.x, preview.y, r, 0, Math.PI * 2)
  ctx.stroke()

  const grad = ctx.createRadialGradient(preview.x, preview.y, 0, preview.x, preview.y, r * 1.5)
  grad.addColorStop(0, `rgba(255, 255, 255, ${0.45 + pulse * 0.3})`)
  grad.addColorStop(0.4, `rgba(255, 142, 199, ${0.3 + pulse * 0.2})`)
  grad.addColorStop(1, 'rgba(255, 142, 199, 0)')
  ctx.fillStyle = grad
  ctx.beginPath()
  ctx.arc(preview.x, preview.y, r * 1.5, 0, Math.PI * 2)
  ctx.fill()
}

function drawStroke(ctx, stroke, breath, hovered = false) {
  const pts = stroke.points
  if (pts.length < 2) return

  const dissolve = stroke.dissolving ? Math.max(0, stroke.dissolveLife) : 1

  // Visual-only strokes are cheap: a single thin core + low alpha. No glow
  // halos, no breath modulation, no per-note pulses. Keeps redraw cost
  // O(N) flat as the canvas accumulates older sketches.
  if (stroke.visualOnly) {
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.strokeStyle = hexToRgba(stroke.color, 0.32 * dissolve)
    ctx.lineWidth = 1.2
    drawPath(ctx, pts)
    if (hovered) {
      ctx.strokeStyle = hexToRgba('#ffffff', 0.4)
      ctx.lineWidth = 14
      drawPath(ctx, pts)
    }
    return
  }

  // Active strokes get the full glowing treatment.
  const dim = dissolve

  // Outer glow
  ctx.strokeStyle = hexToRgba(stroke.color, 0.18 * breath * dim)
  ctx.lineWidth = 14
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  drawPath(ctx, pts)

  // Mid glow
  ctx.strokeStyle = hexToRgba(stroke.color, 0.4 * breath * dim)
  ctx.lineWidth = 6
  drawPath(ctx, pts)

  // Core line
  ctx.strokeStyle = hexToRgba(stroke.color, 0.85 * breath * dim)
  ctx.lineWidth = 2
  drawPath(ctx, pts)

  if (hovered) {
    ctx.strokeStyle = hexToRgba('#ffffff', 0.55)
    ctx.lineWidth = 18
    drawPath(ctx, pts)
  }

  // Per-note pulses traveling on the stroke
  for (const p of stroke.pulses) {
    const a = Math.max(0, Math.min(1, p.life))
    const grad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, 36)
    grad.addColorStop(0, hexToRgba('#ffffff', 0.95 * a))
    grad.addColorStop(0.4, hexToRgba(stroke.color, 0.6 * a))
    grad.addColorStop(1, hexToRgba(stroke.color, 0))
    ctx.fillStyle = grad
    ctx.beginPath()
    ctx.arc(p.x, p.y, 36, 0, Math.PI * 2)
    ctx.fill()
  }
}

function drawActiveStroke(ctx, stroke) {
  const pts = stroke.points
  if (pts.length < 2) return

  ctx.strokeStyle = hexToRgba(stroke.color, 0.3)
  ctx.lineWidth = 18
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  drawPath(ctx, pts)

  ctx.strokeStyle = hexToRgba(stroke.color, 0.7)
  ctx.lineWidth = 8
  drawPath(ctx, pts)

  ctx.strokeStyle = hexToRgba('#ffffff', 0.95)
  ctx.lineWidth = 2.5
  drawPath(ctx, pts)
}

// Quadratic-midpoint smoothing: each point becomes a curve control, and the
// curve actually passes through the *midpoints* between consecutive controls.
// Cheap (one quadratic per pair), C1 continuous, removes the jagged feel of
// straight lineTo segments without changing the overall gesture shape.
function drawPath(ctx, pts) {
  ctx.beginPath()
  if (pts.length === 0) { ctx.stroke(); return }
  ctx.moveTo(pts[0].x, pts[0].y)
  if (pts.length === 1) { ctx.stroke(); return }
  if (pts.length === 2) {
    ctx.lineTo(pts[1].x, pts[1].y)
    ctx.stroke()
    return
  }
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i].x + pts[i + 1].x) / 2
    const my = (pts[i].y + pts[i + 1].y) / 2
    ctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my)
  }
  // Anchor cleanly on the final point.
  const last = pts[pts.length - 1]
  const prev = pts[pts.length - 2]
  ctx.quadraticCurveTo(prev.x, prev.y, last.x, last.y)
  ctx.stroke()
}

// Editing cursor: outlined ring (not a glowing core like the drawing cursor).
// 'palm' = open ring, 'fist' = ring with an X through it, 'idle' = soft ring.
function drawEditingCursor(ctx, ec) {
  const { x, y, gesture, hoveredId } = ec
  const r = 26
  const stroke = hoveredId ? '#ffffff' : 'rgba(255, 255, 255, 0.7)'

  ctx.lineWidth = 2.5
  ctx.strokeStyle = stroke
  ctx.beginPath()
  ctx.arc(x, y, r, 0, Math.PI * 2)
  ctx.stroke()

  if (gesture === 'palm') {
    // inner pip
    ctx.fillStyle = 'rgba(255, 255, 255, 0.55)'
    ctx.beginPath()
    ctx.arc(x, y, 3.5, 0, Math.PI * 2)
    ctx.fill()
  } else if (gesture === 'fist') {
    // X through the ring
    const k = r * 0.55
    ctx.lineWidth = 3
    ctx.strokeStyle = '#ff6b8b'
    ctx.beginPath()
    ctx.moveTo(x - k, y - k); ctx.lineTo(x + k, y + k)
    ctx.moveTo(x + k, y - k); ctx.lineTo(x - k, y + k)
    ctx.stroke()
  } else {
    // idle: thin dashed look via a smaller inner circle
    ctx.lineWidth = 1
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)'
    ctx.beginPath()
    ctx.arc(x, y, r * 0.55, 0, Math.PI * 2)
    ctx.stroke()
  }
}

function drawCursor(ctx, cursor) {
  // Three states: pinching (small bright), nearPinch (medium, ramping up),
  // idle (large soft halo). nearPinch tells the user "I see you intend to
  // pinch" before we commit to drawing.
  const pinching = !!cursor.pinching
  const nearPinch = !!cursor.nearPinch && !pinching
  const r = pinching ? 14 : nearPinch ? 19 : 26
  const haloAlpha = pinching ? 0.6 : nearPinch ? 0.5 : 0.4
  const coreR = pinching ? 5 : nearPinch ? 4.2 : 3.5
  const color = cursor.color || '#7ee2ff'
  const grad = ctx.createRadialGradient(cursor.x, cursor.y, 0, cursor.x, cursor.y, r * 1.6)
  grad.addColorStop(0, 'rgba(255, 255, 255, 1)')
  grad.addColorStop(0.5, hexToRgba(color, haloAlpha))
  grad.addColorStop(1, hexToRgba(color, 0))
  ctx.fillStyle = grad
  ctx.beginPath()
  ctx.arc(cursor.x, cursor.y, r * 1.6, 0, Math.PI * 2)
  ctx.fill()

  // hard core dot
  ctx.fillStyle = 'rgba(255, 255, 255, 1)'
  ctx.beginPath()
  ctx.arc(cursor.x, cursor.y, coreR, 0, Math.PI * 2)
  ctx.fill()

  // nearPinch: thin outline ring as a "lock-in is ready" cue.
  if (nearPinch) {
    ctx.strokeStyle = hexToRgba(color, 0.7)
    ctx.lineWidth = 1.5
    ctx.beginPath()
    ctx.arc(cursor.x, cursor.y, r + 4, 0, Math.PI * 2)
    ctx.stroke()
  }
}

function hexToRgba(hex, alpha) {
  if (hex.startsWith('rgba')) return hex
  let h = hex.replace('#', '')
  if (h.length === 3) h = h.split('').map((c) => c + c).join('')
  const r = parseInt(h.slice(0, 2), 16)
  const g = parseInt(h.slice(2, 4), 16)
  const b = parseInt(h.slice(4, 6), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}
