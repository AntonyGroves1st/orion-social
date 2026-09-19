'use strict'

/**
 * Orion Social Desktop Launcher
 * Serves the pre-built Vite/React web app + proxies /payments and /orion to local services.
 *
 * Multi-instance: if 5732 is busy, bind 5733+ so a second EXE gets its own origin/storage
 * (required for EXE↔EXE with two different logins on one PC).
 */

const http = require('http')
const fs = require('fs')
const path = require('path')
const { exec } = require('child_process')

const BASE_PORT = 5732
const MAX_PORT = 5741
const BIND_HOST = '0.0.0.0'
const PAYMENTS_TARGET = 'http://127.0.0.1:8791'
const BRIDGE_TARGET = 'http://127.0.0.1:8790'

/** pkg only bundles assets referenced as path.join(__dirname, 'www', 'literal') */
const INDEX_HTML = path.join(__dirname, 'www', 'index.html')

let activePort = BASE_PORT
let appUrl = `http://127.0.0.1:${BASE_PORT}`

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.map': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml',
  '.webmanifest': 'application/manifest+json',
}

function fatal(message) {
  console.error('\n  ERROR:', message)
  console.error('\n  If antivirus blocked OrionSocial.exe, add an exception and retry.\n')
  if (process.platform === 'win32') {
    try {
      exec('pause', { stdio: 'inherit' })
    } catch { /* ignore */ }
  }
  process.exit(1)
}

function verifyAssets() {
  try {
    fs.accessSync(INDEX_HTML, fs.constants.R_OK)
  } catch {
    const besideExe = path.join(path.dirname(process.execPath), 'www', 'index.html')
    try {
      fs.accessSync(besideExe, fs.constants.R_OK)
      return
    } catch { /* fall through */ }
    if (process.pkg) {
      fatal('App files missing from EXE. Rebuild with Build-OrionSocial-EXE.bat after web\\dist is staged.')
    }
    fatal('Missing packaging\\launcher\\www\\index.html — run Build-OrionSocial-EXE.bat first.')
  }
}

function readIndex() {
  let html
  try {
    html = fs.readFileSync(INDEX_HTML, 'utf8')
  } catch {
    const besideExe = path.join(path.dirname(process.execPath), 'www', 'index.html')
    html = fs.readFileSync(besideExe, 'utf8')
  }
  if (process.pkg && !html.includes('name="orion-shell"')) {
    html = html.replace(
      '</head>',
      '    <meta name="orion-shell" content="desktop" />\n  </head>',
    )
  }
  return html
}

