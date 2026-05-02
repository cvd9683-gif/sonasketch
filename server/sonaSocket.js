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
    if (!rooms.has(code)) rooms.set(code, { users: new Map(), strokes: [] })
    return rooms.get(code)
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
      room.users.set(socket.id, user)

      // Snapshot for the joiner: who's already here, what's already drawn.
      const peers = []
      for (const [sid, u] of room.users) {
        if (sid !== socket.id) peers.push(u)
      }
      socket.emit('room:state', {
        you: user,
        peers,
        strokes: room.strokes,
      })

      socket.to(roomCode).emit('participant:joined', { user })
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
      if (room.users.size === 0) rooms.delete(roomCode)
    })
  })

  return io
}
