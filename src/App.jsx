import { useState, useCallback } from 'react'
import Landing from './pages/Landing.jsx'
import NameEntry from './pages/NameEntry.jsx'
import Calibration from './pages/Calibration.jsx'
import CanvasPage from './pages/Canvas.jsx'

function makeRoomCode() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  return Array.from({ length: 4 }, () => letters[Math.floor(Math.random() * letters.length)]).join('')
}

// stage flow:
//   landing → name (intent: 'create' | 'join') → calibration → room → landing
export default function App() {
  const [stage, setStage] = useState('landing')
  const [roomCode, setRoomCode] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [avatar, setAvatar] = useState('') // dataURL or ''
  const [intent, setIntent] = useState('create') // 'create' | 'join'
  const [pendingJoinCode, setPendingJoinCode] = useState('')

  const handleCreate = useCallback(() => {
    setIntent('create')
    setPendingJoinCode('')
    setStage('name')
  }, [])

  const handleJoin = useCallback((code) => {
    setIntent('join')
    setPendingJoinCode((code || '').toUpperCase())
    setStage('name')
  }, [])

  const handleNameSubmit = useCallback((name, joinCode, avatarDataUrl) => {
    const trimmed = (name || '').trim().slice(0, 24)
    setDisplayName(trimmed.length ? trimmed : 'Guest')
    setAvatar(avatarDataUrl || '')
    if (intent === 'create') {
      setRoomCode(makeRoomCode())
    } else {
      setRoomCode((joinCode || pendingJoinCode || '').toUpperCase().slice(0, 6))
    }
    setStage('calibration')
  }, [intent, pendingJoinCode])

  const handleEnter = useCallback(() => setStage('room'), [])

  const handleLeave = useCallback(() => {
    setRoomCode('')
    setStage('landing')
  }, [])

  const handleBackFromName = useCallback(() => setStage('landing'), [])

  return (
    <div className="app">
      {stage === 'landing' && <Landing onCreate={handleCreate} onJoin={handleJoin} />}
      {stage === 'name' && (
        <NameEntry
          intent={intent}
          initialJoinCode={pendingJoinCode}
          initialName={displayName}
          initialAvatar={avatar}
          onSubmit={handleNameSubmit}
          onBack={handleBackFromName}
        />
      )}
      {stage === 'calibration' && (
        <Calibration roomCode={roomCode} onEnter={handleEnter} onCancel={handleLeave} />
      )}
      {stage === 'room' && (
        <CanvasPage
          roomCode={roomCode}
          displayName={displayName}
          avatar={avatar}
          onLeave={handleLeave}
        />
      )}
    </div>
  )
}
