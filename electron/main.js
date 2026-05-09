'use strict'

const { app, BrowserWindow, globalShortcut, screen, ipcMain, Tray, Menu, nativeImage, shell, dialog } = require('electron')
const path = require('path')
const fs = require('fs')
const { spawn } = require('child_process')
const net = require('net')
const http = require('http')
const https = require('https')

const isDev = !app.isPackaged

// ─── App-level state ──────────────────────────────────────────────────────────
let obsEnabled = true
let sessionSaveEnabled = false
let tray = null
let pendingUpdate = null  // { version, downloadUrl }
let obsServer = null

// ─── Session state ────────────────────────────────────────────────────────────
const session = {
  wins: 0,
  losses: 0,
  streak: 0,
  mmr: 0,
  lastMatchHandled: false,
}

// ─── Session history ──────────────────────────────────────────────────────────
const sessionHistory = []
let matchCount = 0
let historyWindow = null

let mainWindow = null
let overlayVisible = true
let overlayState = 'LEFT' // 'LEFT' | 'RIGHT' | 'HIDDEN'
let statsSocket = null
let reconnectTimer = null
let uiThrottle = null
let localPlayerName = null    // cached so podium screen (no Target) still resolves the player
let localPlayerPlatform = null // e.g. 'steam', 'epic', 'psn', 'xbl'
let localPlayerId = null       // platform-specific id extracted from PrimaryId
let currentPlaylist = null     // 'duel' | 'double' | 'standard' — detected from team sizes
let mmrIdentified = false      // true once the local player's platform/id are known

const UI_THROTTLE_MS = 100    // max 10 fps

// ─── History broadcast ────────────────────────────────────────────────────────
function broadcastHistory() {
  const snapshot = [...sessionHistory]
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('history:update', snapshot)
  }
  if (historyWindow && !historyWindow.isDestroyed()) {
    historyWindow.webContents.send('history:update', snapshot)
  }
}

// ─── History window ───────────────────────────────────────────────────────────
function createHistoryWindow() {
  historyWindow = new BrowserWindow({
    width: 660,
    height: 560,
    frame: true,
    transparent: false,
    alwaysOnTop: false,
    focusable: true,
    skipTaskbar: false,
    resizable: true,
    backgroundColor: '#111827',
    title: 'RL Live Tracker — Historique',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      devTools: isDev,
    },
  })

  historyWindow.setMenu(null)

  if (isDev) {
    historyWindow.loadURL('http://localhost:5173/?view=history')
  } else {
    historyWindow.loadFile(path.join(__dirname, '../dist/index.html'), { query: { view: 'history' } })
  }

  historyWindow.webContents.on('did-finish-load', () => {
    if (historyWindow && !historyWindow.isDestroyed()) {
      historyWindow.webContents.send('history:update', [...sessionHistory])
    }
  })

  historyWindow.on('closed', () => {
    historyWindow = null
  })
}

// ─── Window creation ──────────────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 320,
    height: 80,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    focusable: false,
    skipTaskbar: true,
    resizable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      devTools: true,
    },
  })

  mainWindow.setIgnoreMouseEvents(true)
  applyOverlayState()
  // Highest always-on-top level to stay above game window
  mainWindow.setAlwaysOnTop(true, 'screen-saver')

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173')
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

// ─── Overlay state (LEFT / RIGHT / HIDDEN) ───────────────────────────────────────
const OVERLAY_MARGIN = 20
const OVERLAY_STATES = ['LEFT', 'RIGHT', 'HIDDEN']

function applyOverlayState() {
  if (!mainWindow) return
  if (overlayState === 'HIDDEN') {
    mainWindow.hide()
    return
  }
  const { width } = screen.getPrimaryDisplay().workAreaSize
  const [winW] = mainWindow.getSize()
  const x = overlayState === 'LEFT'
    ? OVERLAY_MARGIN
    : width - winW - OVERLAY_MARGIN
  mainWindow.setPosition(x, OVERLAY_MARGIN)
  mainWindow.show()
}

