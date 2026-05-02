// MediaPipe Hands landmark indices we care about
const WRIST = 0
const THUMB_TIP = 4
const INDEX_TIP = 8
const INDEX_MCP = 5
const MIDDLE_TIP = 12
const MIDDLE_MCP = 9
const RING_TIP = 16
const RING_MCP = 13
const PINKY_TIP = 20
const PINKY_MCP = 17

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, (a.z || 0) - (b.z || 0))
const dist2d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y)

// Hand size: distance from wrist to middle MCP, used to normalize thresholds.
function handScale(lm) {
  return dist(lm[WRIST], lm[MIDDLE_MCP]) || 0.1
}

export function isPinching(lm, threshold = 0.45) {
  if (!lm) return false
  return getPinchRatio(lm) < threshold
}

// Raw pinch distance normalized by hand size. ~0 (touching) to ~1.5 (open).
// This is the value to smooth + threshold against in the caller.
export function getPinchRatio(lm) {
  if (!lm) return Infinity
  return dist(lm[THUMB_TIP], lm[INDEX_TIP]) / handScale(lm)
}

// Cursor source point. INDEX_TIP regardless of pinch state — using a single
// landmark removes the visible cursor "jump" that happens when switching
// between pinching (thumb-index midpoint) and not pinching (index tip), since
// those are physically a couple of cm apart. The `pinching` arg is kept for
// callers that may want to gate behavior, but the returned point is always
// INDEX_TIP. MediaPipe selfieMode (set in useHandTracking) means lm.x is
// already aligned with the mirrored on-screen video — no JS flip.
export function getCursorLandmark(lm /* , pinching */) {
  if (!lm) return null
  return { x: lm[INDEX_TIP].x, y: lm[INDEX_TIP].y }
}

// A finger is "extended" when its tip is farther from the wrist than its MCP.
function fingerExtended(lm, tipIdx, mcpIdx) {
  return dist(lm[tipIdx], lm[WRIST]) > dist(lm[mcpIdx], lm[WRIST]) * 1.05
}

export function isOpenPalm(lm) {
  if (!lm) return false
  const fingers = [
    fingerExtended(lm, INDEX_TIP, INDEX_MCP),
    fingerExtended(lm, MIDDLE_TIP, MIDDLE_MCP),
    fingerExtended(lm, RING_TIP, RING_MCP),
    fingerExtended(lm, PINKY_TIP, PINKY_MCP),
  ]
  return fingers.filter(Boolean).length >= 4
}

export function isFist(lm) {
  if (!lm) return false
  const fingers = [
    fingerExtended(lm, INDEX_TIP, INDEX_MCP),
    fingerExtended(lm, MIDDLE_TIP, MIDDLE_MCP),
    fingerExtended(lm, RING_TIP, RING_MCP),
    fingerExtended(lm, PINKY_TIP, PINKY_MCP),
  ]
  return fingers.filter(Boolean).length === 0
}

// Returns hand center position in normalized 0..1 (MediaPipe selfieMode coords —
// already aligned with the mirrored video, no JS flip needed).
export function getHandPosition(lm) {
  if (!lm) return null
  const p = lm[INDEX_MCP] // a stable reference point
  return { x: p.x, y: p.y }
}

// 0 (top of camera) → 1 (bottom of camera). We invert so 1 = high.
export function getHandHeight(lm) {
  if (!lm) return 0
  return 1 - lm[INDEX_MCP].y
}

const SPEED_HISTORY_KEY = '__lastPos'
export function getMovementSpeed(lm, prev) {
  if (!lm) return 0
  const pos = getHandPosition(lm)
  if (!prev || !prev[SPEED_HISTORY_KEY]) {
    if (prev) prev[SPEED_HISTORY_KEY] = pos
    return 0
  }
  const speed = dist2d(pos, prev[SPEED_HISTORY_KEY])
  prev[SPEED_HISTORY_KEY] = pos
  return speed
}

export function getTwoHandDistance(lmA, lmB) {
  if (!lmA || !lmB) return null
  return dist2d(getHandPosition(lmA), getHandPosition(lmB))
}

// Convenience: classify the dominant gesture as a label string.
export function classifyGesture(lm) {
  if (!lm) return 'none'
  if (isPinching(lm)) return 'pinch'
  if (isFist(lm)) return 'fist'
  if (isOpenPalm(lm)) return 'open palm'
  return 'idle'
}
