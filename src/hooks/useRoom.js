import { useCallback, useEffect, useRef, useState } from 'react'
import { io } from 'socket.io-client'

// First occurrence wins. Server may send a stale + fresh entry briefly
// during reconnect; this keeps the bar from flashing duplicates.
function dedupeById(list) {
  const seen = new Set()
  const out = []
  for (const u of list || []) {
    if (!u || !u.id || seen.has(u.id)) continue
    seen.add(u.id)
    out.push(u)
  }
  return out
}

// Socket.IO client wrapper.
// - Connects to the same origin the page is served from, so a roommate on
//   another laptop just opens http://192.168.x.x:5173 and joins automatically.
// - All sends are no-ops if the socket isn't connected yet — call sites
//   don't need to gate.
export function useRoom({ roomCode, user, enabled, handlers }) {
  const [participants, setParticipants] = useState([])
  const [me, setMe] = useState(user || null)  // server-assigned user object
  const [connected, setConnected] = useState(false)
  const [hostId, setHostId] = useState(null)
  const [audioPlaying, setAudioPlaying] = useState(false)
  const socketRef = useRef(null)
  const handlersRef = useRef(handlers || {})

  useEffect(() => { handlersRef.current = handlers || {} }, [handlers])

  useEffect(() => {
    if (!enabled || !roomCode || !user) return

    const socket = io({
      transports: ['websocket', 'polling'],
      reconnectionAttempts: 5,
    })
    socketRef.current = socket

    socket.on('connect', () => {
      setConnected(true)
      socket.emit('room:join', { roomCode, user })
      // Backup poll: if the broadcast ever drops, this will refresh the
      // participant list anyway. Cheap.
      socket.emit('participants:request')
    })
    socket.on('disconnect', () => setConnected(false))

    // Server-assigned identity (color may be different from what we sent).
    socket.on('user:assigned', ({ user: u }) => {
      console.log('[useRoom] user:assigned →', u)
      setMe(u)
    })

    // Periodic backup poll — once every 3s. Tiny payload; bulletproof
    // against any missed broadcast event in either direction.
    const pollId = setInterval(() => {
      socketRef.current?.emit('participants:request')
    }, 3000)

    socket.on('room:state', ({ you, peers, strokes, hostId: hid, audioPlaying: ap, audioStartedAt }) => {
      // Initial join snapshot. Build the FULL list (self + peers) so the
      // top bar always has at least our own entry to render against.
      const full = []
      if (you) full.push(you)
      if (Array.isArray(peers)) full.push(...peers)
      setParticipants(dedupeById(full))
      if (you) setMe(you)
      if (hid) setHostId(hid)
      setAudioPlaying(!!ap)
      if (Array.isArray(strokes)) {
        for (const s of strokes) handlersRef.current.onRemoteStroke?.(s)
      }
      if (ap) handlersRef.current.onAudioStart?.({ fromHost: false, audioStartedAt, replay: true })
    })

    // Full-list participant update — fires on every membership change AND
    // on every poll. Server includes EVERY user (self + others); we keep
    // the full list as our source of truth and dedupe by user id.
    const handleParticipants = ({ participants: list, hostId: hid }) => {
      if (Array.isArray(list)) {
        console.log('[useRoom] participants ←', list.length,
          'users:', list.map(p => `${p.name}(${p.id.slice(-6)})`).join(', '))
        setParticipants(dedupeById(list))
        // Update self from the list too (server may have changed our color).
        const self = list.find((p) => p.id === user.id)
        if (self) setMe(self)
      }
      if (hid) setHostId(hid)
    }
    socket.on('room:participants', handleParticipants)
    socket.on('participants:update', handleParticipants)

    socket.on('host:changed', ({ hostId: hid }) => setHostId(hid))
    socket.on('audio:start', (payload) => {
      setAudioPlaying(true)
      handlersRef.current.onAudioStart?.(payload)
    })
    socket.on('audio:stop', (payload) => {
      setAudioPlaying(false)
      handlersRef.current.onAudioStop?.(payload)
    })

    socket.on('participant:joined', ({ user: u }) => {
      setParticipants((prev) => {
        if (prev.some((p) => p.id === u.id)) return prev
        return [...prev, u]
      })
    })

    socket.on('participant:left', ({ userId: leftId }) => {
      setParticipants((prev) => prev.filter((p) => p.id !== leftId))
      handlersRef.current.onParticipantLeft?.(leftId)
    })

    socket.on('cursor:update', (data) => {
      handlersRef.current.onRemoteCursor?.(data)
    })

    socket.on('stroke:complete', (meta) => {
      handlersRef.current.onRemoteStroke?.(meta)
    })

    socket.on('stroke:remove', ({ id }) => {
      handlersRef.current.onRemoteRemove?.(id)
    })

    socket.on('strokes:clear', () => {
      handlersRef.current.onRemoteClear?.()
    })

    return () => {
      clearInterval(pollId)
      socket.removeAllListeners()
      socket.disconnect()
      socketRef.current = null
    }
  }, [enabled, roomCode, user?.id])

  const sendCursor = useCallback((data) => {
    socketRef.current?.emit('cursor:update', data)
  }, [])
  const sendStrokeComplete = useCallback((meta) => {
    socketRef.current?.emit('stroke:complete', meta)
  }, [])
  const sendStrokeRemove = useCallback((id) => {
    socketRef.current?.emit('stroke:remove', { id })
  }, [])
  const sendStrokesClear = useCallback(() => {
    socketRef.current?.emit('strokes:clear')
  }, [])
  const sendAudioStart = useCallback(() => {
    socketRef.current?.emit('audio:start')
  }, [])
  const sendAudioStop = useCallback(() => {
    socketRef.current?.emit('audio:stop')
  }, [])

  return {
    connected,
    participants,
    me,
    hostId,
    audioPlaying,
    sendCursor,
    sendStrokeComplete,
    sendStrokeRemove,
    sendStrokesClear,
    sendAudioStart,
    sendAudioStop,
  }
}
