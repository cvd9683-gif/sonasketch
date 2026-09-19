import { useEffect, useRef, useState } from 'react'

// Lightweight gate between Landing and Calibration. Captures display name
// and an optional still photo (used as the cursor avatar + tile photo).
// Two-step flow: name → optional photo → submit. Skipping photo is fine —
// initials from the display name are used as a fallback everywhere.
export default function NameEntry({
  intent,
  initialJoinCode = '',
  initialName = '',
  initialAvatar = '',
  onSubmit,
  onBack,
}) {
  const [step, setStep] = useState('name') // 'name' | 'photo'
  const [name, setName] = useState(initialName)
  const [code, setCode] = useState(initialJoinCode)
  const [avatar, setAvatar] = useState(initialAvatar) // dataURL or ''

  const isJoin = intent === 'join'

  const submit = (avatarOut) => {
    onSubmit(name, code, avatarOut ?? avatar)
  }

  const handleNameSubmit = (e) => {
    e.preventDefault()
    if (isJoin && code.trim().length < 3) return
    setStep('photo')
  }

  return (
    <div className="name-entry">
      <div className="name-entry-card">
        <p className="name-entry-eyebrow">
          {isJoin ? 'Joining a room' : 'Creating a room'}
          {step === 'photo' && ' · Step 2'}
        </p>

        {step === 'name' && (
          <>
            <h2 className="name-entry-title">What should we call you?</h2>
            <p className="name-entry-sub">
              Your name appears beside your sketches in the room.
            </p>

            <form onSubmit={handleNameSubmit} className="name-entry-form">
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
                <button type="submit" className="primary">Next →</button>
              </div>
            </form>
          </>
        )}

        {step === 'photo' && (
          <PhotoStep
            name={name || 'Guest'}
            avatar={avatar}
            onAvatar={setAvatar}
            onBack={() => setStep('name')}
            onSkip={() => submit('')}
            onContinue={() => submit()}
            isJoin={isJoin}
          />
        )}
      </div>
    </div>
  )
}

// Photo capture step. Optional — "Skip" finishes with no avatar (initials
// fallback), "Take photo" grabs a single still from the webcam.
function PhotoStep({ name, avatar, onAvatar, onBack, onSkip, onContinue }) {
  const videoRef = useRef(null)
  const streamRef = useRef(null)
  const [status, setStatus] = useState('idle') // 'idle' | 'live' | 'denied'
  const [err, setErr] = useState('')

  // Stop the stream when leaving this step. Calibration starts its own.
  useEffect(() => {
    return () => {
      const s = streamRef.current
      if (s) s.getTracks().forEach((t) => t.stop())
      streamRef.current = null
    }
  }, [])

  const startCam = async () => {
    setErr('')
    try {
      const s = await navigator.mediaDevices.getUserMedia({
        video: { width: 320, height: 240 }, audio: false,
      })
      streamRef.current = s
      // The <video> only mounts once status is 'live', so the stream is
      // attached in attachVideo (callback ref) rather than here.
      setStatus('live')
    } catch (e) {
      setStatus('denied')
      setErr(e?.message || 'Camera unavailable')
    }
  }

  const attachVideo = (v) => {
    videoRef.current = v
    if (v && streamRef.current && v.srcObject !== streamRef.current) {
      v.srcObject = streamRef.current
      v.play().catch(() => {})
    }
  }

  const snap = () => {
    const v = videoRef.current
    if (!v || !v.videoWidth) return
    // 128×128 square center-crop, encoded as a small JPEG. Small enough to
    // pass through the socket payload without choking the channel.
    const size = 128
    const c = document.createElement('canvas')
    c.width = size
    c.height = size
    const ctx = c.getContext('2d')
    const vw = v.videoWidth, vh = v.videoHeight
    const side = Math.min(vw, vh)
    const sx = (vw - side) / 2
    const sy = (vh - side) / 2
    // Mirror the snapshot so the captured photo matches what the user saw.
    ctx.translate(size, 0)
    ctx.scale(-1, 1)
    ctx.drawImage(v, sx, sy, side, side, 0, 0, size, size)
    const url = c.toDataURL('image/jpeg', 0.78)
    onAvatar(url)
    // Stop the camera right away — Calibration will start its own.
    const s = streamRef.current
    if (s) s.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    setStatus('idle')
  }

  const retake = () => {
    onAvatar('')
    startCam()
  }

  return (
    <>
      <h2 className="name-entry-title">Add a photo? (optional)</h2>
      <p className="name-entry-sub">
        Used as your cursor and tile. Skip and we'll show your initials instead.
      </p>

      <div className="photo-stage">
        {avatar ? (
          <img className="photo-preview" src={avatar} alt="Your photo" />
        ) : status === 'live' ? (
          <video ref={attachVideo} className="photo-preview live" playsInline muted autoPlay />
        ) : (
          <div className="photo-placeholder">
            <span>{getInitials(name)}</span>
          </div>
        )}
      </div>

      {err && <div className="photo-error">{err}</div>}

      <div className="name-entry-actions photo-actions">
        <button type="button" onClick={onBack}>Back</button>
        {avatar ? (
          <>
            <button type="button" onClick={retake}>Retake</button>
            <button type="button" className="primary" onClick={onContinue}>Continue →</button>
          </>
        ) : status === 'live' ? (
          <>
            <button type="button" onClick={onSkip}>Skip</button>
            <button type="button" className="primary" onClick={snap}>Capture</button>
          </>
        ) : (
          <>
            <button type="button" onClick={onSkip}>Skip</button>
            <button type="button" className="primary" onClick={startCam}>Take Photo</button>
          </>
        )}
      </div>
    </>
  )
}

function getInitials(name) {
  const parts = (name || '').trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0][0].toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}
