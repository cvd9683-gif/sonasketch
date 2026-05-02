import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import basicSsl from '@vitejs/plugin-basic-ssl'
import os from 'node:os'
import { attachSonaSocket } from './server/sonaSocket.js'

const PORT = 5173

// HTTPS is needed for getUserMedia on the LAN. Browsers expose
// navigator.mediaDevices only on secure origins (https / localhost).
// SONA_HTTP=1 npm run dev disables this if you only need localhost.
const USE_HTTPS = process.env.SONA_HTTP !== '1'

// All non-internal IPv4 interfaces. The first match is what we promote
// in the share-this-link banner; the rest are listed in case the user is
// on a hotspot / VPN / multiple networks.
function getLanIPs() {
  const out = []
  const ifaces = os.networkInterfaces()
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        out.push({ name, address: iface.address })
      }
    }
  }
  return out
}

const sonaSocketPlugin = () => ({
  name: 'sonasketch-socket',
  configureServer(server) {
    if (!server.httpServer) return
    server.httpServer.once('listening', () => {
      attachSonaSocket(server.httpServer)
    })
  },
})

const lanBannerPlugin = () => ({
  name: 'sonasketch-lan-banner',
  configureServer(server) {
    if (!server.httpServer) return
    server.httpServer.once('listening', () => {
      const addr = server.httpServer.address()
      const port = (addr && typeof addr === 'object' && addr.port) || PORT
      const ips = getLanIPs()
      const primary = ips[0]
      const scheme = USE_HTTPS ? 'https' : 'http'
      const url = primary ? `${scheme}://${primary.address}:${port}` : null

      // Print a few blank lines to push it past Vite's banner.
      setTimeout(() => {
        const line = '─'.repeat(60)
        console.log('\n' + line)
        console.log('  SonaSketch — share this with your roommate (same Wi-Fi):')
        if (url) {
          console.log(`\n    \x1b[1;36m${url}\x1b[0m\n`)
        } else {
          console.log('    (no LAN IP detected — open localhost yourself)')
        }
        if (ips.length > 1) {
          console.log('  Other interfaces:')
          for (const i of ips.slice(1)) {
            console.log(`    ${scheme}://${i.address}:${port}    [${i.name}]`)
          }
        }
        if (USE_HTTPS) {
          console.log('  ⚠ Self-signed cert: both browsers will show a')
          console.log('    "Not secure" warning the first time. Click')
          console.log('    "Advanced → Proceed". Camera needs HTTPS on LAN.')
        }
        console.log(line + '\n')
      }, 50)
    })
  },
})

export default defineConfig({
  plugins: [
    react(),
    ...(USE_HTTPS ? [basicSsl()] : []),
    sonaSocketPlugin(),
    lanBannerPlugin(),
  ],
  server: {
    host: '0.0.0.0',
    port: PORT,
    // strictPort:false lets Vite walk to 5174/5175/… if 5173 is taken
    // (e.g. by another local prototype). The LAN banner reads the actual
    // bound port from httpServer.address(), so the printed URL stays right.
    strictPort: false,
  },
})
