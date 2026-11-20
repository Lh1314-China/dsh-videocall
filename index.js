/**
 * dsh-videocall —— 让浏览器里的人，和桌面上的助手，真的通一次话
 * ============================================================================
 * 形态（按 specs/doubao-videocall-brief.md）：
 *   · 插件自己在 127.0.0.1 起一个独立小服务（默认 8790），**不碰 DSH 主端口**
 *   · 浏览器 ↔ 浏览器，WebRTC 直连；信令走 SSE + POST（零依赖）
 *   · 助手的画面 = OBS 虚拟摄像头（VTS → Spout2 → OBS → 虚拟摄像头）
 *   · 助手的声音 = Web Audio 造 MediaStreamTrack（零驱动）
 *   · 助手"看"用户 = 页面 canvas 抽帧 POST 回来，存成 DSH 附件
 *
 * 红线：不导入第三方代码；不绑 0.0.0.0；不写死绝对路径；不碰内核/驱动。
 * ============================================================================
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, networkInterfaces } from 'node:os'
import { spawn } from 'node:child_process'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { startCallServer } from './server/index.js'
import { createTunnel } from './server/tunnel.js'

const pluginDir = dirname(fileURLToPath(import.meta.url))
const PKG = (() => {
  try { return JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8')) } catch { return { version: '0.0.0' } }
})()

export const name = 'dsh-videocall'
export const inject = ['tools']

/** 日志走宿主控制台即可；宿主不给 console 也不能因为一句日志炸掉 */
const log = (msg) => {
  try { console.log(`[dsh-videocall] ${msg}`) } catch { /* 没有 console 就算了 */ }
}

/**
 * 宿主那棵树里的 schemastery（拿不到就**不声明 Config**）。
 * 依据：plugins/dsh-shiori-shore/lib/hostdeps.mjs 记过的真实坑 ——
 * 桌面版 profile 不装 optional peer，裸 import 会让整条插件不激活。
 * 这里退化为 undefined：配置照旧从 cordis.patch.yml 的 config 读，只是没有 schema 校验。
 */
let z
for (const spec of ['schemastery', '@deepseek-ai/schemastery']) {
  try {
    const m = await import(spec)
    const cand = m?.default ?? m?.Schema ?? m
    if (cand && typeof cand.object === 'function') { z = cand; break }
  } catch { /* 没有就跳过 */ }
}

export const Config = z
  ? z.object({
      enabled: z.boolean().default(true),
      /** 绑定地址：只允许回环；想上手机走隧道，别改成 0.0.0.0 */
      host: z.string().default('127.0.0.1'),
      port: z.natural().default(8790),
      /** 对外基础 URL（走隧道时填，比如 https://xxx.trycloudflare.com）；留空=本机 */
      publicBaseUrl: z.string().default(''),
      /** 房间令牌有效期（秒）；常驻房要能活好几天 */
      tokenTtlSec: z.natural().default(604800),
      /** 令牌一次性：用过即失效。默认关（页面一刷新就会断） */
      oneShotToken: z.boolean().default(false),
      /** 允许的 Origin（留空 = 只允许同源 + 本机）；防 CSRF / 防别的网页偷开房 */
      allowedOrigins: z.array(z.string()).default([]),
      /** 每 IP 每分钟最多几次 join（防爆破令牌） */
      rateLimitPerMin: z.natural().default(30),

      // ── 皮套（助手出镜的那一路）──────────────────────────────
      /** 摄像头设备名匹配关键字（不区分大小写）。默认按 OBS 虚拟摄像头找 */
      avatarMatch: z.string().default('obs'),
      avatarWidth: z.natural().default(1280),
      avatarHeight: z.natural().default(720),
      avatarFps: z.natural().default(30),
      avatarMirror: z.boolean().default(false),

      // ── 抽帧（助手"看"对方的两档）────────────────────────────
      /** 低档：只看轮廓，省流量 */
      lowWidth: z.natural().default(160),
      lowFps: z.natural().default(1),
      /** JPEG 质量 10~95（整数，避免浮点 schema 兼容问题） */
      jpegQuality: z.natural().default(55),
      /** 高档：按需拉一帧原图 */
      highWidth: z.natural().default(1280),

      // ── 连接 ─────────────────────────────────────────────────
      iceServers: z.array(z.string()).default(['stun:stun.l.google.com:19302']),
      /** 可选 TURN（对称 NAT 时用） */
      turnUrl: z.string().default(''),
      turnUser: z.string().default(''),
      turnCredential: z.string().default(''),

      /** 抽帧落盘目录；留空 = ~/.dsh/dsh-videocall/frames */
      dataDir: z.string().default(''),

      // ── 隧道阀门 ─────────────────────────────────────────────
      /** cloudflared 可执行文件路径；留空 = 插件自己的 bin/cloudflared.exe */
      tunnelBin: z.string().default(''),

      // ── 局域网模式（手机同网直连，不穿公网）────────────────────
      /** 开：监听 0.0.0.0 + HTTPS。手机打开 https://<本机IP>:<端口> 即可 */
      lanMode: z.boolean().default(false),
      /** PFX 证书路径；留空 = 插件自己的 certs/dev.pfx */
      tlsPfx: z.string().default(''),
      tlsPass: z.string().default('dsh-videocall'),
    })
  : undefined

