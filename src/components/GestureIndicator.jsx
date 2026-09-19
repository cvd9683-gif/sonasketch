import { memo } from 'react'

// Tiny open/pinch readout. Two points stand in for thumb and index tips:
// apart = open hand (cursor moves), together inside a ring = pinch (draws).
// state: 'none' | 'open' | 'pinch'
const COPY = {
  none: { verb: 'No hand', hint: 'raise a hand to the camera' },
  open: { verb: 'Open', hint: 'move' },
  pinch: { verb: 'Pinch', hint: 'draw' },
}

function GestureIndicator({ state }) {
  const { verb, hint } = COPY[state] || COPY.none
  return (
    <div className={`gesture is-${state}`} role="status" aria-live="polite">
      <svg className="gesture-glyph" viewBox="0 0 32 32" aria-hidden="true">
        <circle className="gesture-ring" cx="16" cy="16" r="10" />
        <circle className="gesture-tip tip-a" cx="16" cy="16" r="3" />
        <circle className="gesture-tip tip-b" cx="16" cy="16" r="3" />
      </svg>
      <span className="gesture-text">
        <b>{verb}</b> — {hint}
      </span>
    </div>
  )
}

export default memo(GestureIndicator)
