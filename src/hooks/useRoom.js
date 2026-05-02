import { useCallback, useEffect, useRef, useState } from 'react'
import { io } from 'socket.io-client'

// Socket.IO client wrapper.
// - Connects to the same origin the page is served from, so a roommate on
//   another laptop just opens http://192.168.x.x:5173 and joins automatically.
// - All sends are no-ops if the socket isn't connected yet — call sites
//   don't need to gate.
export function useRoom({ roomCode, user, enabled, handlers }) {
  const [participants, setParticipants] = useState([])
  const [connected, setConnected] = useState(false)
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
    })
    socket.on('disconnect', () => setConnected(false))

    socket.on('room:state', ({ peers, strokes }) => {
      setParticipants(peers || [])
      if (Array.isArray(strokes)) {
        for (const s of strokes) handlersRef.current.onRemoteStroke?.(s)
      }
    })

    socket.on('participant:joined', ({ user: u }) => {
      setParticipants((prev) => {
        if (prev.some((p) => p.id === u.id)) return prev
        return [...prev, u]
      })
    })

    socket.on('participant:left', ({ userId }) => {
      setParticipants((prev) => prev.filter((p) => p.id !== userId))
      handlersRef.current.onParticipantLeft?.(userId)
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

  return {
    connected,
    participants,
    sendCursor,
    sendStrokeComplete,
    sendStrokeRemove,
    sendStrokesClear,
  }
}
