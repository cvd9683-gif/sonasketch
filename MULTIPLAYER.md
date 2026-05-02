# Sound Canvas — Multiplayer Integration Plan

The frontend is already shaped for multiplayer. This note records the contract
so wiring it up later is mostly mechanical.

## What's already in place

- **Per-user color** — `localUser` in `Canvas.jsx` picks one color from
  `LOCAL_USER_COLORS` on mount and threads it through:
  `setCursor`, `beginStroke`, `addDotVisual`. Strokes/dots already render
  in the user's color, not a global color.
- **Stroke metadata** — every completed stroke and dot gets recorded in
  `strokeMeta` (a `Map` keyed by stroke id) with the full broadcast shape:
  ```
  { id, userId, userName, userColor, points, type, createdAt, soundEnabled }
  ```
  `points` are normalized 0..1, so they survive across clients with
  different canvas sizes without rescaling.
- **`soundEnabled` flag** — flipped to `false` when the audio engine evicts
  a stroke at the `MAX_ACTIVE_STROKES` cap (the visual stays). Remote
  strokes will arrive with `soundEnabled: false` so we don't double-trigger
  audio (each client plays its own strokes locally).
- **Audio engine cap** — `MAX_ACTIVE_STROKES = 8` is total across local +
  remote. Eviction is FIFO, oldest-first. This keeps audio CPU bounded
  regardless of how many participants draw.
- **Mock participants** — `MOCK_PARTICIPANTS` in `Canvas.jsx` populates
  the participant row so the UI is ready before the server exists.

## Suggested socket events

### Outgoing (client → server)

| Event              | Payload                                                                  | When                                       |
|--------------------|--------------------------------------------------------------------------|--------------------------------------------|
| `room:join`        | `{ roomCode, user: { id, name, color } }`                                | On `Canvas` mount                          |
| `room:leave`       | `{ roomCode, userId }`                                                   | On `Back` button / unmount                 |
| `cursor:update`    | `{ x, y, pinching }` (normalized)                                        | Throttle to ~30Hz inside `onResults`       |
| `stroke:start`     | `{ id, userId, type, color }`                                            | On rising-edge pinch (mode `dot-preview`)  |
| `stroke:update`    | `{ id, points: [{x,y}, …] }`                                             | While in `stroke-preview`, throttle ~30Hz  |
| `stroke:complete`  | full `strokeMeta` record incl. `soundEnabled: true`                      | On falling-edge pinch                      |
| `stroke:clear`     | `{ userId }` (or omit to clear all)                                      | On `Clear Canvas`                          |
| `audio:mute`       | `{ userId, muted }`                                                      | On mute toggle                             |

### Incoming (server → client)

| Event                | Payload                                | Action                                                                         |
|----------------------|----------------------------------------|--------------------------------------------------------------------------------|
| `participant:joined` | `{ user }`                             | Add to a `participants` state array → renders a tile                           |
| `participant:left`   | `{ userId }`                           | Remove from participants; remove their cursor + maybe their strokes            |
| `cursor:update`      | `{ userId, x, y, pinching, color }`    | `field.remoteCursors.set(userId, …)` (add field), draw alongside local cursor  |
| `stroke:complete`    | full record                            | `addDotVisual` or `beginStroke+endStroke` with provided color and id           |
| `stroke:clear`       | `{ userId }`                           | Remove that user's strokes from `field.strokes` + `field.dots`                 |

## Architecture notes

- **Audio is local-only.** Each client plays its own strokes plus the
  *visuals* of remote strokes. We do NOT replay remote audio — every
  client schedules its own copy. To stay phase-aligned: the Tone.Transport
  on each client starts on `room:join` ack from the server, and a periodic
  `transport:tick { measure, beat }` event lets clients snap if they drift.
  For an MVP, no snap is needed — A minor pentatonic at 90 BPM stays
  consonant even with small phase drift.
- **`MAX_ACTIVE_STROKES = 8` is global.** When a remote `stroke:complete`
  arrives, it goes through `playStrokePhrase` like a local one, and the
  audio engine evicts the oldest if over the cap.
- **Cursors:** add `field.remoteCursors = new Map()` to `visuals.js`. In
  `render`, draw each remote cursor with their `color` between the
  background and local cursor layers.
- **Throttling:** raw `cursor:update` at 60Hz × N participants saturates
  bandwidth. Throttle to 30Hz on send, interpolate on receive.
- **Auth/IDs:** `localUser.id` is currently `local-XXXXXX`. Server should
  issue a real id on `room:join` and the client should adopt it before
  emitting strokes (or we'll have id collisions).

## Server stub (when ready)

A minimal Node + `socket.io` server (~80 LOC) can implement the events
above. State per room:
```js
{
  users: Map<socketId, {id, name, color}>,
  strokes: Array<strokeRecord>   // capped at e.g. 50, FIFO
}
```
On `room:join`, broadcast the existing `strokes` array to the new client
so they see what's already on the canvas.

## What needs to change in the frontend when sockets land

1. New `src/hooks/useRoom.js` — wraps `socket.io-client`, returns
   `{ participants, sendCursor, sendStrokeStart, sendStrokeUpdate,
   sendStrokeComplete, sendClear, on(...) }`.
2. `Canvas.jsx`:
   - replace `MOCK_PARTICIPANTS` with `participants` from `useRoom`.
   - call `sendCursor` (throttled) inside `onResults`.
   - call `sendStrokeComplete(meta)` when adding to `strokeMeta`.
   - subscribe to incoming events; for `stroke:complete`, replicate the
     local creation flow with the remote user's color.
3. `visuals.js`: add `remoteCursors` Map + render path.
4. `vite.config.js`: dev proxy `/socket.io → http://localhost:3001`.

That's the full surface area. The file-level structure is already
multiplayer-shaped — there's no architectural rewrite needed.