// ─── Throttled IPC send ───────────────────────────────────────────────────────
function scheduleUIUpdate() {
  if (uiThrottle) return
  uiThrottle = setTimeout(() => {
    uiThrottle = null
    if (mainWindow && !mainWindow.isDestroyed()) {
      const { lastMatchHandled: _ignored, ...stats } = session
      mainWindow.webContents.send('stats:update', stats)
    }
  }, UI_THROTTLE_MS)
}

// ─── Stats API TCP socket ─────────────────────────────────────────────────────
function connectStatsAPI() {
  if (statsSocket) {
    statsSocket.destroy()
    statsSocket = null
  }

  const socket = new net.Socket()
  statsSocket = socket
  let buffer = ''

  socket.connect(49123, '127.0.0.1')

  socket.on('connect', () => {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
  })

  socket.on('data', (chunk) => {
    try {
      handleStatsEvent(JSON.parse(chunk.toString('utf8')))
    } catch (_) {
      // Skip malformed JSON
    }
  })

  socket.on('close', () => {
    statsSocket = null
    scheduleReconnect()
  })

  socket.on('error', () => {
    socket.destroy()
    statsSocket = null
    scheduleReconnect()
  })
}

function scheduleReconnect() {
  if (reconnectTimer) return
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    connectStatsAPI()
  }, 5000)
}

// ─── MMR fetch (Tracker Network) ─────────────────────────────────────────────

/**
 * Parse a Stats API PrimaryId such as "Steam|76561198176453281|0".
 * Returns { platform, id } or null for bots/unknown.
 */
function parsePrimaryId(primaryId) {
  const parts = (primaryId ?? '').split('|')
  if (parts.length < 2) return null
  const map = { steam: 'steam', epic: 'epic', psn: 'psn', xbl: 'xbl', switch: 'switch' }
  const platform = map[parts[0].toLowerCase()]
  const id = parts[1]
  if (!platform || !id || id === '0') return null
  return { platform, id }
}

/** Infer playlist from max players per team: 1→duel, 2→double, 3+→standard */
function detectPlaylist(players) {
  const counts = {}
  for (const p of players) {
    const t = p.TeamNum ?? p.teamNum ?? 0
    counts[t] = (counts[t] ?? 0) + 1
  }
  const max = Math.max(...Object.values(counts))
  if (max === 1) return 'duel'
  if (max === 2) return 'double'
  return 'standard'
}

async function fetchMMR(updateLastEntry = false) {
  if (!localPlayerPlatform || !localPlayerId) return
  try {
    const data = await fetchTrackerProfile(localPlayerPlatform, localPlayerId)
    const segments = data?.segments ?? []
    const playlistLabel = PLAYLIST_LABELS[currentPlaylist ?? 'standard']
    const seg = segments.find((s) => s.type === 'playlist' && s.metadata?.name === playlistLabel)
    const mmr = seg?.stats?.rating?.value ?? 0
    if (mmr > 0) {
      session.mmr = Math.round(mmr)
      scheduleUIUpdate()
      // Update the last history entry's MMR with the post-match value
      if (updateLastEntry && sessionHistory.length > 0) {
        sessionHistory[sessionHistory.length - 1].mmr = session.mmr
        broadcastHistory()
      }
    }
  } catch (_) {
    // TRN unavailable or rate-limited — keep existing value
  }
}

/** Fetch MMR once; called at first player identification and after each match. */
function scheduleMmrFetch() {
  if (!mmrIdentified) return
  fetchMMR()
}

/** Direct HTTPS fetch to tracker.gg — no child_process, no curl. */
function fetchTrackerProfile(platform, id) {
  return new Promise((resolve, reject) => {
    const url = `https://api.tracker.gg/api/v2/rocket-league/standard/profile/${encodeURIComponent(platform)}/${encodeURIComponent(id)}`
    const req = https.get(
      url,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36',
          'Accept': 'application/json',
          'Accept-Language': 'en-US,en;q=0.9',
          'Referer': 'https://rocketleague.tracker.network/',
          'Origin': 'https://rocketleague.tracker.network',
        },
        timeout: 10_000,
      },
      (res) => {
        let raw = ''
        res.on('data', (chunk) => { raw += chunk })
        res.on('end', () => {
          if (!raw) return reject(new Error('Empty response'))
          let parsed
          try { parsed = JSON.parse(raw) } catch (e) { return reject(e) }
          if (parsed?.errors?.length) return reject(new Error(parsed.errors[0]?.message ?? 'TRN error'))
          resolve(parsed?.data ?? null)
        })
      }
    )
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(new Error('Request timeout')) })
  })
}

