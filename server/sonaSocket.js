// Lightweight Socket.IO server attached to the Vite dev server's HTTP server.
// One process, one port (5173), one URL to share with a roommate.
//
// State per room: { users: Map<socketId, user>, strokes: stroke[] }.
// Strokes are kept so a late joiner sees the canvas at join time. Capped to
// avoid unbounded growth across a long jam.

import { Server } from 'socket.io'

const STROKE_HISTORY_CAP = 200

export function attachSonaSocket(httpServer) {
  const io = new Server(httpServer, {
    cors: { origin: '*' },
    serveClient: false,
  })

  const rooms = new Map()

  function getRoom(code) {
    if (!rooms.has(code)) {
      rooms.set(code, {
        users: new Map(),
        strokes: [],
        hostId: null,        // first user's id; transferred on disconnect
        audioPlaying: false, // last broadcast audio:start/audio:stop state
        audioStartedAt: 0,   // server epoch ms when audio:start was fired
      })
    }
    return rooms.get(code)
  }

  // Pick a new host when the previous host leaves: oldest still-connected user.
  function reassignHost(room) {
    if (room.users.size === 0) { room.hostId = null; return null }
    // Maps preserve insertion order — first remaining user wins.
    const next = room.users.values().next().value
    room.hostId = next?.id || null
    return room.hostId
  }

  // Snapshot the full participant list of a room. Used to broadcast a
  // complete view to everyone any time membership changes — more robust
  // than relying purely on incremental joined/left deltas.
  function participantsList(room) {
    const out = []
    for (const u of room.users.values()) out.push(u)
    return out
  }
  function broadcastParticipants(roomCode, room) {
    const list = participantsList(room)
    console.log('[sonasocket] broadcast participants →', roomCode, '·',
      list.length, 'users:', list.map(u => `${u.name}(${u.id})`).join(', '))
    const payload = { participants: list, hostId: room.hostId }
    // Emit both the legacy event name and the spec name so any client
    // listening on either will pick it up.
    io.to(roomCode).emit('room:participants', payload)
    io.to(roomCode).emit('participants:update', payload)
  }

  // Server-side color pool. Each room independently picks the first unused
  // color from this palette so every participant in the same room has a
  // visually distinct color. Falls back to random if all 8 are taken.
  const COLOR_PALETTE = [
    '#7ee2ff', // soft cyan
    '#c97bff', // lavender
    '#ff8a5c', // coral
    '#7eff9c', // mint
    '#ffd97e', // gold
    '#ff8ec7', // rose
    '#a08eff', // blue
    '#bcff5e', // lime
  ]
  function pickColor(room) {
    const used = new Set()
    for (const u of room.users.values()) used.add(u.color)
    for (const c of COLOR_PALETTE) if (!used.has(c)) return c
    return COLOR_PALETTE[Math.floor(Math.random() * COLOR_PALETTE.length)]
  }

  io.on('connection', (socket) => {
    let roomCode = null
    let userId = null

    socket.on('room:join', ({ roomCode: code, user }) => {
      if (!code || !user || !user.id) return
      roomCode = String(code).toUpperCase()
      userId = user.id
      socket.join(roomCode)

      const room = getRoom(roomCode)
      // SERVER assigns the color so two clients can't accidentally share
      // one. Client-side color is just a placeholder until this lands.
      const assignedColor = pickColor(room)
      // De-dupe by user.id: if the same userId is rejoining (reconnect),
      // drop any stale entries first so the room view doesn't show ghosts.
      for (const [sid, u] of room.users) {
        if (u.id === user.id && sid !== socket.id) room.users.delete(sid)
      }
      const finalUser = { ...user, color: assignedColor, socketId: socket.id }
      room.users.set(socket.id, finalUser)
      console.log('[sonasocket] join', roomCode, '·', finalUser.name,
        '(' + finalUser.id + ') color=' + assignedColor)
      // First joiner becomes host. Doesn't change for incumbents.
      if (!room.hostId) room.hostId = finalUser.id

      // Tell the joiner their server-assigned color (so they update local UI).
      socket.emit('user:assigned', { user: finalUser })

      // Snapshot for the joiner: who's already here, what's already drawn,
      // who is currently host, and whether host has started audio.
      const peers = []
      for (const [sid, u] of room.users) {
        if (sid !== socket.id) peers.push(u)
      }
      socket.emit('room:state', {
        you: finalUser,
        peers,
        strokes: room.strokes,
        hostId: room.hostId,
        audioPlaying: room.audioPlaying,
        audioStartedAt: room.audioStartedAt,
      })

      socket.to(roomCode).emit('participant:joined', { user: finalUser })
      // ALSO broadcast the full participant list to the whole room — robust
      // against any missed incremental events on either side.
      broadcastParticipants(roomCode, room)
    })

    // Explicit poll-style request — client uses this on mount and on a
    // periodic timer as a backup against missed broadcasts.
    socket.on('participants:request', () => {
      if (!roomCode) return
      const room = getRoom(roomCode)
      const list = participantsList(room)
      socket.emit('room:participants', {
        participants: list,
        hostId: room.hostId,
      })
    })

    // Host audio controls. We do not enforce host-only on the server (clients
    // already gate the buttons), but we record and rebroadcast the state.
    socket.on('audio:start', () => {
      if (!roomCode) return
      const room = getRoom(roomCode)
      room.audioPlaying = true
      room.audioStartedAt = Date.now()
      io.to(roomCode).emit('audio:start', {
        fromHost: room.hostId === userId,
        audioStartedAt: room.audioStartedAt,
      })
    })
    socket.on('audio:stop', () => {
      if (!roomCode) return
      const room = getRoom(roomCode)
      room.audioPlaying = false
      io.to(roomCode).emit('audio:stop', { fromHost: room.hostId === userId })
    })

    socket.on('cursor:update', (data) => {
      if (!roomCode || !userId) return
      socket.to(roomCode).emit('cursor:update', { ...data, userId })
    })

    socket.on('stroke:complete', (meta) => {
      if (!roomCode || !meta || !meta.id) return
      const room = getRoom(roomCode)
      room.strokes.push(meta)
      if (room.strokes.length > STROKE_HISTORY_CAP) {
        room.strokes.splice(0, room.strokes.length - STROKE_HISTORY_CAP)
      }
      socket.to(roomCode).emit('stroke:complete', meta)
    })

    socket.on('stroke:remove', ({ id } = {}) => {
      if (!roomCode || !id) return
      const room = getRoom(roomCode)
      room.strokes = room.strokes.filter((s) => s.id !== id)
      socket.to(roomCode).emit('stroke:remove', { id })
    })

    socket.on('strokes:clear', () => {
      if (!roomCode) return
      const room = getRoom(roomCode)
      room.strokes = []
      socket.to(roomCode).emit('strokes:clear')
    })

    socket.on('disconnect', () => {
      if (!roomCode || !userId) return
      const room = rooms.get(roomCode)
      if (!room) return
      room.users.delete(socket.id)
      socket.to(roomCode).emit('participant:left', { userId })
      if (room.users.size === 0) {
        rooms.delete(roomCode)
        return
      }
      // Host left — promote the oldest remaining user and tell everyone.
      if (room.hostId === userId) {
        const newHost = reassignHost(room)
        if (newHost) io.to(roomCode).emit('host:changed', { hostId: newHost })
      }
      // Always rebroadcast the full participant list after any membership
      // change, so clients self-heal even if they missed the delta event.
      broadcastParticipants(roomCode, room)
    })
  })

  return io
}
