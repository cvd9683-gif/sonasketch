import * as Tone from 'tone'
import { mapYToScaleNote } from './phrase.js'

// Sound Canvas audio engine.
//
// Performance design:
//   - ONE shared pluck-style PolySynth and ONE shared pad-style PolySynth.
//     Strokes/dots do NOT own synths. They own a Tone.Part that schedules
//     events; the events drive the shared synths.
//   - MAX_ACTIVE_STROKES caps how many Parts are running at once. New strokes
//     evict the oldest's audio (visual stays on canvas — see soundEnabled
//     metadata in Canvas.jsx). This is the "make older strokes visual-only"
//     behavior the spec calls for.
//   - MAX_NOTES_PER_STROKE caps per-stroke event count.
//   - Disposing a Part frees its scheduled events and stops it from firing.
//     The shared synths persist across the audio engine's lifetime.

export const BPM = 90
const LOOP_BARS = 1
const BEATS_PER_BAR = 4
const SUBDIV_PER_BAR = 16

export const MAX_ACTIVE_STROKES = 8
export const MAX_NOTES_PER_STROKE = 8

let initialized = false
let masterGain = null
let reverb = null
let filter = null
let pluckSynth = null
let padSynth = null

// id → { part, type, eventCount, createdAt, synthHint }
const activeStrokes = new Map()

let onNotePlayCallback = null
let onStrokeEvictedCallback = null
let muted = false
let limiting = false

export function setOnNotePlay(cb) { onNotePlayCallback = cb }
export function setOnStrokeEvicted(cb) { onStrokeEvictedCallback = cb }

/**
 * Boot the audio engine. Must be called from a user gesture so the browser
 * lets the AudioContext start. Idempotent — safe to call again to resume.
 */
export async function createAudioEngine() {
  if (initialized) {
    if (Tone.getContext().state !== 'running') await Tone.start()
    if (Tone.getTransport().state !== 'started') Tone.getTransport().start()
    return
  }
  await Tone.start()
  Tone.getTransport().bpm.value = BPM

  masterGain = new Tone.Gain(0.85).toDestination()
  reverb = new Tone.Reverb({ decay: 4.5, wet: 0.4 })
  await reverb.generate()
  reverb.connect(masterGain)
  filter = new Tone.Filter(3500, 'lowpass').connect(reverb)

  // Pluck-style: short snappy envelope on triangle. PolySynth voice-steals
  // when over maxPolyphony, so CPU stays bounded.
  pluckSynth = new Tone.PolySynth(Tone.Synth, {
    oscillator: { type: 'triangle' },
    envelope: { attack: 0.003, decay: 0.4, sustain: 0.0, release: 0.4 },
  })
  pluckSynth.maxPolyphony = 16
  pluckSynth.volume.value = -8
  pluckSynth.connect(filter)

  // Pad-style: longer envelope, fat detuned sine.
  padSynth = new Tone.PolySynth(Tone.Synth, {
    oscillator: { type: 'fatsine', count: 3, spread: 18 },
    envelope: { attack: 0.05, decay: 0.5, sustain: 0.4, release: 1.4 },
  })
  padSynth.maxPolyphony = 8
  padSynth.volume.value = -12
  padSynth.connect(filter)

  Tone.getTransport().start()
  initialized = true
}

// Back-compat alias — older callers used startAudio().
export const startAudio = createAudioEngine

export function disposeAudioEngine() {
  stopAllSounds()
  try { Tone.getTransport().stop() } catch {}
  try { Tone.getTransport().cancel() } catch {}
  pluckSynth?.dispose(); pluckSynth = null
  padSynth?.dispose(); padSynth = null
  filter?.dispose(); filter = null
  reverb?.dispose(); reverb = null
  masterGain?.dispose(); masterGain = null
  initialized = false
}

export function isAudioReady() { return initialized }

export function setMasterMuted(m) {
  muted = m
  if (!masterGain) return
  masterGain.gain.rampTo(m ? 0 : 0.85, 0.1)
}

export function getLoopSeconds() { return (60 / BPM) * BEATS_PER_BAR * LOOP_BARS }

export function getLoopPhase() {
  if (!initialized) return 0
  const loopSec = getLoopSeconds()
  return (Tone.getTransport().seconds % loopSec) / loopSec
}

function pickSynth(hint) {
  return hint === 'pad' ? padSynth : pluckSynth
}

// Eviction = graceful fade-out: stop scheduling new notes immediately so
// any in-flight notes ring out naturally, then dispose the Part after the
// release tail. The visual layer is told via onStrokeEvictedCallback so it
// can mark the object visualOnly.
const FADE_TAIL_MS = 1200

function fadeOutStroke(id) {
  const s = activeStrokes.get(id)
  if (!s || s.fading) return
  s.fading = true
  try { s.part.stop() } catch {}
  setTimeout(() => {
    try { s.part.dispose() } catch {}
    activeStrokes.delete(id)
    limiting = countActive() >= MAX_ACTIVE_STROKES
  }, FADE_TAIL_MS)
}

