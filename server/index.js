// SonaSketch production server.
//
// Serves the static Vite build from /dist and attaches the same
// Socket.IO logic the dev server uses, so multiplayer behaves
// identically in dev and prod. One process, one port — Render gives us
// $PORT and terminates TLS at the edge, so the app gets clean HTTPS
// without us having to manage certs.
//
// Local sanity check:
//   npm run build && npm start
//   open http://localhost:3000

import express from 'express'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { attachSonaSocket } from './sonaSocket.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const distDir = path.resolve(__dirname, '..', 'dist')
const port = Number(process.env.PORT) || 3000

const app = express()

// Long cache on hashed assets; HTML stays revalidated so deploys propagate.
app.use(express.static(distDir, {
  index: false,
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache')
    } else if (filePath.includes('/assets/')) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
    }
  },
}))

// SPA fallback: any non-asset, non-socket path returns index.html so
// React owns routing.
app.get('*', (_req, res) => {
  res.sendFile(path.join(distDir, 'index.html'))
})

const server = http.createServer(app)
attachSonaSocket(server)

server.listen(port, '0.0.0.0', () => {
  console.log(`SonaSketch listening on :${port}`)
})
