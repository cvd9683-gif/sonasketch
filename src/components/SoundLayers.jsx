import { memo } from 'react'

// Sound layer panel. Presentational only: Canvas.jsx owns the slot
// assignment and drives the per-note animation imperatively through
// registerEls (so a note firing never re-renders React).
//
// Layer shape:
//   {
//     id, slot,                // slot 1..8 is also drawn beside the mark on canvas
//     type: 'stroke' | 'dot',
//     instrument: 'Pluck' | 'Pad',
//     notes: number,
//     state: 'playing' | 'fading' | 'muted' | 'silent',
//     color, glyph,            // glyph = SVG path of the mark's own shape
//     author: string,
//     suggestion: null | { instrument, status: 'pending' | 'accepted' },
//   }
//
// Suggestion flow (not built yet): a suggestion is applied to a stroke the
// user drew. The row keeps the user's current sound visible, shows a quiet
// "Suggested" tag, and exposes Preview / Use / Keep mine actions.

export const MAX_SLOTS = 8

const STATE_LABEL = {
  playing: 'Playing',
  fading: 'Fading out',
  muted: 'Muted',
  silent: 'Silent',
}

function LayerRow({ layer, onHighlight, registerEls }) {
  const { id, slot, instrument, notes, state, color, glyph, author, suggestion } = layer
  return (
    <li
      className={`layer is-${state}`}
      style={{ '--layer-color': color }}
      tabIndex={0}
      aria-label={`Layer ${slot}: ${instrument}, ${notes} ${notes === 1 ? 'note' : 'notes'}, ${STATE_LABEL[state]}`}
      onMouseEnter={() => onHighlight(id)}
      onMouseLeave={() => onHighlight(null)}
      onFocus={() => onHighlight(id)}
      onBlur={() => onHighlight(null)}
      ref={(el) => registerEls(id, 'row', el)}
    >
      <span className="layer-num">{slot}</span>
      <svg
        className="layer-glyph"
        viewBox="0 0 44 24"
        aria-hidden="true"
        ref={(el) => registerEls(id, 'glyph', el)}
      >
        {glyph.type === 'dot'
          ? <circle cx="22" cy="12" r="4" />
          : <path d={glyph.d} />}
      </svg>
      <span className="layer-body">
        <span className="layer-name">
          {instrument}
          {suggestion && <span className="layer-suggest">Suggested</span>}
        </span>
        <span className="layer-meta">
          <span className="mono">{notes}</span> {notes === 1 ? 'note' : 'notes'}
          <span className="layer-sep">·</span>
          {author}
        </span>
      </span>
      <span className="layer-meter" aria-hidden="true">
        <i ref={(el) => registerEls(id, 'meter', el)} />
      </span>
      <button
        type="button"
        className="layer-mute"
        disabled
        aria-label={`Mute layer ${slot} (not available yet)`}
        title="Per-layer mute is coming soon"
      >
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="M2.5 6h2.5l3.5-3v10L5 10H2.5z" />
          <path d="M11 5.5c.9.7 1.4 1.5 1.4 2.5s-.5 1.8-1.4 2.5" />
        </svg>
      </button>
      {suggestion && (
        <span className="layer-actions">
          <button type="button" className="text-btn" disabled>Preview</button>
          <button type="button" className="text-btn" disabled>Use</button>
          <button type="button" className="text-btn" disabled>Keep mine</button>
        </span>
      )}
    </li>
  )
}

function SoundLayers({ slots, audioOn, muted, bpm, onHighlight, registerEls, registerPlayhead }) {
  const filled = slots.filter(Boolean)
  const playing = filled.filter((l) => l.state === 'playing').length
  const status = !audioOn
    ? 'Sound is off'
    : muted
      ? 'Muted'
      : `${playing} of ${MAX_SLOTS} playing`

  return (
    <section className="sound-layers" aria-label="Sound layers">
      <header className="layers-head">
        <h2 className="layers-title">Sound layers</h2>
        <span className="layers-status">{status}</span>
      </header>

      {/* Eight slots at a glance: filled = a sketch owns this slot. */}
      <div className="layer-rings" aria-hidden="true">
        {slots.map((l, i) => (
          <span
            key={i}
            className={`ring${l ? ` is-${l.state}` : ''}`}
            style={l ? { '--layer-color': l.color } : undefined}
            ref={(el) => l && registerEls(l.id, 'ring', el)}
          />
        ))}
      </div>

      {/* One-bar loop: 16 steps, current step lit from the Tone transport. */}
      <div className={`loop-strip${audioOn ? ' is-running' : ''}`} aria-hidden="true">
        <span className="loop-steps" ref={registerPlayhead}>
          {Array.from({ length: 16 }, (_, i) => <i key={i} className={i % 4 === 0 ? 'beat' : ''} />)}
        </span>
        <span className="loop-bpm mono">{bpm} BPM</span>
      </div>

      <ol className="layer-list">
        {filled.map((layer) => (
          <LayerRow
            key={layer.id}
            layer={layer}
            onHighlight={onHighlight}
            registerEls={registerEls}
          />
        ))}
      </ol>

      {filled.length < MAX_SLOTS && (
        <p className="layers-empty">
          {filled.length === 0
            ? 'Pinch and draw — each mark becomes a looping layer.'
            : `${MAX_SLOTS - filled.length} ${MAX_SLOTS - filled.length === 1 ? 'slot' : 'slots'} open`}
        </p>
      )}
    </section>
  )
}

export default memo(SoundLayers)