function countActive() {
  let n = 0
  for (const s of activeStrokes.values()) if (!s.fading) n++
  return n
}

function enforceLimit() {
  while (countActive() > MAX_ACTIVE_STROKES) {
    // First non-fading entry is the oldest active.
    let oldestId = null
    for (const [id, s] of activeStrokes) {
      if (!s.fading) { oldestId = id; break }
    }
    if (!oldestId) break
    fadeOutStroke(oldestId)
    onStrokeEvictedCallback?.(oldestId)
  }
  limiting = countActive() >= MAX_ACTIVE_STROKES
}

/**
 * Schedule a phrase as a looping audio layer. Returns the storage id.
 * If the active-stroke cap is reached, the oldest stroke's audio is stopped
 * (its visual stays on the canvas — see Canvas.jsx soundEnabled handling).
 */
export function playStroke(strokeId, phrase) {
  if (!initialized || !phrase || !phrase.notes || phrase.notes.length === 0) return null

  // If this id is already playing (e.g. someone replayed it), stop the old
  // Part first so we don't double-schedule.
  if (activeStrokes.has(strokeId)) stopStrokeSound(strokeId)

  const synth = pickSynth(phrase.synthHint)

  const events = phrase.notes.slice(0, MAX_NOTES_PER_STROKE).map((n) => ({
    time: n.time,
    note: n.note,
    velocity: n.velocity,
    duration: n.duration,
    x: n.x,
    y: n.y,
  }))

  const part = new Tone.Part((time, ev) => {
    if (muted) return
    synth.triggerAttackRelease(ev.note, ev.duration, time, ev.velocity)
    Tone.Draw.schedule(() => {
      onNotePlayCallback?.(strokeId, ev.x, ev.y)
    }, time)
  }, events)
  part.loop = true
  part.loopEnd = phrase.duration
  part.start(0)

  activeStrokes.set(strokeId, {
    part,
    type: 'stroke',
    eventCount: events.length,
    createdAt: Date.now(),
    synthHint: phrase.synthHint,
  })

  enforceLimit()
  return strokeId
}

// Back-compat alias.
export const playStrokePhrase = playStroke

/**
 * Schedule a single-note dot loop. Triggers the note immediately for
 * creation feedback, then schedules a 1-event Tone.Part that loops once
 * per bar at the bin closest to the dot's normalized x.
 */
export function playDot(dotId, normX, normY) {
  if (!initialized) return null

  if (activeStrokes.has(dotId)) stopStrokeSound(dotId)

  const note = mapYToScaleNote(normY, 1)

  // Immediate one-shot via the shared pluck synth.
  if (!muted) pluckSynth.triggerAttackRelease(note, '8n', undefined, 0.65)

  const loopSec = getLoopSeconds()
  const bin = Math.max(0, Math.min(SUBDIV_PER_BAR - 1, Math.floor(normX * SUBDIV_PER_BAR)))
  const event = {
    time: (bin / SUBDIV_PER_BAR) * loopSec,
    note,
    velocity: 0.55,
    x: normX,
    y: normY,
  }

  const part = new Tone.Part((time, ev) => {
    if (muted) return
    pluckSynth.triggerAttackRelease(ev.note, '8n', time, ev.velocity)
    Tone.Draw.schedule(() => {
      onNotePlayCallback?.(dotId, ev.x, ev.y)
    }, time)
  }, [event])
  part.loop = true
  part.loopEnd = loopSec
  part.start(0)

  activeStrokes.set(dotId, {
    part,
    type: 'dot',
    eventCount: 1,
    createdAt: Date.now(),
    synthHint: 'pluck',
  })

  enforceLimit()
  return dotId
}

// Back-compat alias.
export const addDot = playDot

export function stopStrokeSound(id) {
  const s = activeStrokes.get(id)
  if (!s) return
  try { s.part.stop() } catch {}
  try { s.part.dispose() } catch {} // releases scheduled events
  activeStrokes.delete(id)
  limiting = activeStrokes.size >= MAX_ACTIVE_STROKES
}

// Back-compat alias.
export const removeStroke = stopStrokeSound

export function stopAllSounds() {
  for (const id of [...activeStrokes.keys()]) stopStrokeSound(id)
}

// Back-compat alias.
export const clearAllStrokes = stopAllSounds

// "Active" excludes fading-out parts — they're audible but on their way
// out and don't count against the cap.
export function getActiveSoundCount() {
  return countActive()
}

export function getFadingSoundCount() {
  let n = 0
  for (const s of activeStrokes.values()) if (s.fading) n++
  return n
}

export function getScheduledEventCount() {
  let total = 0
  for (const s of activeStrokes.values()) {
    if (!s.fading) total += s.eventCount
  }
  return total
}

export function getAudioStatus() {
  if (muted) return 'muted'
  if (limiting) return 'limiting'
  return 'stable'
}
