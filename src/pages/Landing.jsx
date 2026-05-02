import { useEffect, useRef, useState } from 'react'

// Ambient sketch background. Soft light traces — feels like fingers passing
// through fog. Two element kinds, both low opacity, slow cadence:
//   - dots: small pip, soft halo, gentle pulse, fade in/out
//   - curves: smooth Catmull-Rom-through-bezier paths that draw themselves,
//             with a faint pulse traveling along once, then fade
// Cadence is tuned so the field feels calm — only a handful visible at once.

const PALETTE = ['#7ee2ff', '#c97bff', '#ff8ec7', '#ffd97e', '#a08eff']

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)]
const rand = (a, b) => a + Math.random() * (b - a)

function makeDot(w, h) {
  return {
    kind: 'dot',
    x: rand(w * 0.1, w * 0.9),
    y: rand(h * 0.18, h * 0.85),
    r: rand(1.2, 2.6),
    color: pick(PALETTE),
    age: 0,
    life: rand(7, 11),
  }
}

// Generate a smooth gestural curve as a series of control points,
// rendered later via Catmull-Rom-through-bezier so every join is C1
// continuous (no jagged joins at all).
//
// Two personalities:
//   "drift" — a long arc gliding across the screen
//   "swirl" — a slow loop, like a finger curling once
function makeCurve(w, h) {
  // Inspired by actual canvas strokes: large gestural arcs that feel like
  // a single hand gliding across the screen. No tight squiggles.
  const personality = pick(['drift', 'drift', 'swirl'])
  const color = pick(PALETTE)
  const ctrl = []

  if (personality === 'drift') {
    // Spans nearly the full screen edge-to-edge with one or two gentle
    // bends — graceful, not a generated squiggle.
    const startX = rand(-0.1, 0.1) * w
    const endX = rand(0.9, 1.1) * w
    const baseY = rand(0.2, 0.85) * h
    const drift = rand(-h * 0.28, h * 0.28)
    const ctrlCount = 4
    for (let i = 0; i <= ctrlCount; i++) {
      const t = i / ctrlCount
      ctrl.push({
        x: startX + (endX - startX) * t + rand(-w * 0.025, w * 0.025),
        y: baseY + drift * t + rand(-h * 0.06, h * 0.06),
      })
    }
  } else {
    // swirl: a slow large curl, much bigger than before
    const cx = rand(0.25, 0.75) * w
    const cy = rand(0.3, 0.7) * h
    const ax = rand(140, 280)
    const ay = rand(110, 220)
    const ctrlCount = 7
    const startA = Math.random() * Math.PI * 2
    for (let i = 0; i <= ctrlCount; i++) {
      const t = i / ctrlCount
      const a = startA + t * (Math.PI * 1.6)
      ctrl.push({
        x: cx + Math.cos(a) * ax * (1 - t * 0.2),
        y: cy + Math.sin(a) * ay * (1 - t * 0.2),
      })
    }
  }

  // Per-curve breath: gentle slow translation so finished curves still
  // drift, like ink in still water.
  const driftAngle = Math.random() * Math.PI * 2
  const driftSpeed = rand(2, 5) // px/sec, very slow
  return {
    kind: 'curve',
    color,
    ctrl,
    age: 0,
    drawDur: rand(7, 11),
    pulseStart: rand(6, 9),
    life: rand(18, 26),
    driftDX: Math.cos(driftAngle) * driftSpeed,
    driftDY: Math.sin(driftAngle) * driftSpeed,
  }
}

