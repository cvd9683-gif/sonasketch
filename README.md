# SonaSketch

**Draw the shape of sound together.**

Pinch in the air to sketch, and every line you draw becomes a musical loop. SonaSketch uses your webcam and hand tracking — no mouse, no instrument.

### ▶ [Try it live — sonasketch.onrender.com](https://sonasketch.onrender.com)

> Hosted on Render's free plan: if nobody has used it in a while, the first load can take up to a minute to wake up.

## How to play

1. Open the link in Chrome (desktop works best) and allow camera access.
2. **Pinch** your thumb and index finger together and move to draw. A quick pinch drops a dot.
3. Each sketch plays back as a loop in A minor — higher on screen is higher in pitch, smoother lines sound softer.
4. Switch to **Edit** mode (or press `E`), hover over a sketch and pinch to remove it. Press `C` to go back to Create.
5. Give a friend your room code to draw together.

Hand tracking runs in your browser and live video is never streamed. Others in the room see your cursor, your sketches, and the optional profile photo you take when joining.

## Run it yourself

```bash
npm install
npm run dev
```

Then open the URL printed in the terminal. The dev server uses a self-signed HTTPS certificate so the camera works on your local network; click through the browser warning the first time.

Production build:

```bash
npm run build
npm start   # serves dist/ + Socket.IO on http://localhost:3000
```

## Deploy your own copy

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/cvd9683-gif/sonasketch)

`render.yaml` configures everything.

## Built with

React + Vite · MediaPipe Hands · Tone.js · Socket.IO · Canvas 2D