/** Playlist name as used by tracker.gg in the segments array */
const PLAYLIST_LABELS = {
  duel: 'Ranked Duel 1v1',
  double: 'Ranked Doubles 2v2',
  standard: 'Ranked Standard 3v3',
}

// ─── Event handling ───────────────────────────────────────────────────────────
function handleStatsEvent(event) {
  const name = event.Event ?? event.event ?? ''
  if (name !== 'UpdateState') return

  // Data field is a JSON-encoded string — must be parsed a second time
  let data
  try {
    const raw = event.Data ?? event.data ?? ''
    data = typeof raw === 'string' ? JSON.parse(raw) : raw
  } catch (_) {
    return
  }

  const game = data.Game ?? data.game ?? {}
  const hasWinner = game.bHasWinner === true

  // Players is an array
  const players = Array.isArray(data.Players) ? data.Players
    : Array.isArray(data.players) ? data.players
    : []

  // Detect current playlist from team sizes so we read the right MMR bucket
  if (players.length > 0) currentPlaylist = detectPlaylist(players)

  // Local player is identified via Game.Target (set by the plugin).
  // Cache the name so we can still find the player when Target disappears (e.g. defeat podium).
  const target = game.Target ?? game.target ?? null
  let localPlayer = target
    ? players.find((p) => p.Shortcut === target.Shortcut || p.Name === target.Name) ?? null
    : null

  if (localPlayer) {
    localPlayerName = localPlayer.Name ?? localPlayer.name ?? localPlayerName
  } else if (localPlayerName) {
    localPlayer = players.find((p) => (p.Name ?? p.name) === localPlayerName) ?? null
  }

  if (localPlayer) {
    // Cache PrimaryId on first identification, then fetch MMR immediately
    const pid = localPlayer.PrimaryId ?? localPlayer.primaryId ?? ''
    const parsed = parsePrimaryId(pid)
    if (parsed && !mmrIdentified) {
      localPlayerPlatform = parsed.platform
      localPlayerId = parsed.id
      mmrIdentified = true
      fetchMMR()
    }
  }

  if (hasWinner && !session.lastMatchHandled) {
    session.lastMatchHandled = true

    // Winner is a team name string — resolve it to a TeamNum via Teams array
    const winnerName = game.Winner ?? game.winner ?? ''
    const teams = Array.isArray(game.Teams) ? game.Teams
      : Array.isArray(game.teams) ? game.teams
      : []
    const winnerTeamObj = teams.find((t) => (t.Name ?? t.name) === winnerName)
    const winnerTeam = winnerTeamObj != null ? (winnerTeamObj.TeamNum ?? winnerTeamObj.teamNum ?? -1) : -1
    const localTeam = localPlayer ? (localPlayer.TeamNum ?? localPlayer.teamNum ?? -1) : -1

    if (winnerTeam !== -1 && localTeam !== -1) {
      const isWin = winnerTeam === localTeam
      if (isWin) {
        session.wins++
        session.streak = session.streak > 0 ? session.streak + 1 : 1
      } else {
        session.losses++
        session.streak = session.streak < 0 ? session.streak - 1 : -1
      }
      // Record match in session history (MMR will be updated after fetch)
      matchCount++
      sessionHistory.push({
        id: matchCount,
        timestamp: Date.now(),
        result: isWin ? 'win' : 'loss',
        mmr: session.mmr,
        wins: session.wins,
        losses: session.losses,
        streak: session.streak,
      })
      broadcastHistory()
    }
    // Fetch updated MMR after each match (will update last history entry)
    fetchMMR(true)
  }

  // Reset handled flag when a new game starts (no winner yet)
  if (!hasWinner) {
    session.lastMatchHandled = false
  }

  scheduleUIUpdate()
}