function hexToRgba(hex, alpha) {
  let h = hex.replace('#', '')
  if (h.length === 3) h = h.split('').map((c) => c + c).join('')
  const r = parseInt(h.slice(0, 2), 16)
  const g = parseInt(h.slice(2, 4), 16)
  const b = parseInt(h.slice(4, 6), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

// Render a smooth curve through the control points using Catmull-Rom→cubic-bezier.
// Stops drawing at progress `t` (0..1) so the curve appears to draw itself.
function drawSmoothCurve(ctx, ctrl, t) {
  if (ctrl.length < 2) return
  const totalSegs = ctrl.length - 1
  const fullSegs = Math.floor(totalSegs * t)
  const partialT = totalSegs * t - fullSegs
  if (fullSegs < 1 && partialT === 0) return

  ctx.beginPath()
  ctx.moveTo(ctrl[0].x, ctrl[0].y)

  const segDraw = (i, endT) => {
    const p0 = ctrl[i - 1] || ctrl[i]
    const p1 = ctrl[i]
    const p2 = ctrl[i + 1]
    const p3 = ctrl[i + 2] || p2
    // Catmull-Rom → cubic Bezier control points
    const c1x = p1.x + (p2.x - p0.x) / 6
    const c1y = p1.y + (p2.y - p0.y) / 6
    const c2x = p2.x - (p3.x - p1.x) / 6
    const c2y = p2.y - (p3.y - p1.y) / 6
    if (endT >= 1) {
      ctx.bezierCurveTo(c1x, c1y, c2x, c2y, p2.x, p2.y)
    } else if (endT > 0) {
      // Approximate truncation by sampling
      const samples = 12
      for (let s = 1; s <= samples; s++) {
        const u = (s / samples) * endT
        const omu = 1 - u
        const x = omu * omu * omu * p1.x + 3 * omu * omu * u * c1x + 3 * omu * u * u * c2x + u * u * u * p2.x
        const y = omu * omu * omu * p1.y + 3 * omu * omu * u * c1y + 3 * omu * u * u * c2y + u * u * u * p2.y
        ctx.lineTo(x, y)
      }
    }
  }

  for (let i = 0; i < fullSegs; i++) segDraw(i, 1)
  if (partialT > 0 && fullSegs < totalSegs) segDraw(fullSegs, partialT)

  ctx.stroke()
}

// Sample the smooth curve at parameter t (0..1) to get the playback-pulse pos.
function sampleSmoothCurve(ctrl, t) {
  if (ctrl.length < 2) return { x: 0, y: 0 }
  const totalSegs = ctrl.length - 1
  const ft = t * totalSegs
  const i = Math.min(totalSegs - 1, Math.floor(ft))
  const u = ft - i
  const p0 = ctrl[i - 1] || ctrl[i]
  const p1 = ctrl[i]
  const p2 = ctrl[i + 1]
  const p3 = ctrl[i + 2] || p2
  const c1x = p1.x + (p2.x - p0.x) / 6
  const c1y = p1.y + (p2.y - p0.y) / 6
  const c2x = p2.x - (p3.x - p1.x) / 6
  const c2y = p2.y - (p3.y - p1.y) / 6
  const omu = 1 - u
  return {
    x: omu * omu * omu * p1.x + 3 * omu * omu * u * c1x + 3 * omu * u * u * c2x + u * u * u * p2.x,
    y: omu * omu * omu * p1.y + 3 * omu * omu * u * c1y + 3 * omu * u * u * c2y + u * u * u * p2.y,
  }
}

function drawSketch(ctx, s) {
  const t = s.age / s.life
  // ease in/out: smooth cosine over the first/last 25%
  const fadeIn = t < 0.25 ? 0.5 - 0.5 * Math.cos((t / 0.25) * Math.PI) : 1
  const fadeOut = t > 0.75 ? 0.5 - 0.5 * Math.cos(((1 - t) / 0.25) * Math.PI) : 1
  const fade = Math.min(fadeIn, fadeOut)

  if (s.kind === 'dot') {
    // Very gentle pulse — almost a slow breath
    const pulse = 0.5 + 0.5 * Math.sin(s.age * 1.0)
    const a = fade * (0.07 + pulse * 0.04)
    const haloR = s.r * 4.5
    const grad = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, haloR)
    grad.addColorStop(0, hexToRgba('#ffffff', a * 0.9))
    grad.addColorStop(0.4, hexToRgba(s.color, a * 0.7))
    grad.addColorStop(1, hexToRgba(s.color, 0))
    ctx.fillStyle = grad
    ctx.beginPath()
    ctx.arc(s.x, s.y, haloR, 0, Math.PI * 2)
    ctx.fill()
    return
  }

  // curve: progressive smooth draw
  const drawT = Math.min(1, s.age / s.drawDur)
  if (drawT < 0.01) return

  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'

  // outer atmospheric glow — extremely soft
  ctx.strokeStyle = hexToRgba(s.color, 0.025 * fade)
  ctx.lineWidth = 9
  drawSmoothCurve(ctx, s.ctrl, drawT)

  // mid soft halo
  ctx.strokeStyle = hexToRgba(s.color, 0.06 * fade)
  ctx.lineWidth = 3
  drawSmoothCurve(ctx, s.ctrl, drawT)

  // gentle thin core
  ctx.strokeStyle = hexToRgba(s.color, 0.14 * fade)
  ctx.lineWidth = 0.8
  drawSmoothCurve(ctx, s.ctrl, drawT)

  // playback pulse — very soft, barely noticeable
  if (s.age >= s.pulseStart && s.age < s.life) {
    const span = Math.max(0.001, s.life - s.pulseStart - 0.6)
    const pt = Math.min(1, (s.age - s.pulseStart) / span)
    const p = sampleSmoothCurve(s.ctrl, pt)
    const r = 18
    const grad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r)
    grad.addColorStop(0, hexToRgba('#ffffff', 0.12 * fade))
    grad.addColorStop(0.4, hexToRgba(s.color, 0.08 * fade))
    grad.addColorStop(1, hexToRgba(s.color, 0))
    ctx.fillStyle = grad
    ctx.beginPath()
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2)
    ctx.fill()
  }
}

