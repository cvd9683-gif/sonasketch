// Stroke → phrase translation.
//
// Each completed stroke is converted into a fixed-length looping phrase
// whose contour matches the stroke's contour. Pipeline:
//
//   raw stroke points
//      │  resampleStroke()           ← uniform spacing along arc length
//      ▼
//   N evenly-spaced points
//      │  mapYToScaleNote()          ← each point's y → A-minor pentatonic
//      ▼
//   N notes, scheduled in DRAWING ORDER (preserves direction reversals)
//      │  quantize to 16th notes, attach duration based on smoothness
//      ▼
//   phrase: { notes, duration, synthHint, analysis }
//
// The audio module just plays this phrase. All shape analysis lives here.

// A minor pentatonic across three octaves — exactly the 12 notes the user
// asked for. No B, no F: keeps every chord-like cluster consonant.
export const A_MINOR_PENTATONIC = [
  'A2', 'C3', 'D3', 'E3', 'G3', 'A3',
  'C4', 'D4', 'E4', 'G4', 'A4', 'C5',
]

// Direction thresholds expressed as fractions of canvas dimensions so they
// stay sensible across screen sizes / DPRs. ~5% of canvas matches the
// user's "40px on a typical screen" intent.
const Y_DIRECTION_FRAC = 0.05
const X_REVERSE_FRAC = 0.05

/** Map a y in canvas pixel space to a pentatonic scale note. Top → highest pitch. */
export function mapYToScaleNote(y, canvasHeight) {
  const norm = Math.max(0, Math.min(1, y / canvasHeight))
  const idx = Math.round((1 - norm) * (A_MINOR_PENTATONIC.length - 1))
  return A_MINOR_PENTATONIC[idx]
}

/**
 * Resample stroke points uniformly along arc length.
 * Critical for shape-preserving phrases: the original points are sampled
 * at frame rate, so fast hand motion produces sparse points and slow
 * motion produces dense clusters. Resampling by arc-length gives every
 * note an equal share of the visible line.
 */
export function resampleStroke(points, count) {
  if (!points || points.length === 0 || count < 1) return []
  if (count === 1) return [{ ...points[0] }]
  if (points.length === 1) return Array.from({ length: count }, () => ({ ...points[0] }))

  // Cumulative arc-length table
  let total = 0
  const cum = [0]
  for (let i = 1; i < points.length; i++) {
    total += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y)
    cum.push(total)
  }
  if (total === 0) return Array.from({ length: count }, () => ({ ...points[0] }))

  const out = []
  for (let i = 0; i < count; i++) {
    const target = (i / (count - 1)) * total
    // Walk segments until cum[j] >= target
    let j = 1
    while (j < cum.length - 1 && cum[j] < target) j++
    const t0 = cum[j - 1]
    const t1 = cum[j]
    const frac = t1 > t0 ? (target - t0) / (t1 - t0) : 0
    const a = points[j - 1]
    const b = points[j]
    out.push({
      x: a.x + (b.x - a.x) * frac,
      y: a.y + (b.y - a.y) * frac,
      speed: ((a.speed || 0) + (b.speed || 0)) / 2,
    })
  }
  return out
}

/**
 * Inspect a stroke's geometry and motion.
 * Returns:
 *   direction:        'ascending' | 'descending' | 'contour' | 'back-and-forth'
 *   smoothness:       0..1 — 1 is straight, 0 is jagged (drives synth choice)
 *   avgSpeed:         normalized average speed across collected points
 *   arcLength:        total path length in canvas pixels
 *   arcRatio:         arcLength / canvas-diagonal — used for length tiers
 *   lengthCategory:   'short' | 'medium' | 'long'
 *   xReversed:        true if x flipped direction mid-stroke
 *   yDelta, xDelta:   start - end deltas (canvas pixels)
 */
