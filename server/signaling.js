/**
 * server/signaling.js —— 最小信令中枢（零依赖）
 * ============================================================================
 * 一句话：**房间 + 令牌 + 一条 SSE 推给对端**。
 *
 * 为什么不用 WebSocket：
 *   · Node 内置没有 WS 服务端，`ws` 是外部依赖（任务书要求尽量只用内置模块）；
 *   · 信令只要「低频、单向推送」，SSE + POST 完全够（浏览器原生 EventSource）；
 *   · 走 Cloudflare 隧道时 SSE 比 WS 更容易稳（WS 会被中间层改写/断流）。
 *
 * 房间模型：一个房间最多 2 个 peer（1v1 通话）。先到的是 initiator（发 offer）。
 * ============================================================================
 */
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'

const MAX_PEERS = 2

/** 定长比较，避免 timing 泄漏；长度不等直接 false（timingSafeEqual 会抛） */
export function tokenEquals(a, b) {
  const x = Buffer.from(String(a ?? ''), 'utf8')
  const y = Buffer.from(String(b ?? ''), 'utf8')
  if (x.length !== y.length || x.length === 0) return false
  try { return timingSafeEqual(x, y) } catch { return false }
}

export class SignalHub {
  constructor({ tokenTtlSec = 3600, oneShotToken = false, log = () => {}, heartbeatMs = 15000 } = {}) {
    this.tokenTtlSec = Math.max(60, Number(tokenTtlSec) || 3600)
    this.oneShotToken = oneShotToken === true
    this.log = log
    this.rooms = new Map()
    this.heartbeatMs = Math.max(5000, Number(heartbeatMs) || 15000)

    this.heartbeat = setInterval(() => this.#tick(), this.heartbeatMs)
    if (typeof this.heartbeat.unref === 'function') this.heartbeat.unref()
    this.sweep = setInterval(() => this.#sweep(), 60_000)
    if (typeof this.sweep.unref === 'function') this.sweep.unref()
  }

  /** 开房：只给「助手侧」用（插件工具调用），令牌一次性 */
  createRoom({ label = '' } = {}) {
    const id = randomUUID()
    const token = randomBytes(16).toString('base64url')
    const createdAt = Date.now()
    const room = { id, token, label: String(label ?? '').slice(0, 64), createdAt, peers: new Map() }
    this.rooms.set(id, room)
    this.log(`开房 ${id.slice(0, 8)}（${room.label || '未命名'}）`)
    return { id, token, createdAt, label: room.label }
  }

  /**
   * 从磁盘恢复一间房（插件重启后复用同一个链接）。
   * 房间只用 id + token 重建，对端进来重新握手，不保留旧的 peer。
   */
  restoreRoom({ id, token, label = '', createdAt = 0 } = {}) {
    if (!id || !token) return null
    const existing = this.rooms.get(id)
    if (existing) return { id, token: existing.token, createdAt: existing.createdAt, label: existing.label }
    const room = {
      id,
      token,
      label: String(label ?? '').slice(0, 64),
      createdAt: Number(createdAt) || Date.now(),
      peers: new Map(),
    }
    this.rooms.set(id, room)
    this.log(`恢复常驻房 ${id.slice(0, 8)}（${room.label || '未命名'}）`)
    return { id, token, createdAt: room.createdAt, label: room.label }
  }

  get(id) { return this.rooms.get(String(id ?? '')) }

  /** 校验令牌；通过返回房间，否则 null */
  authorize(roomId, token) {
    const room = this.get(roomId)
    if (!room) return null
    if (!tokenEquals(room.token, token)) return null
    if (Date.now() - room.createdAt > this.tokenTtlSec * 1000 && room.peers.size === 0) return null
    return room
  }

  /**
   * 入场：给这个连接分配 peerId。
   * initiator = 第一个进来的（由它发 offer）；第二个进来时给先到的推 peer-joined。
   */
  join(roomId, token, ip = '') {
    const room = this.authorize(roomId, token)
    if (!room) return { ok: false, code: 'bad-token' }
    // 先把已经断开的占位剔掉：否则刷新/重连之后，房间会被历史连接永久占死
    for (const [id, p] of [...room.peers]) {
      if (!p.res) room.peers.delete(id)
    }
    if (room.peers.size >= MAX_PEERS) return { ok: false, code: 'room-full' }
    // 令牌不外借：开房后第一个进来的定下来源 IP，后来的必须同源（防把链接转发给别人）
    if (this.oneShotToken) {
      const src = String(ip || '')
      if (!room.ownerIp) room.ownerIp = src
      else if (room.ownerIp !== src) return { ok: false, code: 'token-single-host' }
    }
    const peerId = randomUUID().slice(0, 8)
    room.peers.set(peerId, { id: peerId, res: null, joinedAt: Date.now() })
    const initiator = room.peers.size === 1
    this.log(`入场 ${room.id.slice(0, 8)} peer=${peerId} initiator=${initiator}`)
    return { ok: true, peerId, initiator, peers: [...room.peers.keys()] }
  }

  /** 挂上 SSE。同一 peerId 重复订阅时，旧连接被顶掉。 */
  subscribe(roomId, peerId, res) {
    const room = this.get(roomId)
    if (!room) return () => {}
    const peer = room.peers.get(peerId)
    if (!peer) return () => {}
    if (peer.res && peer.res !== res) { try { peer.res.end() } catch { /* 旧连接已断 */ } }
    peer.res = res

    const other = [...room.peers.values()].find((p) => p.id !== peerId)
    if (other?.res) this.#send(other, 'peer-joined', { peer: peerId })
    this.#send(peer, 'hello', { peer: peerId, peers: [...room.peers.keys()] })

    return () => {
      const r = this.rooms.get(roomId)
      if (!r) return
      const p = r.peers.get(peerId)
      if (p && p.res === res) { p.res = null; p.joinedAt = Date.now() }
      this.#sendToRoom(r, 'peer-left', { peer: peerId })
    }
  }

  /** 转发一条信令给房间里的另一位（`to` 可指定范围） */
  relay(roomId, from, message, to) {
    const room = this.get(roomId)
    if (!room) return { ok: false, code: 'no-room' }
    if (!room.peers.has(from)) return { ok: false, code: 'not-in-room' }
    const payload = { ...message, from }
    let delivered = 0
    for (const peer of room.peers.values()) {
      if (peer.id === from) continue
      if (to && peer.id !== to) continue
      if (!peer.res) continue
      this.#send(peer, String(payload.type || 'signal'), payload)
      delivered++
    }
    return { ok: true, delivered }
  }

  /** 给房间里所有已连上的 peer 推一条（助手侧主动说话/提示用） */
  broadcast(roomId, type, data) {
    const room = this.get(roomId)
    if (!room) return 0
    let n = 0
    for (const peer of room.peers.values()) if (peer.res) { this.#send(peer, type, data); n++ }
    return n
  }

  snapshot() {
    return [...this.rooms.values()].map((r) => ({
      id: r.id,
      label: r.label,
      ageSec: Math.round((Date.now() - r.createdAt) / 1000),
      peers: [...r.peers.values()].map((p) => ({ id: p.id, online: Boolean(p.res) })),
    }))
  }

  #sendToRoom(room, type, data) {
    for (const p of room.peers.values()) if (p.res) this.#send(p, type, data)
  }

  #send(peer, type, data) {
    try {
      peer.res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`)
    } catch { /* 对端已断，下一轮清理会摘掉 */ }
  }

  #tick() {
    for (const room of this.rooms.values()) {
      for (const p of room.peers.values()) {
        if (p.res) { try { p.res.write(': ping\n\n') } catch { /* ignore */ } }
      }
    }
  }

  /** 清理：空房超过 30 分钟、或令牌过期且无人，就删 */
  #sweep() {
    const now = Date.now()
    for (const [id, room] of this.rooms) {
      const online = [...room.peers.values()].some((p) => p.res)
      if (online) continue
      const last = Math.max(room.createdAt, ...[...room.peers.values()].map((p) => p.joinedAt || 0))
      if (now - last > 30 * 60_000) {
        this.rooms.delete(id)
        this.log(`清理空房 ${id.slice(0, 8)}`)
      }
    }
  }

  close() {
    clearInterval(this.heartbeat)
    clearInterval(this.sweep)
    for (const room of this.rooms.values()) {
      for (const p of room.peers.values()) { try { p.res?.end() } catch { /* ignore */ } }
    }
    this.rooms.clear()
  }
}