function useSketchBackground(canvasRef) {
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')

    let dpr = Math.min(window.devicePixelRatio || 1, 2)
    let w = window.innerWidth
    let h = window.innerHeight

    const resize = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 2)
      w = window.innerWidth
      h = window.innerHeight
      canvas.width = w * dpr
      canvas.height = h * dpr
      canvas.style.width = `${w}px`
      canvas.style.height = `${h}px`
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    resize()
    window.addEventListener('resize', resize)

    const sketches = []

    // Seed with a curve already mid-draw and a dot, so the page feels
    // alive the moment it loads instead of waiting for the first spawn.
    const seedCurve = makeCurve(w, h)
    seedCurve.age = 1.5 // partway into the draw
    sketches.push(seedCurve)
    sketches.push(makeDot(w, h))

    let last = performance.now()
    let dotTimer = 4.0
    let curveTimer = 6.0
    let raf = 0

    // Keep the field very calm — at most one drift + one swirl, plus a dot.
    const MAX_DOTS = 1
    const MAX_CURVES = 2

    const loop = (now) => {
      const dt = Math.min(0.05, (now - last) / 1000)
      last = now

      // very gentle motion-blur — slower fade keeps traces around longer
      // but the per-element opacity is so low they read as ambient texture.
      ctx.fillStyle = 'rgba(7, 8, 13, 0.05)'
      ctx.fillRect(0, 0, w, h)

      ctx.globalCompositeOperation = 'lighter'

      const dotsCount = sketches.reduce((n, s) => n + (s.kind === 'dot' ? 1 : 0), 0)
      const curvesCount = sketches.length - dotsCount

      dotTimer -= dt
      if (dotTimer <= 0) {
        if (dotsCount < MAX_DOTS) sketches.push(makeDot(w, h))
        dotTimer = rand(5, 9)
      }
      curveTimer -= dt
      if (curveTimer <= 0) {
        if (curvesCount < MAX_CURVES) sketches.push(makeCurve(w, h))
        curveTimer = rand(9, 14)
      }

      for (const s of sketches) {
        s.age += dt
        // Curves slowly drift — gives a "breathing" feel without redraw cost.
        if (s.kind === 'curve' && s.driftDX) {
          for (const p of s.ctrl) { p.x += s.driftDX * dt; p.y += s.driftDY * dt }
        }
        drawSketch(ctx, s)
      }
      for (let i = sketches.length - 1; i >= 0; i--) {
        if (sketches[i].age >= sketches[i].life) sketches.splice(i, 1)
      }

      ctx.globalCompositeOperation = 'source-over'
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', resize)
    }
  }, [canvasRef])
}

export default function Landing({ onCreate, onJoin }) {
  const bgRef = useRef(null)
  const [code, setCode] = useState('')
  const [showJoin, setShowJoin] = useState(false)

  useSketchBackground(bgRef)

  const submitJoin = (e) => {
    e.preventDefault()
    const trimmed = code.trim()
    if (trimmed.length >= 3) onJoin(trimmed)
  }

  return (
    <div className="landing">
      <canvas ref={bgRef} className="landing-bg" />

      <div className="landing-foreground">
        <div className="landing-glass" aria-hidden="true" />
        <h1 className="title">SonaSketch</h1>
        <p className="subtitle">Draw the shape of sound together.</p>
        <p className="description">
          Move your hand to draw.<br />
          Drawings become sound.<br />
          Sound becomes a shared composition.
        </p>

        {!showJoin ? (
          <div className="actions">
            <button className="primary" onClick={onCreate}>Create Room</button>
            <button onClick={() => setShowJoin(true)}>Join Room</button>
          </div>
        ) : (
          <form className="join-form" onSubmit={submitJoin}>
            <input
              autoFocus
              placeholder="ROOM CODE"
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase().slice(0, 6))}
              maxLength={6}
            />
            <button className="primary" type="submit">Join</button>
            <button type="button" onClick={() => setShowJoin(false)}>Back</button>
          </form>
        )}
      </div>
    </div>
  )
}
