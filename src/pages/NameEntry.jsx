import { useState } from 'react'

// Lightweight gate between Landing and Calibration. Captures display name,
// and (when joining) the room code. Blank name defaults to "Guest" upstream.
export default function NameEntry({
  intent,
  initialJoinCode = '',
  initialName = '',
  onSubmit,
  onBack,
}) {
  const [name, setName] = useState(initialName)
  const [code, setCode] = useState(initialJoinCode)

  const isJoin = intent === 'join'

  const submit = (e) => {
    e.preventDefault()
    if (isJoin && code.trim().length < 3) return
    onSubmit(name, code)
  }

  return (
    <div className="name-entry">
      <div className="name-entry-card">
        <p className="name-entry-eyebrow">
          {isJoin ? 'Joining a room' : 'Creating a room'}
        </p>
        <h2 className="name-entry-title">What should we call you?</h2>
        <p className="name-entry-sub">
          Your name appears beside your sketches in the room.
        </p>

        <form onSubmit={submit} className="name-entry-form">
          <label className="name-entry-field">
            <span>Display name</span>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value.slice(0, 24))}
              placeholder="Guest"
              maxLength={24}
              spellCheck={false}
            />
          </label>

          {isJoin && (
            <label className="name-entry-field">
              <span>Room code</span>
              <input
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase().slice(0, 6))}
                placeholder="ROOM CODE"
                maxLength={6}
                spellCheck={false}
              />
            </label>
          )}

          <div className="name-entry-actions">
            <button type="button" onClick={onBack}>Back</button>
            <button type="submit" className="primary">
              {isJoin ? 'Join Room →' : 'Continue →'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