export function analyzeStroke(points, canvasWidth, canvasHeight) {
  if (!points || points.length < 2) return null

  const start = points[0]
  const end = points[points.length - 1]

  // ---- Arc length ----
  let arc = 0
  for (let i = 1; i < points.length; i++) {
    arc += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y)
  }

  // ---- Vertical direction ----
  // Canvas y increases downward, so "stroke went up" means startY > endY,
  // i.e. yDelta = startY - endY is positive.
  const yDelta = start.y - end.y
  const yThresh = Y_DIRECTION_FRAC * canvasHeight

  // ---- X reversal ----
  // If the x extremum (min or max) lives in the *interior* of the stroke
  // rather than at an endpoint, x has reversed direction at least once.
  let xMin = Infinity, xMax = -Infinity, xMinIdx = 0, xMaxIdx = 0
  for (let i = 0; i < points.length; i++) {
    if (points[i].x < xMin) { xMin = points[i].x; xMinIdx = i }
    if (points[i].x > xMax) { xMax = points[i].x; xMaxIdx = i }
  }
  const xRange = xMax - xMin
  const xThresh = X_REVERSE_FRAC * canvasWidth
  const isInterior = (idx) => idx > 0 && idx < points.length - 1
  const xReversed = xRange > xThresh && (isInterior(xMinIdx) || isInterior(xMaxIdx))

  // ---- Direction classifier ----
  let direction
  if (yDelta > yThresh) direction = 'ascending'
  else if (-yDelta > yThresh) direction = 'descending'
  else if (xReversed) direction = 'back-and-forth'
  else direction = 'contour'

  // ---- Smoothness via average local angle change ----
  // For each consecutive pair of segments, measure the turning angle.
  // 0° avg = perfectly straight (smooth = 1), 60°+ avg = jagged (smooth = 0).
  let totalAngle = 0
  let samples = 0
  for (let i = 2; i < points.length; i++) {
    const a1x = points[i - 1].x - points[i - 2].x
    const a1y = points[i - 1].y - points[i - 2].y
    const a2x = points[i].x - points[i - 1].x
    const a2y = points[i].y - points[i - 1].y
    const m1 = Math.hypot(a1x, a1y)
    const m2 = Math.hypot(a2x, a2y)
    if (m1 < 0.5 || m2 < 0.5) continue
    const cos = Math.max(-1, Math.min(1, (a1x * a2x + a1y * a2y) / (m1 * m2)))
    totalAngle += Math.acos(cos)
    samples++
  }
  const avgAngle = samples > 0 ? totalAngle / samples : 0
  const smoothness = Math.max(0, Math.min(1, 1 - avgAngle / (Math.PI / 3)))

  const avgSpeed =
    points.reduce((s, p) => s + (p.speed || 0), 0) / points.length

  // Length tier
  const diag = Math.hypot(canvasWidth, canvasHeight)
  const arcRatio = diag > 0 ? arc / diag : 0
  let lengthCategory
  if (arcRatio < 0.2) lengthCategory = 'short'
  else if (arcRatio < 0.5) lengthCategory = 'medium'
  else lengthCategory = 'long'

  return {
    direction,
    smoothness,
    avgSpeed,
    arcLength: arc,
    arcRatio,
    lengthCategory,
    xReversed,
    yDelta,
    xDelta: end.x - start.x,
  }
}

// How many notes the phrase should have, given length tier + average speed.
// Bounds: 3..8 — capped at 8 to match the audio engine's MAX_NOTES_PER_STROKE
// and to keep the music sparse and intentional. Faster motion still bumps
// density toward the upper end; slower motion settles toward 3-4.
function pickNoteCount(analysis) {
  let base
  if (analysis.lengthCategory === 'short') base = 4
  else if (analysis.lengthCategory === 'medium') base = 6
  else base = 7

  let bump = 0
  if (analysis.avgSpeed > 0.04) bump = 2
  else if (analysis.avgSpeed > 0.02) bump = 1
  else if (analysis.avgSpeed < 0.005) bump = -1

  return Math.max(3, Math.min(8, base + bump))
}

/**
 * Build a complete phrase recipe from a stroke (canvas-pixel space points).
 * Notes are ordered in *drawing order*, not sorted by x — so a stroke that
 * goes right→left→right plays right→left→right in time, which is exactly
 * the "forward then reverse" effect the user asked for.
 */
export function createPhraseFromStroke(points, canvasWidth, canvasHeight, bpm = 90) {
  if (!points || points.length < 3) return null

  const analysis = analyzeStroke(points, canvasWidth, canvasHeight)
  if (!analysis) return null

  const noteCount = pickNoteCount(analysis)
  const resampled = resampleStroke(points, noteCount)

  const phraseDuration = (60 / bpm) * 4 // 1 bar at given tempo
  const sixteenthDur = phraseDuration / 16
  const beatDur = 60 / bpm

  // Smooth strokes get longer, more legato notes; jagged strokes get plucky shorts.
  const noteLengthBeats = 0.35 + analysis.smoothness * 1.25
  const noteDuration = noteLengthBeats * beatDur

  const notes = []
  for (let i = 0; i < resampled.length; i++) {
    const p = resampled[i]
    const note = mapYToScaleNote(p.y, canvasHeight)

    // Drawing-order schedule, snapped to nearest 16th note.
    // Multiplying by (phraseDuration - sixteenthDur) keeps the last note
    // strictly inside the bar instead of falling on the loop boundary.
    const rawTime =
      resampled.length === 1
        ? 0
        : (i / (resampled.length - 1)) * (phraseDuration - sixteenthDur)
    const time = Math.round(rawTime / sixteenthDur) * sixteenthDur

    const velocity = 0.4 + Math.min(0.5, (p.speed || 0) * 8)

    notes.push({
      note,
      time,
      duration: noteDuration,
      velocity,
      x: Math.max(0, Math.min(1, p.x / canvasWidth)),
      y: Math.max(0, Math.min(1, p.y / canvasHeight)),
    })
  }

  return {
    notes,
    duration: phraseDuration,
    synthHint: analysis.smoothness > 0.55 ? 'pad' : 'pluck',
    analysis,
  }
}