function resolveAssetPath(urlPath) {
  const clean = urlPath.replace(/^\//, '') || 'index.html'
  const snapshotPath = path.join(__dirname, 'www', clean)
  try {
    fs.accessSync(snapshotPath, fs.constants.R_OK)
    return snapshotPath
  } catch {
    const besideExe = path.join(path.dirname(process.execPath), 'www', clean)
    return besideExe
  }
}

function serveFile(filePath, res) {
  const ext = path.extname(filePath).toLowerCase()
  const type = MIME[ext] || 'application/octet-stream'
  try {
    const data = fs.readFileSync(filePath)
    res.writeHead(200, {
      'Content-Type': type,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
    })
    res.end(data)
  } catch {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(readIndex())
  }
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

function proxyRequest(req, res, targetBase, stripPrefix) {
  const url = new URL(req.url || '/', appUrl)
  let pathAndQuery = url.pathname + url.search
  if (stripPrefix && pathAndQuery.startsWith(stripPrefix)) {
    pathAndQuery = pathAndQuery.slice(stripPrefix.length) || '/'
  }

  const target = new URL(pathAndQuery, targetBase)
  const headers = { ...req.headers, host: target.host }
  delete headers['host']

  const upstream = http.request(
    {
      hostname: target.hostname,
      port: target.port,
      path: target.pathname + target.search,
      method: req.method,
      headers,
    },
    (up) => {
      res.writeHead(up.statusCode || 502, up.headers)
      up.pipe(res)
    },
  )

  upstream.on('error', () => {
    const service = stripPrefix === '/payments' ? 'Orion Payments' : 'Orion Bridge'
    const port = stripPrefix === '/payments' ? '8791' : '8790'
    sendJson(res, 503, {
      error: {
        code: 'SERVICE_UNAVAILABLE',
        message: `${service} is not running on port ${port}. Start it from services/orion-payments (Stripe) or run Start-Orion-Social.bat for the full stack. Use Demo for local battle rehearsal without Stripe.`,
      },
    })
  })

  req.pipe(upstream)
}

function handleRequest(req, res) {
  const rawPath = (req.url || '/').split('?')[0]

  if (rawPath.startsWith('/payments')) {
    proxyRequest(req, res, PAYMENTS_TARGET, '/payments')
    return
  }

  if (rawPath.startsWith('/orion/')) {
    proxyRequest(req, res, BRIDGE_TARGET, '/orion')
    return
  }

  let urlPath = rawPath
  if (urlPath === '/') urlPath = '/index.html'

  const fullPath = path.resolve(resolveAssetPath(urlPath))
  const wwwRoot = path.resolve(path.join(__dirname, 'www'))
  if (!fullPath.startsWith(wwwRoot) && !fullPath.startsWith(path.resolve(path.join(path.dirname(process.execPath), 'www')))) {
    res.writeHead(403, { 'Content-Type': 'text/plain' })
    res.end('Forbidden')
    return
  }

  try {
    const stat = fs.statSync(fullPath)
    if (stat.isDirectory()) throw new Error('dir')
    serveFile(fullPath, res)
  } catch {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' })
    res.end(readIndex())
  }
}

function openBrowser(url) {
  const target = url || appUrl
  try {
    if (process.platform === 'win32') exec(`start "" "${target}"`)
    else if (process.platform === 'darwin') exec(`open "${target}"`)
    else exec(`xdg-open "${target}"`)
  } catch { /* ignore */ }
}

function waitForServer(url, attempt, done) {
  if (attempt > 40) {
    done(new Error('timeout'))
    return
  }
  const req = http.get(url, (res) => {
    res.resume()
    done(null)
  })
  req.on('error', () => setTimeout(() => waitForServer(url, attempt + 1, done), 250))
  req.setTimeout(1000, () => {
    req.destroy()
    setTimeout(() => waitForServer(url, attempt + 1, done), 250)
  })
}

function onListening() {
  console.log('\n  ORION SOCIAL — RUNNING')
  console.log(`  Local: ${appUrl}`)
  if (activePort !== BASE_PORT) {
    console.log(`  Second instance on port ${activePort} (separate login from :${BASE_PORT})`)
    console.log('  EXE↔EXE: sign in as a DIFFERENT account in this window, then join the same live room.')
  } else {
    console.log(`  LAN:   phones on same WiFi can use your invite link (port ${activePort})`)
    console.log('  Second EXE: run OrionSocial.exe again — it opens a new port for a second login.')
  }
  console.log('  Proxies: /payments -> :8791  /orion -> :8790')
  console.log('  Keep this window open. Stripe needs payments service on :8791.\n')

  waitForServer(appUrl, 0, (err) => {
    if (err) fatal('Server never became reachable — check antivirus/firewall.')
    openBrowser(appUrl)
  })
}

function tryListen(port) {
  if (port > MAX_PORT) {
    fatal(`No free port between ${BASE_PORT}–${MAX_PORT}. Close other OrionSocial.exe windows and retry.`)
    return
  }

  activePort = port
  appUrl = `http://127.0.0.1:${port}`
  const server = http.createServer(handleRequest)

  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.log(`  Port ${port} busy — trying ${port + 1} for a second desktop session…`)
      tryListen(port + 1)
      return
    }
    fatal(`Server could not start: ${err.message}`)
  })

  server.listen(port, BIND_HOST, onListening)
}

verifyAssets()
tryListen(BASE_PORT)

process.on('SIGINT', () => process.exit(0))