// ─── OBS HTTP server ──────────────────────────────────────────────────────────
const OBS_OVERLAY_HTML = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>RL Overlay</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:transparent;font-family:'Segoe UI',system-ui,sans-serif;color:#fff;padding:10px}
#overlay{display:inline-flex;gap:14px;align-items:center;background:rgba(0,0,0,.65);
  backdrop-filter:blur(4px);border-radius:8px;padding:8px 14px}
.stat{display:flex;flex-direction:column;align-items:center;min-width:32px}
.lbl{font-size:9px;letter-spacing:1.5px;text-transform:uppercase;opacity:.6;margin-bottom:2px}
.val{font-size:20px;font-weight:700;line-height:1}
.w{color:#4ade80}.l{color:#f87171}.pos{color:#4ade80}.neg{color:#f87171}
</style></head><body>
<div id="overlay">
  <div class="stat"><div class="lbl">W</div><div class="val w" id="wins">0</div></div>
  <div class="stat"><div class="lbl">L</div><div class="val l" id="losses">0</div></div>
  <div class="stat"><div class="lbl">Streak</div><div class="val" id="streak">0</div></div>
  <div class="stat"><div class="lbl">MMR</div><div class="val" id="mmr">—</div></div>
</div>
<script>
let prev=null;
async function tick(){
  try{
    const r=await fetch('/stats');
    const d=await r.json();
    const k=JSON.stringify(d);
    if(k===prev)return;
    prev=k;
    document.getElementById('wins').textContent=d.wins;
    document.getElementById('losses').textContent=d.losses;
    const s=document.getElementById('streak');
    s.textContent=d.streak>0?'+'+d.streak:String(d.streak);
    s.className='val '+(d.streak>0?'pos':d.streak<0?'neg':'');
    document.getElementById('mmr').textContent=d.mmr||'—';
  }catch(_){}
}
tick();
setInterval(tick,1000);
</script></body></html>`

function startOBSServer() {
  if (obsServer) return
  const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', 'null')

    if (req.url === '/history') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(sessionHistory))
      return
    }

    if (req.url === '/stats') {
      const { lastMatchHandled: _ignored, ...stats } = session
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(stats))
      return
    }

    if (req.url === '/overlay' || req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(OBS_OVERLAY_HTML)
      return
    }

    res.writeHead(404)
    res.end()
  })

  // Bind to loopback only — never expose to the network
  server.listen(3000, '127.0.0.1')
  server.on('error', () => {
    obsServer = null  // Port 3000 already in use; OBS mode unavailable this run
  })
  obsServer = server
}

function stopOBSServer() {
  if (!obsServer) return
  obsServer.close()
  obsServer = null
}

// ─── Preferences ─────────────────────────────────────────────────────────────
function loadPrefs() {
  try {
    return JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'preferences.json'), 'utf8'))
  } catch (_) { return {} }
}

function savePrefs(data) {
  try {
    fs.writeFileSync(path.join(app.getPath('userData'), 'preferences.json'), JSON.stringify(data, null, 2))
  } catch (_) {}
}

// ─── Session persistence ──────────────────────────────────────────────────────
function saveSessionOnQuit() {
  if (!sessionSaveEnabled || sessionHistory.length === 0) return
  try {
    const dir = path.join(app.getPath('userData'), 'sessions')
    fs.mkdirSync(dir, { recursive: true })
    const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')
    fs.writeFileSync(
      path.join(dir, `session-${stamp}.json`),
      JSON.stringify({
        wins: session.wins, losses: session.losses,
        streak: session.streak, mmr: session.mmr,
        history: sessionHistory,
      }, null, 2)
    )
  } catch (_) {}
}

// ─── Tray ─────────────────────────────────────────────────────────────────────
function buildTrayMenu() {
  const version = app.getVersion()
  const items = [
    {
      label: "Activer l'overlay OBS",
      type: 'checkbox',
      checked: obsEnabled,
      click(item) {
        obsEnabled = item.checked
        savePrefs({ obsEnabled, sessionSaveEnabled })
        item.checked ? startOBSServer() : stopOBSServer()
        refreshTrayMenu()
      },
    },
    {
      label: 'Activer la sauvegarde des sessions',
      type: 'checkbox',
      checked: sessionSaveEnabled,
      click(item) {
        sessionSaveEnabled = item.checked
        savePrefs({ obsEnabled, sessionSaveEnabled })
        refreshTrayMenu()
      },
    },
    { type: 'separator' },
  ]

  if (pendingUpdate) {
    items.push({
      label: `Mettre à jour vers v${pendingUpdate.version}`,
      click: () => applyUpdate(),
    })
    items.push({ type: 'separator' })
  }

  items.push({ label: 'Quitter', click: () => app.quit() })
  items.push({ type: 'separator' })
  items.push({ label: `v${version}`, enabled: false })

  return Menu.buildFromTemplate(items)
}

function refreshTrayMenu() {
  if (tray && !tray.isDestroyed()) tray.setContextMenu(buildTrayMenu())
}

function createTrayIcon() {
  const iconPath = path.join(__dirname, '../assets/tray-icon.png')
  const icon = fs.existsSync(iconPath)
    ? nativeImage.createFromPath(iconPath)
    : nativeImage.createEmpty()

  return icon.isEmpty()
    ? nativeImage.createEmpty()
    : icon.resize({ width: 16, height: 16 })
}

function createTray() {
  const icon = createTrayIcon()

  tray = new Tray(icon)
  tray.setToolTip('RL Live Tracker')
  tray.setContextMenu(buildTrayMenu())

  tray.on('double-click', () => {
    if (!historyWindow || historyWindow.isDestroyed()) {
      createHistoryWindow()
    } else if (historyWindow.isVisible()) {
      historyWindow.hide()
    } else {
      historyWindow.show()
    }
  })
}

// ─── Auto-updater (portable, GitHub releases) ─────────────────────────────────
function isNewer(a, b) {
  const p = (v) => v.split('.').map(Number)
  const [aM, am, ap] = p(a)
  const [bM, bm, bp] = p(b)
  return aM !== bM ? aM > bM : am !== bm ? am > bm : ap > bp
}

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http
    const req = mod.get(
      url,
      { headers: { 'User-Agent': `rl-live-tracker/${app.getVersion()}` }, timeout: 10_000 },
      (res) => {
        let raw = ''
        res.on('data', (c) => { raw += c })
        res.on('end', () => { try { resolve(JSON.parse(raw)) } catch (e) { reject(e) } })
      }
    )
    req.on('error', reject)
    req.on('timeout', () => req.destroy(new Error('timeout')))
  })
}

function downloadFileTo(url, dest) {
  return new Promise((resolve, reject) => {
    const attempt = (currentUrl) => {
      const mod = currentUrl.startsWith('https') ? https : http
      mod.get(
        currentUrl,
        { headers: { 'User-Agent': `rl-live-tracker/${app.getVersion()}` } },
        (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            return attempt(res.headers.location)
          }
          if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`))
          const file = fs.createWriteStream(dest)
          res.pipe(file)
          file.on('finish', () => file.close(resolve))
          file.on('error', reject)
        }
      ).on('error', reject)
    }
    attempt(url)
  })
}

