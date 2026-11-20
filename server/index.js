/**
 * server/index.js —— 通话服务本体（零外部依赖：只用 node:http / node:fs）
 * ============================================================================
 * 端口独立（默认 127.0.0.1:8790），**绝不碰 DSH 主端口**。
 * 对外只暴露四个东西：
 *   GET  /call.html            通话页面
 *   GET  /call.js              页面脚本
 *   POST /api/join             入场，换 peerId
 *   GET  /api/events           SSE 信令通道
 *   POST /api/signal           转发 offer / answer / candidate
 *   POST /api/frame            抽帧回传（JPEG base64）
 *   GET  /api/tone             测试音 WAV（证明"零驱动"音频轨真的能出声音）
 * ============================================================================
 */
import { createServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { readFile } from 'node:fs/promises'
import { networkInterfaces } from 'node:os'
import { extname, join, resolve, sep } from 'node:path'
import { SignalHub, tokenEquals } from './signaling.js'

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
}

const MAX_JSON_BYTES = 1_000_000
const MAX_FRAME_BYTES = 4_000_000

/** 16-bit 单声道 48k 的双音提示（P1 用它证明音频轨贯通；真 TTS 见 DESIGN 的 P3） */
function makeToneWav({ seconds = 1.6, rate = 48000 } = {}) {
  const frames = Math.floor(seconds * rate)
  const buf = Buffer.alloc(44 + frames * 2)
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + frames * 2, 4); buf.write('WAVE', 8)
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22)
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34)
  buf.write('data', 36); buf.writeUInt32LE(frames * 2, 40)
  for (let i = 0; i < frames; i++) {
    const t = i / rate
    const f = t < seconds / 2 ? 440 : 660
    const fade = Math.min(1, t / 0.08, (seconds - t) / 0.12)
    const v = Math.sin(2 * Math.PI * f * t) * 0.45 * Math.max(0, fade)
    buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2)
  }
  return buf
}

const TONE_WAV = makeToneWav()