/** 宿主只吃无损 JSON */
const safe = (v) => {
  if (v === undefined || v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v
  try { return JSON.parse(JSON.stringify(v)) } catch { return String(v) }
}

const textOutput = {
  schema: { type: 'object', properties: {}, additionalProperties: true },
  render: (_args, value) => [{
    type: 'text',
    text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
  }],
}

const frameOutput = {
  schema: {
    type: 'object',
    properties: {
      at: { type: 'number' },
      width: { type: 'number' },
      height: { type: 'number' },
      note: { type: 'string' },
      image: { type: 'object', additionalProperties: true },
    },
    additionalProperties: true,
  },
  render: (_args, v) => {
    const blocks = [{ type: 'text', text: `通话画面：${new Date(v.at).toLocaleString()}（${v.width}×${v.height}）` }]
    if (v?.image?.attachmentId) blocks.push({ type: 'image', attachment: v.image })
    return blocks
  },
}

const clampInt = (v, d, min, max) => {
  const n = Number(v)
  if (!Number.isFinite(n)) return d
  return Math.min(max, Math.max(min, Math.round(n)))
}

const normalize = (raw) => {
  const cfg = { ...(raw || {}) }
  const host = String(cfg.host || '127.0.0.1').trim() || '127.0.0.1'
  const ice = Array.isArray(cfg.iceServers) ? cfg.iceServers.map((s) => String(s).trim()).filter(Boolean) : []
  const origins = Array.isArray(cfg.allowedOrigins)
    ? cfg.allowedOrigins.map((s) => String(s).trim().replace(/\/$/, '')).filter(Boolean)
    : []
  const turnUrl = String(cfg.turnUrl || '').trim()
  return {
    enabled: cfg.enabled !== false,
    host,
    port: clampInt(cfg.port, 8790, 1024, 65535),
    publicBaseUrl: String(cfg.publicBaseUrl || '').trim().replace(/\/$/, ''),
    tokenTtlSec: clampInt(cfg.tokenTtlSec, 604800, 60, 2592000),
    oneShotToken: cfg.oneShotToken === true,
    allowedOrigins: origins,
    rateLimitPerMin: clampInt(cfg.rateLimitPerMin, 30, 0, 600),

    avatarMatch: String(cfg.avatarMatch ?? 'obs').trim(),
    avatarWidth: clampInt(cfg.avatarWidth, 1280, 320, 3840),
    avatarHeight: clampInt(cfg.avatarHeight, 720, 180, 2160),
    avatarFps: clampInt(cfg.avatarFps, 30, 5, 60),
    avatarMirror: cfg.avatarMirror === true,

    lowWidth: clampInt(cfg.lowWidth, 160, 64, 640),
    lowFps: clampInt(cfg.lowFps, 1, 1, 10),
    jpegQuality: clampInt(cfg.jpegQuality, 55, 10, 95) / 100,
    highWidth: clampInt(cfg.highWidth, 1280, 320, 3840),

    iceServers: ice.length ? ice : ['stun:stun.l.google.com:19302'],
    turn: turnUrl
      ? [{ urls: turnUrl, username: String(cfg.turnUser || ''), credential: String(cfg.turnCredential || '') }]
      : [],
    dataDir: String(cfg.dataDir || '').trim(),
    tunnelBin: String(cfg.tunnelBin || '').trim(),
    lanMode: cfg.lanMode === true,
    tlsPfx: String(cfg.tlsPfx || '').trim(),
    tlsPass: String(cfg.tlsPass || 'dsh-videocall'),
  }
}

/** 本机第一个非回环 IPv4（局域网地址） */
const lanIpOf = () => {
  try {
    const ifs = networkInterfaces()
    for (const list of Object.values(ifs)) {
      for (const a of list || []) {
        if (a && a.family === 'IPv4' && !a.internal) return a.address
      }
    }
  } catch { /* 拿不到就算了 */ }
  return '127.0.0.1'
}

const dataDirOf = (cfg) => {
  const raw = cfg.dataDir
  if (!raw) return join(homedir(), '.dsh', 'dsh-videocall')
  return isAbsolute(raw) ? raw : resolve(raw)
}

/**
 * 宿主树里的 `defineTool`（拿不到就把原始 spec 直接交给 ctx.tools）。
 * 与 plugins/dsh-shiori-shore/index.js 同一套双路兜底：先 defineTool，再裸 spec，两次都失败只记日志。
 */
let defineTool
for (const spec of ['@deepseek-ai/dsh-tools']) {
  try {
    const m = await import(spec)
    const cand = m?.defineTool ?? m?.default?.defineTool
    if (typeof cand === 'function') { defineTool = cand; break }
  } catch { /* 没有就跳过 */ }
}

/** 注册一个工具：defineTool 优先进，失败退裸 spec；两种都失败也不崩 */
const registerTool = (ctx, spec) => {
  try {
    if (typeof defineTool === 'function') {
      ctx.tools.register(defineTool(spec))
      return true
    }
  } catch (e) {
    log(`defineTool 注册 ${spec.name} 失败：${e?.message ?? e}`)
  }
  try {
    ctx.tools.register(spec)
    return true
  } catch (e) {
    log(`注册工具 ${spec.name} 失败：${e?.message ?? e}`)
    return false
  }
}

export async function apply(ctx, config) {
  const cfg = normalize(config)
  if (!cfg.enabled) { log('enabled=false，跳过'); return }

  const dataDir = dataDirOf(cfg)
  try { mkdirSync(join(dataDir, 'frames'), { recursive: true }) } catch (e) { log(`数据目录建不了：${e?.message ?? e}`) }

  // 面板保存的路径覆盖插件配置（后写优先），这样面板里改完重载即生效
  const PANEL_FILE = join(dataDir, 'panel.json')
  const readPanelPaths = () => {
    try { return JSON.parse(readFileSync(PANEL_FILE, 'utf8')) } catch { return {} }
  }

  // ── 网络档案：记住去过的几个网络，换网不用重配 ──
  const NETWORKS_FILE = join(dataDir, 'networks.json')
  const readNetworks = () => {
    try {
      const j = JSON.parse(readFileSync(NETWORKS_FILE, 'utf8'))
      if (j && Array.isArray(j.list)) {
        return j.list
          .filter((x) => x && typeof x.ip === 'string' && /^\d{1,3}(\.\d{1,3}){3}$/.test(x.ip))
          .map((x) => ({ name: String(x.name || '未命名网络').slice(0, 40), ip: x.ip }))
          .slice(0, 32)
      }
    } catch { /* 没有就空 */ }
    return []
  }
  const writeNetworks = (list) => {
    try {
      mkdirSync(dataDir, { recursive: true })
      const clean = (Array.isArray(list) ? list : [])
        .filter((x) => x && typeof x.ip === 'string' && /^\d{1,3}(\.\d{1,3}){3}$/.test(x.ip))
        .map((x) => ({ name: String(x.name || '未命名网络').slice(0, 40), ip: x.ip }))
        .slice(0, 32)
      writeFileSync(NETWORKS_FILE, JSON.stringify({ list: clean }, null, 2), 'utf8')
      return clean
    } catch {
      return null
    }
  }
  {
    const saved = readPanelPaths()
    if (saved.tunnelBin) cfg.tunnelBin = saved.tunnelBin
    if (saved.tlsPfx) cfg.tlsPfx = saved.tlsPfx
    if (saved.tlsPass) cfg.tlsPass = saved.tlsPass
    if (saved.avatarMatch) cfg.avatarMatch = saved.avatarMatch
    // 自建隧道（frp / 花生壳 / 别的）只要在这里填外部地址，链接和 Host 白名单就跟着走
    if (typeof saved.publicBaseUrl === 'string' && saved.publicBaseUrl.trim()) cfg.publicBaseUrl = saved.publicBaseUrl.trim()
  }

  /** 每个房间只留最新一帧（够"看一眼"，也不吃内存） */
  const latest = new Map()

  const lanIp = lanIpOf() // 启动快照，只用于首次建档

  // 首次启动：把当前网络记进档案，省得用户白手起家
  if (readNetworks().length === 0) {
    writeNetworks([{ name: '当前网络', ip: lanIp }])
  }

  /** 当前真实局域网 IP：换网络后必须实时算，不能吃启动时的快照 */
  const currentLanIp = () => lanIpOf()

  /** 跑一遍 make-cert.ps1（Windows）。返回 { code, output } */
  const runCertScript = (ips, out, password) => new Promise((resolve) => {
    try {
      const script = join(pluginDir, 'tools', 'make-cert.ps1')
      const ps = spawn('powershell.exe', [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script,
        '-Ips', ips.join(','), '-Out', out, '-Password', password,
      ], { windowsHide: true })
      let buf = ''
      ps.stdout?.on('data', (c) => { buf += String(c) })
      ps.stderr?.on('data', (c) => { buf += String(c) })
      ps.on('exit', (code) => resolve({ code, output: buf }))
      ps.on('error', (e) => resolve({ code: -1, output: String(e?.message ?? e) }))
    } catch (e) {
      resolve({ code: -1, output: String(e?.message ?? e) })
    }
  })

  let tls = null
  if (cfg.lanMode) {
    const pfxPath = cfg.tlsPfx || join(pluginDir, 'certs', 'dev.pfx')
    // 首次运行没有证书：自动生成一张（含当前 IP + 档案里所有 IP），否则只能降级 HTTP
    if (!existsSync(pfxPath)) {
      const ips = readNetworks().map((x) => x.ip)
      if (!ips.length) ips.push(lanIp)
      log(`证书不存在，自动生成（${ips.join(', ')}）…`)
      const r = await runCertScript(ips, pfxPath, cfg.tlsPass)
      if (r.code === 0) log('证书已生成')
      else log(`自动生成证书失败：${r.output.slice(-300)}`)
    }
    try {
      tls = { pfx: readFileSync(pfxPath), passphrase: cfg.tlsPass }
      log(`局域网模式：HTTPS 证书已载入（${pfxPath}）`)
    } catch (e) {
      log(`局域网模式：证书读不到（${e?.message ?? e}），降级 HTTP——手机可能拿不到摄像头`)
    }
  }
  const listenHost = cfg.lanMode ? '0.0.0.0' : cfg.host

  let server
  /** 控制面板：状态查询 + 隧道阀门 + 路径保存（服务端只放行回环） */
  const panel = {
    state: () => ({
      ok: true,
      service: {
        running: true,
        listen: `${listenHost}:${server.port}`,
        tls: server.tls,
        lanMode: cfg.lanMode,
        url: currentBaseUrl(),
      },
      tunnel: tunnel.status(),
      rooms: server.hub.snapshot(),
      frames: [...latest.entries()].map(([roomId, f]) => ({
        roomId,
        at: f.at,
        width: f.width,
        height: f.height,
        bytes: f.data.length,
        ageSec: Math.round((Date.now() - f.at) / 1000),
      })),
      paths: { ...readPanelPaths(), avatarMatch: cfg.avatarMatch },
      room: {
        roomId: persistentRoom.roomId,
        label: persistentRoom.label,
        url: currentBaseUrl() + '/call.html?room=' + encodeURIComponent(persistentRoom.roomId) + '&t=' + encodeURIComponent(persistentRoom.token),
      },
      network: {
        currentIp: currentLanIp(),
        matched: (readNetworks().find((x) => x.ip === currentLanIp()) || {}).name || '',
        list: readNetworks(),
      },
    }),
    activate: async () => {
      const r = await tunnel.start()
      if (r.ok && r.url) {
        try { server.setAllowedHost(new URL(r.url).host) } catch { /* 地址异常 */ }
        return { ok: true, url: r.url }
      }
      return { ok: false, ...r }
    },
    deactivate: () => {
      const r = tunnel.stop()
      server.setAllowedHost('')
      return r
    },
    savePaths: (p) => {
      const clean = {}
      for (const k of ['tunnelBin', 'tlsPfx', 'tlsPass', 'avatarMatch', 'obsPath', 'vtsPath', 'publicBaseUrl']) {
        if (typeof p?.[k] === 'string') clean[k] = p[k].slice(0, 400)
      }
      try {
        mkdirSync(dataDir, { recursive: true })
        writeFileSync(PANEL_FILE, JSON.stringify(clean, null, 2), 'utf8')
      } catch (e) {
        return { ok: false, error: 'write-failed', detail: String(e?.message ?? e) }
      }
      return { ok: true, saved: clean, note: '已写入 panel.json，重载插件后生效' }
    },
    addNetwork: (p) => {
      const name = String(p?.name || '').trim().slice(0, 40)
      const ip = String(p?.ip || '').trim()
      if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return { ok: false, error: 'IP 格式不对' }
      const list = readNetworks().filter((x) => x.ip !== ip)
      list.push({ name: name || ip, ip })
      const saved = writeNetworks(list)
      if (!saved) return { ok: false, error: '写入失败' }
      return { ok: true, list: saved, note: '已保存。要让手机接受这个 IP，还需点「更新证书」再重载插件。' }
    },
    removeNetwork: (p) => {
      const ip = String(p?.ip || '').trim()
      const saved = writeNetworks(readNetworks().filter((x) => x.ip !== ip))
      if (!saved) return { ok: false, error: '写入失败' }
      return { ok: true, list: saved, note: '已删除（证书里暂时还留着，下次更新证书时清掉）' }
    },
    regenCert: async () => {
      const ips = readNetworks().map((x) => x.ip)
      if (!ips.length) return { ok: false, error: '还没有任何网络档案' }
      const out = cfg.tlsPfx || join(pluginDir, 'certs', 'dev.pfx')
      const r = await runCertScript(ips, out, cfg.tlsPass)
      if (r.code !== 0) return { ok: false, error: 'cert-failed', detail: r.output.slice(-1200) }
      return { ok: true, ips, note: `证书已更新（含 ${ips.length} 个 IP），重载插件后生效`, output: r.output.slice(-400) }
    },
  }

  try {
    server = await startCallServer({
      host: listenHost,
      tls,
      allowLan: cfg.lanMode,
      panel,
      localAddresses: [lanIp],
      port: cfg.port,
      iceServers: cfg.iceServers,
      turn: cfg.turn,
      tokenTtlSec: cfg.tokenTtlSec,
      oneShotToken: cfg.oneShotToken,
      allowedOrigins: cfg.allowedOrigins,
      rateLimitPerMin: cfg.rateLimitPerMin,
      publicConfig: {
        avatarMatch: cfg.avatarMatch,
        avatarWidth: cfg.avatarWidth,
        avatarHeight: cfg.avatarHeight,
        avatarFps: cfg.avatarFps,
        avatarMirror: cfg.avatarMirror,
        lowWidth: cfg.lowWidth,
        lowFps: cfg.lowFps,
        jpegQuality: cfg.jpegQuality,
        highWidth: cfg.highWidth,
      },
      staticDir: join(pluginDir, 'static'),
      log,
      onFrame: (roomId, frame) => {
        latest.set(roomId, frame)
        if (latest.size > 6) {
          const oldest = latest.keys().next().value
          if (oldest && oldest !== roomId) latest.delete(oldest)
        }
      },
    })
  } catch (e) {
    log(`通话服务没起来（插件继续加载，只是没有通话能力）：${e?.message ?? e}`)
    return
  }

  ctx.effect(() => () => { void server.close() }, 'dsh-videocall: 通话服务')

  // ── 常驻房：一次开好，插件重启后复用同一个链接 ──
  const ROOM_FILE = join(dataDir, 'room.json')
  let persistentRoom = null
  try {
    const saved = JSON.parse(readFileSync(ROOM_FILE, 'utf8'))
    if (saved && saved.roomId && saved.token) {
      const back = server.hub.restoreRoom({
        id: saved.roomId,
        token: saved.token,
        label: saved.label,
        createdAt: saved.createdAt,
      })
      if (back) {
        persistentRoom = { roomId: back.id, token: back.token, label: back.label, createdAt: back.createdAt }
        log(`常驻房已恢复：${String(back.id).slice(0, 8)}`)
      }
    }
  } catch { /* 没有存档就新建 */ }
  if (!persistentRoom) {
    const r = server.createRoom({ label: '常驻' })
    persistentRoom = { roomId: r.id, token: r.token, label: r.label, createdAt: r.createdAt }
    try {
      mkdirSync(dataDir, { recursive: true })
      writeFileSync(ROOM_FILE, JSON.stringify(persistentRoom, null, 2), 'utf8')
    } catch { /* 写不了就只在内存 */ }
    log(`常驻房已新建：${String(r.id).slice(0, 8)}`)
  }

  /** 隧道阀门：独立于通话服务，随时可切 */
  /** cloudflared 优先用配置；没配就在插件自己的 bin/ 里找 */
  const tunnelBin = cfg.tunnelBin || join(pluginDir, 'bin', process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared')
  const tunnel = createTunnel({ binPath: tunnelBin, targetPort: server.port, log })
  ctx.effect(() => () => { tunnel.stop() }, 'dsh-videocall: 隧道阀门')

  /** 当前对外的地址：隧道 > 配置 > 局域网 > 回环 */
  const currentBaseUrl = () => {
    const tun = tunnel.status().url
    if (tun) return tun
    if (cfg.publicBaseUrl) return cfg.publicBaseUrl
    const scheme = server.tls ? 'https' : 'http'
    return cfg.lanMode ? `${scheme}://${currentLanIp()}:${server.port}` : `${scheme}://${cfg.host}:${server.port}`
  }

  registerTool(ctx, {
    name: 'videocall_room',
    description: '返回常驻通话房的链接（不传 label）；传 label 则另开一间临时房。常驻房的链接重启插件后依然有效，对方手机可以存书签。',
    parameters: {
      type: 'object',
      properties: {
        label: { type: 'string', description: '给这间房起个名字（可选，便于分辨）' },
      },
      additionalProperties: false,
    },
    output: textOutput,
    async execute(args) {
      const wanted = String(args?.label || '').trim()
      // 不传 label 就返回常驻房：同一个链接一直可用，不用每次重开
      const room = wanted
        ? (() => {
            const r = server.createRoom({ label: wanted })
            return { roomId: r.id, token: r.token, label: r.label, createdAt: r.createdAt }
          })()
        : persistentRoom
      const b = currentBaseUrl()
      return safe({
        roomId: room.roomId,
        url: `${b}/call.html?room=${encodeURIComponent(room.roomId)}&t=${encodeURIComponent(room.token)}`,
        expiresInSec: cfg.tokenTtlSec,
        persistent: !wanted,
        tls: server.tls,
        lanMode: cfg.lanMode,
        tip: wanted
          ? '临时房，用完即弃。不传 label 则返回常驻房（链接固定）。'
          : '常驻房：这个链接重启插件后仍然有效，手机可以存书签。',
      })
    },
  })

  registerTool(ctx, {
    name: 'videocall_status',
    description: '看通话服务的现状：端口、房间、对端是否在线、最近一帧的时间与尺寸。排障第一步用它。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: textOutput,
    async execute() {
      const frames = [...latest.entries()].map(([roomId, f]) => ({ roomId, at: f.at, width: f.width, height: f.height, bytes: f.data.length, ageSec: Math.round((Date.now() - f.at) / 1000) }))
      return safe({
        running: true,
        url: currentBaseUrl(),
        listen: `${listenHost}:${server.port}`,
        tls: server.tls,
        rooms: server.hub.snapshot(),
        frames,
        iceServers: cfg.iceServers,
      })
    },
  })

  registerTool(ctx, {
    name: 'videocall_look',
    description: '看一眼通话里对方的画面：把最新一帧抽帧存成 DSH 图片附件并交给你。没开抽帧就直说没画面。',
    parameters: {
      type: 'object',
      properties: {
        roomId: { type: 'string', description: '房间 id；留空 = 最近有画面的那间' },
      },
      additionalProperties: false,
    },
    output: frameOutput,
    async execute(args) {
      const roomId = String(args?.roomId || '')
      let frame
      if (roomId) frame = latest.get(roomId)
      else {
        let best = null
        for (const [id, f] of latest) if (!best || f.at > best.f.at) best = { id, f }
        frame = best?.f
      }
      if (!frame) throw new Error('还没有画面：让对方在通话页打开「抽帧」，或等 1~2 秒再试')

      const attachments = ctx.get('attachments')
      if (!attachments || typeof attachments.saveImage !== 'function') throw new Error('附件服务没挂上（ctx.get("attachments") 为空），这一帧没法交给你看')

      const ref = await attachments.saveImage({
        data: frame.data,
        mediaType: 'image/jpeg',
        name: `videocall-${String(roomId || 'latest').slice(0, 8)}-${frame.at}.jpg`,
      })
      return safe({
        at: frame.at,
        width: frame.width || ref.width || 0,
        height: frame.height || ref.height || 0,
        note: `来自 peer=${frame.peer || '未知'}，${frame.data.length} 字节`,
        image: {
          attachmentId: ref.attachmentId,
          mediaType: ref.mediaType,
          bytes: ref.bytes,
          width: ref.width,
          height: ref.height,
        },
      })
    },
  })

  registerTool(ctx, {
    name: 'videocall_ping',
    description: '往通话页推一条系统提示（对方页面顶部会显示一行字）。用于"我连上了/稍等/挂了吧"这种人工提示。',
    parameters: {
      type: 'object',
      properties: {
        roomId: { type: 'string', description: '房间 id' },
        text: { type: 'string', description: '要显示的一句话（≤120 字）' },
      },
      required: ['roomId', 'text'],
      additionalProperties: false,
    },
    output: textOutput,
    async execute(args) {
      const n = server.broadcast(String(args?.roomId || ''), 'notice', { text: String(args?.text || '').slice(0, 120) })
      return safe({ delivered: n })
    },
  })

  registerTool(ctx, {
    name: 'videocall_stop',
    description: '关掉通话服务并结束所有房间（插件本身仍在，下次重载再起）。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: textOutput,
    async execute() {
      await server.close()
      latest.clear()
      return safe({ stopped: true })
    },
  })

  registerTool(ctx, {
    name: 'videocall_netcheck',
    description: '网络自检：列出本机所有 IPv4、当前监听地址、是否 HTTPS、手机该开哪个地址、隧道状态。换网络（热点→校园网）后跑一次，就知道还连不连得上。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: textOutput,
    async execute() {
      const ifs = networkInterfaces()
      const addresses = []
      for (const [name, list] of Object.entries(ifs)) {
        for (const a of list || []) {
          if (a && a.family === 'IPv4') addresses.push({ iface: name, address: a.address, internal: Boolean(a.internal) })
        }
      }
      return safe({
        ok: true,
        listen: `${listenHost}:${server.port}`,
        tls: server.tls,
        lanMode: cfg.lanMode,
        lanIp,
        addresses,
        suggestedUrl: currentBaseUrl(),
        tunnel: tunnel.status(),
        hints: [
          server.tls ? 'HTTPS 已开：手机第一次打开会提示自签证书，点继续即可' : '没开 HTTPS：手机浏览器会拒绝给摄像头（非安全上下文）',
          cfg.lanMode ? '已监听 0.0.0.0，同网设备可直接访问' : '只监听回环，手机进不来',
          '换到校园网后：如果手机连不上这里列的地址，多半是学校开了「客户端隔离」，局域网方案不适用',
        ],
      })
    },
  })

  registerTool(ctx, {
    name: 'videocall_tunnel',
    description: '公网隧道阀门。start=拉起 Cloudflare 临时隧道并把它的域名加进 Host 白名单；stop=立刻切断，公网通道断开（本机通话不受影响）；status=看现在通不通。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['start', 'stop', 'status'], description: 'start / stop / status' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: textOutput,
    async execute(args) {
      const action = String(args?.action || 'status')
      if (action === 'start') {
        const r = await tunnel.start()
        if (r.ok && r.url) {
          try { server.setAllowedHost(new URL(r.url).host) } catch { /* 地址异常就不放行 */ }
          return safe({
            ok: true,
            url: r.url,
            note: '把这个地址 + 房间链接给对方。用完立刻 videocall_tunnel action=stop 切断。',
          })
        }
        return safe({ ok: false, ...r })
      }
      if (action === 'stop') {
        const r = tunnel.stop()
        server.setAllowedHost('')
        return safe(r)
      }
      return safe({ ...tunnel.status(), allowedHost: server.getAllowedHost() })
    },
  })

  // ── 面板 API：挂在 DSH 自己的 webServer 上（同源，不碰外部端口）──
  const mountPanelRoute = (web) => web.register({
    kind: 'exact',
    path: '/__videocall/panel',
    handler: async (req, res) => {
      const send = (data, status = 200) => {
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(JSON.stringify(data))
      }
      if (req.method === 'GET') return send(panel.state())
      if (req.method === 'POST') {
        let raw = ''
        try { for await (const c of req) raw += c } catch { /* 读不到当空 body */ }
        let body = {}
        try { body = JSON.parse(raw || '{}') } catch { /* 同上 */ }
        const action = String(body?.action ?? '')
        if (action === 'activate') return send(await panel.activate())
        if (action === 'deactivate') return send(panel.deactivate())
        if (action === 'savePaths') return send(panel.savePaths(body.paths || {}))
        if (action === 'addNetwork') return send(panel.addNetwork(body))
        if (action === 'removeNetwork') return send(panel.removeNetwork(body))
        if (action === 'regenCert') return send(await panel.regenCert())
        if (action === 'status') return send(panel.state())
        return send({ ok: false, error: 'unknown action: ' + action }, 400)
      }
      res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('method not allowed')
    },
  })

  // ⚠️ apply 执行时 webServer 常常还没上桌：先试 ctx.get，拿不到就 ctx.inject 等它
  {
    const early = typeof ctx.get === 'function' ? ctx.get('webServer') : undefined
    if (early && typeof early.register === 'function') {
      ctx.effect(() => mountPanelRoute(early), 'dsh-videocall panel route')
      log('面板 API 已挂载：/__videocall/panel')
    } else if (typeof ctx.inject === 'function') {
      ctx.inject(['webServer'], (webCtx) => {
        const late = webCtx.get('webServer')
        if (!late || typeof late.register !== 'function') return undefined
        return webCtx.effect(() => mountPanelRoute(late), 'dsh-videocall panel route (late)')
      })
      log('等 webServer 上桌再挂面板 API')
    } else {
      log('没有 webServer：面板 API 不可用（通话服务本身不受影响）')
    }
  }

  log(`已就绪：http://${cfg.host}:${server.port}（v${PKG.version || '0.0.0'}，ICE=${cfg.iceServers.join(',')}）`)
}