async function checkForUpdates() {
  if (isDev) return
  try {
    const data = await fetchJSON('https://api.github.com/repos/aubriand/rl-live-tracker/releases/latest')
    const latest = (data.tag_name ?? '').replace(/^v/, '')
    const current = app.getVersion()
    console.log(`Latest release: ${latest}, current version: ${current}`)
    if (!latest || !isNewer(latest, current)) return

    const asset = data.assets?.find((a) => /\.exe$/i.test(a.name))
    if (!asset) return

    pendingUpdate = { version: latest, downloadUrl: asset.browser_download_url }
    refreshTrayMenu()
    if (tray && !tray.isDestroyed()) {
      tray.displayBalloon({
        title: 'RL Live Tracker',
        content: `Version ${latest} disponible. Ouvrez le menu pour mettre à jour.`,
        iconType: 'info',
      })
    }
  } catch (_) {
    // Network unavailable or GitHub API rate-limited — silently ignore
  }
}

function getUpdateTargetExePath() {
  const portableExe = process.env.PORTABLE_EXECUTABLE_FILE
  if (portableExe && fs.existsSync(portableExe)) {
    return portableExe
  }

  return app.getPath('exe')
}

async function applyUpdate() {
  if (!pendingUpdate) return
  const exePath = getUpdateTargetExePath()
  const exeDir = path.dirname(exePath)
  const newExePath = path.join(exeDir, `rl-live-tracker-${pendingUpdate.version}.exe`)
  const tmpExe = path.join(app.getPath('temp'), `rl-live-tracker-${pendingUpdate.version}.exe`)

  tray?.setToolTip('RL Live Tracker — Téléchargement…')
  try {
    await downloadFileTo(pendingUpdate.downloadUrl, tmpExe)
  } catch (err) {
    tray?.setToolTip('RL Live Tracker')
    dialog.showErrorBox('Erreur de mise à jour', `Impossible de télécharger la mise à jour.\n${err.message}`)
    return
  }
  tray?.setToolTip('RL Live Tracker')

  // Batch script: wait for current process to exit, copy new versioned exe, relaunch, clean up old exe
  const batchPath = path.join(app.getPath('temp'), 'rl-live-tracker-update.bat')
  const oldExeCleanup = exePath !== newExePath ? `del /f /q "${exePath}"` : ''
  const bat = [
    '@echo off',
    'timeout /t 2 /nobreak >nul',
    ':retry',
    `copy /y "${tmpExe}" "${newExePath}"`,
    'if errorlevel 1 (',
    '  timeout /t 1 /nobreak >nul',
    '  goto retry',
    ')',
    `start "" "${newExePath}"`,
    `del /f /q "${tmpExe}"`,
    oldExeCleanup,
    `del /f /q "%~f0"`,
  ].filter(Boolean).join('\r\n')

  try {
    fs.writeFileSync(batchPath, bat, 'utf8')
    spawn('cmd.exe', ['/c', batchPath], { detached: true, stdio: 'ignore' }).unref()
    app.quit()
  } catch (err) {
    dialog.showErrorBox('Erreur de mise à jour', `Impossible d'appliquer la mise à jour.\n${err.message}`)
  }
}