function sendJson(res, code, value) {
  const body = JSON.stringify(value)
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

function readBody(req, limit) {
  return new Promise((resolvePromise, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > limit) { reject(new Error('body-too-large')); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => resolvePromise(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

async function readJson(req, limit = MAX_JSON_BYTES) {
  const raw = await readBody(req, limit)
  if (!raw.length) return {}
  return JSON.parse(raw.toString('utf8'))
}

/** 静态文件：只发白名单扩展名，且必须落在 staticDir 里（防 ../ 穿越） */
async function sendFile(res, staticDir, name) {
  const root = resolve(staticDir)
  const file = resolve(join(root, name))
  if (!file.startsWith(root + sep)) { sendJson(res, 403, { error: 'forbidden-path' }); return }
  if (!MIME[extname(file).toLowerCase()]) { sendJson(res, 404, { error: 'not-found' }); return }
  try {
    const data = await readFile(file)
    res.writeHead(200, { 'content-type': MIME[extname(file).toLowerCase()], 'cache-control': 'no-store' })
    res.end(data)
  } catch {
    sendJson(res, 404, { error: 'not-found' })
  }
}

function listen(server, host, port) {
  return new Promise((resolvePromise, reject) => {
    const onError = (e) => { server.off('listening', onOk); reject(e) }
    const onOk = () => { server.off('error', onError); resolvePromise(server.address().port) }
    server.once('error', onError)
    server.once('listening', onOk)
    server.listen(port, host)
  })
}

/**
 * 起服务。端口被占就往后挪（最多 6 次），并把真实端口返回给调用方。
 */
export async function startCallServer({
  host = '127.0.0.1',
  port = 8790,
  iceServers = [],
  turn = [],
  tokenTtlSec = 3600,
  oneShotToken = false,
  allowedOrigins = [],
  rateLimitPerMin = 30,
  publicBaseUrl = '',
  publicConfig = {},
  staticDir = '',
  log = () => {},
  onFrame = () => {},
  /** { pfx: Buffer, passphrase: string } —— 传了就上 HTTPS */
  tls = null,
  /** 允许局域网 Host（RFC1918）；配合 0.0.0.0 监听用 */
  allowLan = false,
  /**
   * 控制面板钩子（由插件注入）。管理端点只对回环开放：
   * { state(): any, activate(): Promise<any>, deactivate(): Promise<any>, savePaths(p): Promise<any> }
   */
  panel = null,
  /** 本机网卡地址（LAN IP 等）；本机通过这些地址访问时也算「自己人」 */
  localAddresses = [],
} = {}) {
  const hub = new SignalHub({ tokenTtlSec, oneShotToken, log })

  // ── 安全护栏 ────────────────────────────────────────────────────────────
  // 1) DNS rebinding：只认回环 Host，或 publicBaseUrl / 隧道动态写入的那个域
  let allowHost = (() => {
    if (!publicBaseUrl) return ''
    try { return new URL(publicBaseUrl).host.toLowerCase() } catch { return '' }
  })()
  const isPrivateV4 = (h) => /^(10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)$/.test(h)
  /** 管理端点只认「本机」：回环 + 本机当前所有网卡地址（网络切换后也能认出来） */
  const LOCAL_ADDRS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
  for (const a of localAddresses) { if (a) LOCAL_ADDRS.add(String(a)) }
  const isLoopback = (req) => {
    const a = String(req.socket?.remoteAddress || '')
    if (LOCAL_ADDRS.has(a)) return true
    // 换网之后新地址不在启动快照里：实时查一次网卡
    try {
      for (const list of Object.values(networkInterfaces())) {
        for (const x of list || []) {
          if (x && (x.address === a || (a.startsWith('::ffff:') && x.address === a.slice(7)))) return true
        }
      }
    } catch { /* 读不到就按非本机处理 */ }
    return false
  }
  const hostOk = (req) => {
    const raw = String(req.headers.host || '').toLowerCase().trim()
    if (!raw) return false
    const bare = raw.replace(/:\d+$/, '')
    if (bare === '127.0.0.1' || bare === 'localhost' || bare === '[::1]' || bare === '::1') return true
    if (allowLan && isPrivateV4(bare)) return true
    if (allowHost && raw === allowHost) return true
    if (allowHost && bare === allowHost.replace(/:\d+$/, '')) return true
    return false
  }

  // 2) CSRF：带 Origin 的请求必须同源，或在白名单里
  const originOk = (req) => {
    const origin = req.headers.origin
    if (!origin) return true // 导航请求 / 非浏览器客户端
    const clean = String(origin).replace(/\/$/, '')
    if (allowedOrigins.includes(clean)) return true
    try {
      const u = new URL(clean)
      const h = String(req.headers.host || '').toLowerCase().trim()
      if (h && (u.host.toLowerCase() === h || u.host.toLowerCase() === h.replace(/:\d+$/, ''))) return true
      // 同端口不同写法的回环互认
      const bareHost = h.replace(/:\d+$/, '')
      const bareOrigin = u.host.replace(/:\d+$/, '')
      if ((bareHost === '127.0.0.1' || bareHost === 'localhost') && (bareOrigin === '127.0.0.1' || bareOrigin === 'localhost')) return true
      if (allowHost && u.host.toLowerCase() === allowHost) return true
    } catch { /* 不是合法 Origin */ }
    return false
  }

  // 3) 令牌爆破：每 IP 每分钟 join 次数上限（0 = 关）
  const hits = new Map()
  const clientIp = (req) => String(req.socket?.remoteAddress || 'unknown')
  const rateOk = (req) => {
    if (!rateLimitPerMin) return true
    const ip = clientIp(req)
    const now = Date.now()
    const arr = (hits.get(ip) || []).filter((t) => now - t < 60_000)
    if (arr.length >= rateLimitPerMin) { hits.set(ip, arr); return false }
    arr.push(now)
    hits.set(ip, arr)
    if (hits.size > 256) {
      for (const [k, v] of hits) if (!v.length || now - v[v.length - 1] > 120_000) hits.delete(k)
    }
    return true
  }

  const onRequest = (req, res) => {
    void (async () => {
      const url = new URL(req.url || '/', `http://${req.headers.host || 'local'}`)
      const pathname = url.pathname

      // 安全闸门：Host 不对 → 421（挡 DNS rebinding）；Origin 不对 → 403（挡 CSRF）
      if (!hostOk(req)) return sendJson(res, 421, { error: 'bad-host' })
      if (!originOk(req)) return sendJson(res, 403, { error: 'bad-origin' })

      if (req.method === 'GET' && (pathname === '/' || pathname === '/call.html')) return sendFile(res, staticDir, 'call.html')
      if (req.method === 'GET' && pathname === '/call.js') return sendFile(res, staticDir, 'call.js')
      if (req.method === 'GET' && pathname === '/favicon.ico') { res.writeHead(204); return res.end() }

      if (req.method === 'GET' && pathname === '/api/health') {
        return sendJson(res, 200, { ok: true, rooms: hub.snapshot().length, uptimeSec: Math.round(process.uptime()) })
      }

      if (req.method === 'GET' && pathname === '/api/config') {
        return sendJson(res, 200, { iceServers, turn, maxFrameBytes: MAX_FRAME_BYTES, ...publicConfig })
      }

      // ── 控制面板：页面 + 管理端点（全部只对本机回环开放）──────────
      if (pathname === '/panel' || pathname === '/panel.html') {
        if (!isLoopback(req)) return sendJson(res, 403, { error: 'loopback-only' })
        return sendFile(res, staticDir, 'panel.html')
      }
      if (pathname === '/panel.js') {
        if (!isLoopback(req)) return sendJson(res, 403, { error: 'loopback-only' })
        return sendFile(res, staticDir, 'panel.js')
      }
      if (pathname.startsWith('/api/panel')) {
        if (!isLoopback(req)) return sendJson(res, 403, { error: 'loopback-only' })
        if (!panel) return sendJson(res, 503, { error: 'panel-not-mounted' })
        try {
          if (req.method === 'GET' && pathname === '/api/panel') {
            return sendJson(res, 200, await panel.state())
          }
          if (req.method === 'POST' && pathname === '/api/panel/activate') {
            return sendJson(res, 200, await panel.activate())
          }
          if (req.method === 'POST' && pathname === '/api/panel/deactivate') {
            return sendJson(res, 200, await panel.deactivate())
          }
          if (req.method === 'POST' && pathname === '/api/panel/paths') {
            const body = await readJson(req)
            return sendJson(res, 200, await panel.savePaths(body || {}))
          }
        } catch (e) {
          return sendJson(res, 500, { error: 'panel-failed', detail: String(e?.message ?? e) })
        }
        return sendJson(res, 404, { error: 'not-found', path: pathname })
      }

      if (req.method === 'GET' && pathname === '/api/tone') {
        res.writeHead(200, { 'content-type': 'audio/wav', 'cache-control': 'no-store' })
        return res.end(TONE_WAV)
      }

      // ── SSE：EventSource 不能带自定义头，令牌只能走查询串 ──
      if (req.method === 'GET' && pathname === '/api/events') {
        const room = url.searchParams.get('room')
        const token = url.searchParams.get('t')
        const peer = url.searchParams.get('peer')
        const r = hub.authorize(room, token)
        if (!r) return sendJson(res, 401, { error: 'bad-token' })
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        })
        res.write(': open\n\n')
        const off = hub.subscribe(room, peer, res)
        req.on('close', () => { try { off() } catch { /* ignore */ } res.end() })
        return undefined
      }

      if (req.method === 'POST' && pathname === '/api/join') {
        if (!rateOk(req)) return sendJson(res, 429, { error: 'rate-limited' })
        const body = await readJson(req)
        const out = hub.join(body.room, body.token, clientIp(req))
        return sendJson(res, out.ok ? 200 : 409, out)
      }

      if (req.method === 'POST' && pathname === '/api/signal') {
        const body = await readJson(req)
        if (!hub.authorize(body.room, body.token)) return sendJson(res, 401, { error: 'bad-token' })
        const out = hub.relay(body.room, String(body.from || ''), { type: body.type, data: body.data }, body.to)
        return sendJson(res, out.ok ? 200 : 400, out)
      }

      if (req.method === 'POST' && pathname === '/api/frame') {
        const body = await readJson(req, MAX_FRAME_BYTES)
        if (!hub.authorize(body.room, body.token)) return sendJson(res, 401, { error: 'bad-token' })
        const b64 = String(body.jpeg || '')
        if (!b64) return sendJson(res, 400, { error: 'empty-frame' })
        const data = Buffer.from(b64, 'base64')
        if (!data.length || data.length > MAX_FRAME_BYTES) return sendJson(res, 413, { error: 'frame-too-large' })
        onFrame(body.room, { data, width: Number(body.width) || 0, height: Number(body.height) || 0, at: Date.now(), peer: String(body.peer || '') })
        return sendJson(res, 200, { ok: true, bytes: data.length })
      }

      return sendJson(res, 404, { error: 'not-found', path: pathname })
    })().catch((e) => {
      log(`请求处理失败 ${req.method} ${req.url}：${e?.message ?? e}`)
      try { sendJson(res, 500, { error: 'internal', detail: String(e?.message ?? e) }) } catch { /* 头已发出 */ }
    })
  }

  const useTls = Boolean(tls && tls.pfx)
  const server = useTls ? createHttpsServer(tls, onRequest) : createServer(onRequest)

  let actualPort = port
  for (let i = 0; i < 6; i++) {
    try {
      actualPort = await listen(server, host, port + i)
      break
    } catch (e) {
      if (e?.code !== 'EADDRINUSE' || i === 5) { hub.close(); throw e }
      log(`端口 ${port + i} 被占，试 ${port + i + 1}`)
    }
  }
  log(`通话服务在 http://${host}:${actualPort}`)

  return {
    port: actualPort,
    host,
    tls: useTls,
    hub,
    /** 隧道起来后把它写进 Host 白名单；关掉时传 '' 收回 */
    setAllowedHost: (h) => { allowHost = String(h || '').toLowerCase().trim() },
    getAllowedHost: () => allowHost,
    createRoom: (opts) => hub.createRoom(opts),
    broadcast: (roomId, type, data) => hub.broadcast(roomId, type, data),
    close: () => new Promise((r) => { hub.close(); server.close(() => r()) }),
    _tokenEquals: tokenEquals,
  }
}
