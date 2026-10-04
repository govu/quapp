const { app, BrowserWindow, shell, Menu } = require('electron')
const { fork } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const isDev = process.argv.includes('--dev') || !app.isPackaged
const DEV_URL = process.env.QUAPP_DEV_URL || 'http://localhost:5199'

// GPU on by default — Electron auto-falls back to software GL if the GPU
// process crashes repeatedly (broken VM/RDP drivers); QUAPP_GPU=0 forces
// software rendering for those environments
if (process.env.QUAPP_GPU === '0') app.disableHardwareAcceleration()

// keep the renderer live when occluded/minimized — typing indicators,
// presence and history replay must not throttle; same flags Slack/Discord use
app.commandLine.appendSwitch('disable-background-timer-throttling')
app.commandLine.appendSwitch('disable-renderer-backgrounding')
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
app.commandLine.appendSwitch('force_high_performance_gpu')

// single instance — a second launch focuses the open window
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) app.quit()

// ---------- quappd bridge daemon ----------
// The daemon owns the WhatsApp session: ws://127.0.0.1:8765 for commands,
// http://127.0.0.1:8766 for decrypted media. Sessions persist in userData.
let daemon = null
let quitting = false

function daemonPath() {
  const rel = path.join('bridge', 'dist', 'quappd.cjs')
  return app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked', rel)
    : path.join(__dirname, '..', rel)
}

const daemonLog = () => path.join(app.getPath('userData'), 'quappd-spawn.log')
// per-launch token the daemon writes to <data>/token.txt; the renderer needs
// it to connect — read with a small retry since the daemon writes on boot
function daemonToken() {
  for (let i = 0; i < 40; i++) {
    try {
      const t = fs.readFileSync(path.join(app.getPath('userData'), 'quappd', 'token.txt'), 'utf8').trim()
      if (t) return t
    } catch { /* not written yet */ }
    const end = Date.now() + 250
    while (Date.now() < end) { /* spin — boot-time, sub-second */ }
  }
  return ''
}
const dlog = (line) => {
  try { fs.appendFileSync(daemonLog(), `[${new Date().toISOString()}] ${line}\n`) } catch { /* ignore */ }
}

function startDaemon() {
  const script = daemonPath()
  dlog(`startDaemon script=${script} exists=${fs.existsSync(script)} packaged=${app.isPackaged}`)
  if (!fs.existsSync(script) || daemon) return
  try {
    daemon = fork(script, [], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        QUAPP_HOST: '127.0.0.1',
        QUAPP_WS_PORT: '8765',
        QUAPP_MEDIA_PORT: '8766',
        QUAPP_DATA: path.join(app.getPath('userData'), 'quappd'),
        QUAPPD_DEV: isDev ? '1' : '0',
      },
      silent: true,
    })
  } catch (e) {
    dlog(`fork threw: ${e?.stack ?? e}`)
    return
  }
  daemon.on('error', (e) => dlog(`daemon error: ${e?.message}`))
  daemon.on('spawn', () => dlog(`daemon spawned pid=${daemon.pid}`))
  daemon.stdout.on('data', (d) => { dlog(`out: ${String(d).trimEnd()}`); console.log(String(d).trimEnd()) })
  daemon.stderr.on('data', (d) => { dlog(`err: ${String(d).trimEnd()}`); console.error(String(d).trimEnd()) })
  daemon.on('exit', (code, sig) => {
    dlog(`daemon exited code=${code} sig=${sig}`)
    daemon = null
    if (!quitting && code !== 0) setTimeout(startDaemon, 2500) // auto-restart on crash
  })
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 560,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#1c1c1e',
    title: 'Quapp',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    // hidden native titlebar — Windows draws caption buttons via the overlay;
    // Mica fills the frame behind the translucent sidebar (Win11, falls back
    // to the opaque backgroundColor elsewhere)
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#00000000', symbolColor: '#8e8e93', height: 40 },
    ...(process.platform === 'win32' && parseInt(process.versions.electron) >= 25 && require('node:os').release() >= '10.0.22000'
      ? { backgroundMaterial: 'mica' }
      : {}),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
    },
  })

  win.once('ready-to-show', () => win.show())

  // links (previews, attached urls) open in the system browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url) && !url.startsWith('http://127.0.0.1:8766')) shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://') && url !== DEV_URL && !url.startsWith('http://127.0.0.1:8766')) {
      e.preventDefault()
      shell.openExternal(url)
    }
  })

  // ⌘K / ⌘F etc. reach the page; keep standard editing accelerators
  Menu.setApplicationMenu(null)

  if (isDev) win.loadURL(DEV_URL)
  else win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'), {
    query: {
      token: daemonToken(),
      // let the renderer relax its sidebar material when real Mica is behind it
      mica: win.getBackgroundMaterial?.() === 'mica' ? '1' : '0',
    },
  })
}

app.whenReady().then(() => {
  startDaemon()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('second-instance', () => {
  const [win] = BrowserWindow.getAllWindows()
  if (win) {
    if (win.isMinimized()) win.restore()
    win.focus()
  }
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  quitting = true
  daemon?.kill()
})