// ─── App lifecycle ────────────────────────────────────────────────────────────
process.on('uncaughtException', (err) => {
  dialog.showErrorBox('Erreur critique', err.stack ?? err.message)
})

app.whenReady().then(() => {
  const prefs = loadPrefs()
  obsEnabled = prefs.obsEnabled !== false
  sessionSaveEnabled = prefs.sessionSaveEnabled === true

  createWindow()
  createTray()
  connectStatsAPI()
  if (obsEnabled) startOBSServer()
  setTimeout(checkForUpdates, 5000)

  ipcMain.handle('history:get', () => [...sessionHistory])

  // F8 — cycle overlay: LEFT → RIGHT → HIDDEN → LEFT ...
  globalShortcut.register('F8', () => {
    if (!mainWindow) return
    const idx = OVERLAY_STATES.indexOf(overlayState)
    overlayState = OVERLAY_STATES[(idx + 1) % OVERLAY_STATES.length]
    applyOverlayState()
  })

  // F9 — toggle session history window
  globalShortcut.register('F9', () => {
    if (!historyWindow || historyWindow.isDestroyed()) {
      createHistoryWindow()
    } else if (historyWindow.isVisible()) {
      historyWindow.hide()
    } else {
      historyWindow.show()
    }
  })
})

app.on('window-all-closed', () => {
  // App lives in the system tray — do not auto-quit on window close
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
  if (uiThrottle) clearTimeout(uiThrottle)
  if (reconnectTimer) clearTimeout(reconnectTimer)
  if (statsSocket) statsSocket.destroy()
  if (historyWindow && !historyWindow.isDestroyed()) historyWindow.destroy()
  if (obsServer) obsServer.close()
  if (tray && !tray.isDestroyed()) tray.destroy()
  saveSessionOnQuit()
})
