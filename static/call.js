/**
 * static/call.js —— 通话页的全部逻辑（原生 ES 模块，零依赖）
 * ============================================================================
 * 六件事：入场 → 拿设备 → 建 RTCPeerConnection → 信令（SSE）→ 挂轨道 →（可选）抽帧
 * 关键取舍：
 *   · 助手的声音 = MediaStreamAudioDestinationNode.stream 的 audio track（零驱动）
 *   · 助手画面 = 下拉里选的摄像头（本机就是 OBS Virtual Camera）
 *   · 抽帧只画到 160×120 JPEG，1 fps，省流量
 * ============================================================================
 */
const qs = new URLSearchParams(location.search)
const ROOM = qs.get('room') || ''
const TOKEN = qs.get('t') || ''
/** auto=1：页面加载后自己走完「授权 → 选设备 → 开始通话」，给自环/联调用 */
const AUTO = qs.get('auto') === '1'
/** cam=xxx：按这个关键字挑摄像头，覆盖配置里的 avatarMatch */
const CAM_MATCH = qs.get('cam') || ''
/** frame=1：自动勾上「持续抽帧」（自环/联调时用，省得手点） */
const AUTO_FRAME = qs.get('frame') === '1'

const el = (id) => document.getElementById(id)
const ui = {
  remote: el('remote'),
  local: el('local'),
  dot: el('dot'),
  peerInfo: el('peerInfo'),
  roomInfo: el('roomInfo'),
  notice: el('notice'),
  camSelect: el('camSelect'),
  btnDevices: el('btnDevices'),
  btnStart: el('btnStart'),
  btnHangup: el('btnHangup'),
  btnTone: el('btnTone'),
  btnStopTone: el('btnStopTone'),
  chkFrame: el('chkFrame'),
  btnHiRes: el('btnHiRes'),
  localBadge: el('localBadge'),
  btnHideLocal: el('btnHideLocal'),
  btnShowLocal: el('btnShowLocal'),
  log: el('log'),
}

const state = {
  cfg: {},
  peerId: null,
  initiator: false,
  iceServers: [],
  pc: null,
  ac: null,
  dest: null,
  voiceStream: null,
  mic: null,
  cam: null,
  remoteStream: null,
  pendingIce: [],
  pendingOffer: null,
  offered: false,
  others: 0,
  frameTimer: null,
  es: null,
  toneSource: null,
}

function logLine(text) {
  const li = document.createElement('li')
  const t = new Date().toLocaleTimeString()
  li.textContent = `[${t}] ${text}`
  ui.log.appendChild(li)
  ui.log.scrollTop = ui.log.scrollHeight
}

function setPeer(text, online) {
  ui.peerInfo.textContent = text
  ui.dot.classList.toggle('on', Boolean(online))
}

function showNotice(text) {
  ui.notice.textContent = text
  ui.notice.style.display = text ? 'block' : 'none'
  if (text) setTimeout(() => { if (ui.notice.textContent === text) ui.notice.style.display = 'none' }, 6000)
}

async function api(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return res.json().catch(() => ({}))
}

function send(type, data, to) {
  return api('/api/signal', { room: ROOM, token: TOKEN, from: state.peerId, type, data, to }).catch(() => {})
}

// ── 入场 ────────────────────────────────────────────────────────────────
async function join() {
  if (!ROOM || !TOKEN) {
    showNotice('链接里缺 room 或 t：请用 videocall_room 生成的那条 url 打开')
    throw new Error('missing room/token')
  }
  ui.roomInfo.textContent = `房间 ${ROOM.slice(0, 8)}`
  const res = await api('/api/join', { room: ROOM, token: TOKEN })
  if (!res.ok) {
    showNotice(`入场失败：${res.code === 'room-full' ? '房间已满（1v1 只有两个位）' : '令牌不对或房间已过期'}`)
    throw new Error(res.code || 'join-failed')
  }
  state.peerId = res.peerId
  state.initiator = Boolean(res.initiator)
  state.others = Math.max(0, (res.peers || []).length - 1)
  setPeer(`已入场 · ${state.initiator ? '先到（发 offer）' : '后到（等 offer）'}`, true)
  logLine(`入场成功 peer=${state.peerId} initiator=${state.initiator}`)

  const cfg = await fetch('/api/config').then((r) => r.json()).catch(() => ({}))
  state.cfg = cfg || {}
  state.iceServers = [
    ...(cfg.iceServers || []).map((urls) => ({ urls })),
    ...(Array.isArray(cfg.turn) ? cfg.turn : []),
  ]
  logLine(`ICE: ${state.iceServers.map((s) => s.urls).join(', ') || '（空）'}`)
  openEvents()
}

function openEvents() {
  const url = `/api/events?room=${encodeURIComponent(ROOM)}&t=${encodeURIComponent(TOKEN)}&peer=${encodeURIComponent(state.peerId)}`
  state.es = new EventSource(url)

  state.es.addEventListener('hello', (e) => logLine(`SSE 就绪：${e.data}`))
  state.es.addEventListener('peer-joined', (e) => {
    state.others = 1
    setPeer('对端已进房，正在协商…', true)
    logLine(`对端进房 ${e.data}`)
    // 对端换了人：上一个连接已经拆掉，这里要把 pc 重新建起来再发 offer
    if (!state.pc) createPc()
    void maybeOffer()
  })
  state.es.addEventListener('peer-left', () => {
    state.others = 0
    setPeer('对端离开', true)
    logLine('对端离开')
    // 关键：拆掉旧连接并重置协商状态。
    // 否则 offered 永远是 true，对端重连后这边不发 offer，两边干等。
    if (state.pc) { try { state.pc.close() } catch { /* 已关 */ } state.pc = null }
    state.offered = false
    state.pendingIce = []
    state.pendingOffer = null
    if (state.frameTimer) stopFrames()
  })
  state.es.addEventListener('offer', (e) => { void onOffer(JSON.parse(e.data)) })
  state.es.addEventListener('answer', (e) => { void onAnswer(JSON.parse(e.data)) })
  state.es.addEventListener('candidate', (e) => { void onCandidate(JSON.parse(e.data)) })
  state.es.addEventListener('notice', (e) => {
    const msg = JSON.parse(e.data)
    showNotice(msg.text || '助手发来一条提示')
    logLine(`提示：${msg.text || ''}`)
  })
  state.es.onerror = () => logLine('SSE 断开（浏览器会自动重连）')
}

// ── 设备 ────────────────────────────────────────────────────────────────
async function grantDevices() {
  try {
    if (!state.mic) {
      state.mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
      logLine('麦克风已授权')
    }
  } catch (e) {
    showNotice(`麦克风拿不到：${e.name} / ${e.message}`)
    return
  }

  // iOS/WebKit 的坑：只授了麦克风时，enumerateDevices() 不会列出 videoinput。
  // 必须先请求一次摄像头权限（拿到就立刻关掉），设备列表才会出现。
  // 否则手机上永远是空列表 → 下拉停在「不送画面」→ 对端只收到声音。
  try {
    const probe = await navigator.mediaDevices.getUserMedia({ video: true, audio: false })
    probe.getTracks().forEach((t) => t.stop())
    logLine('摄像头权限已获取（用于枚举设备）')
  } catch (e) {
    logLine(`摄像头权限没拿到：${e.name}：${e.message}`)
  }

  let devices = []
  try { devices = await navigator.mediaDevices.enumerateDevices() } catch (e) { logLine(`枚举失败：${e.name}`) }
  const cams = devices.filter((d) => d.kind === 'videoinput')
  ui.camSelect.innerHTML = ''
  const optNone = document.createElement('option')
  optNone.value = ''
  optNone.textContent = '（不送画面）'
  ui.camSelect.appendChild(optNone)
  const match = String(CAM_MATCH || state.cfg?.avatarMatch || 'obs').toLowerCase()
  let matched = false
  for (const cam of cams) {
    const o = document.createElement('option')
    o.value = cam.deviceId
    o.textContent = cam.label || `摄像头 ${cam.deviceId.slice(0, 6)}`
    if (match && String(cam.label || '').toLowerCase().includes(match)) { o.selected = true; matched = true }
    ui.camSelect.appendChild(o)
  }
  // 匹配不到（最常见：手机上没有 OBS）就退回第一个可用摄像头，
  // 不能静默留在「不送画面」——那是另一端只收到音频的元凶。
  if (!matched && cams.length) {
    ui.camSelect.value = cams[0].deviceId
    logLine(`没匹配到「${match}」，回退到 ${cams[0].label || cams[0].deviceId.slice(0, 6)}`)
  }
  logLine(`视频输入 ${cams.length} 个：${cams.map((c) => c.label || '(无标签)').join(' | ') || '无'}`)
  if (!cams.length) showNotice('没有枚举到摄像头：若 OBS 刚开，等 10 秒再点一次；还没装 OBS 就先跑 P0 探针')
}

async function ensureCamera() {
  const deviceId = ui.camSelect.value
  if (!deviceId) return
  if (state.cam) for (const t of state.cam.getTracks()) t.stop()
  try {
    state.cam = await navigator.mediaDevices.getUserMedia({
      video: {
        deviceId: { exact: deviceId },
        width: { ideal: Number(state.cfg?.avatarWidth) || 1280 },
        height: { ideal: Number(state.cfg?.avatarHeight) || 720 },
        frameRate: { ideal: Number(state.cfg?.avatarFps) || 30 },
      },
    })
    ui.local.srcObject = state.cam
    ui.local.style.transform = state.cfg?.avatarMirror ? 'scaleX(-1)' : 'none'
    logLine(`画面源已开：${state.cam.getVideoTracks()[0]?.label || deviceId}`)
  } catch (e) {
    showNotice(`打不开这个摄像头：${e.name}（多半是 OBS 没开「启动虚拟摄像机」）`)
  }
}

function setupAudioContext() {
  if (state.ac) return
  state.ac = new AudioContext()
  state.dest = state.ac.createMediaStreamDestination()
  state.voiceStream = state.dest.stream
  logLine('AudioContext 就绪（助手声音走 MediaStreamAudioDestinationNode）')
}

// ── WebRTC ──────────────────────────────────────────────────────────────
function createPc() {
  if (state.pc) return state.pc
  const pc = new RTCPeerConnection({ iceServers: state.iceServers })
  state.pc = pc
  state.remoteStream = new MediaStream()

  pc.onicecandidate = (ev) => { if (ev.candidate) void send('candidate', ev.candidate) }
  pc.onconnectionstatechange = () => logLine(`连接状态：${pc.connectionState}`)
  pc.ontrack = (ev) => {
    state.remoteStream.addTrack(ev.track)
    ui.remote.srcObject = state.remoteStream
    logLine(`收到远端轨道：${ev.track.kind}`)
  }

  for (const stream of [state.mic, state.cam, state.voiceStream]) {
    if (!stream) continue
    for (const track of stream.getTracks()) pc.addTrack(track, stream)
  }
  logLine(`已挂本地轨道：${pc.getSenders().map((s) => s.track?.kind).join(', ')}`)
  return pc
}

async function maybeOffer() {
  if (!state.initiator || !state.pc || state.offered || state.others < 1) return
  state.offered = true
  const offer = await state.pc.createOffer()
  await state.pc.setLocalDescription(offer)
  await send('offer', { sdp: state.pc.localDescription })
  logLine('offer 已发出')
}

async function onOffer(msg) {
  if (!state.pc) {
    state.pendingOffer = msg
    showNotice('对方来电：点「开始通话」接听')
    logLine('收到 offer，但本机还没开始：先点「开始通话」')
    return
  }
  await state.pc.setRemoteDescription(msg.data.sdp)
  flushIce()
  const answer = await state.pc.createAnswer()
  await state.pc.setLocalDescription(answer)
  await send('answer', { sdp: state.pc.localDescription })
  logLine('answer 已回')
}

async function onAnswer(msg) {
  if (!state.pc) return
  await state.pc.setRemoteDescription(msg.data.sdp)
  flushIce()
  logLine('收到 answer')
}

async function onCandidate(msg) {
  const cand = msg.data
  if (!state.pc || !state.pc.remoteDescription) { state.pendingIce.push(cand); return }
  try { await state.pc.addIceCandidate(cand) } catch (e) { logLine(`candidate 加失败：${e.name}`) }
}

function flushIce() {
  for (const c of state.pendingIce.splice(0)) state.pc.addIceCandidate(c).catch(() => {})
}

// ── 抽帧 ────────────────────────────────────────────────────────────────
function startFrames() {
  if (state.frameTimer) return
  const W = Number(state.cfg?.lowWidth) || 160
  const H = Math.round((W * 3) / 4)
  const q = Number(state.cfg?.jpegQuality) || 0.55
  const fps = Math.max(1, Number(state.cfg?.lowFps) || 1)
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d', { alpha: false })
  state.frameTimer = setInterval(async () => {
    // 抓「对端」的画面：助手要看的是对面的人，不是自己发出的皮套
    const v = ui.remote
    if (!v.videoWidth) return
    ctx.drawImage(v, 0, 0, W, H)
    const jpeg = canvas.toDataURL('image/jpeg', q).split(',')[1]
    await api('/api/frame', { room: ROOM, token: TOKEN, peer: state.peerId, jpeg, width: W, height: H }).catch(() => {})
  }, Math.round(1000 / fps))
  logLine(`抽帧已开（${fps} fps / ${W}×${H}，抓对端画面）`)
}

/** 按需拉一帧高清：助手想「看清楚」时用这个 */
async function sendHighFrame() {
  const v = ui.remote
  if (!v.videoWidth) { showNotice('还没有对端画面，等对方接通'); return }
  const maxW = Number(state.cfg?.highWidth) || 1280
  const W = Math.min(maxW, v.videoWidth)
  const H = Math.round((W * v.videoHeight) / v.videoWidth)
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  canvas.getContext('2d', { alpha: false }).drawImage(v, 0, 0, W, H)
  const jpeg = canvas.toDataURL('image/jpeg', 0.85).split(',')[1]
  const r = await api('/api/frame', { room: ROOM, token: TOKEN, peer: state.peerId, jpeg, width: W, height: H }).catch(() => ({}))
  logLine(`高清帧：${W}×${H} ${r.ok ? '已送达' : '失败'}`)
}

function stopFrames() {
  if (state.frameTimer) { clearInterval(state.frameTimer); state.frameTimer = null; logLine('抽帧已停') }
}

// ── 交互 ────────────────────────────────────────────────────────────────
ui.btnDevices.addEventListener('click', () => { void grantDevices() })

ui.btnStart.addEventListener('click', async () => {
  try {
    await grantDevices()
    setupAudioContext()
    await state.ac.resume()
    await ensureCamera()
    createPc()
    if (state.pendingOffer) {
      const msg = state.pendingOffer
      state.pendingOffer = null
      await onOffer(msg)
      return
    }
    await maybeOffer()
    setPeer(state.others ? '协商中…' : '等对端进房', true)
  } catch (e) {
    showNotice(`开始失败：${e.name || ''} ${e.message || e}`)
    logLine(`开始失败：${e?.stack || e}`)
  }
})

ui.btnHangup.addEventListener('click', () => {
  stopFrames()
  if (state.pc) { try { state.pc.close() } catch { /* 已关 */ } state.pc = null }
  for (const s of [state.mic, state.cam]) if (s) for (const t of s.getTracks()) t.stop()
  state.mic = null
  state.cam = null
  ui.local.srcObject = null
  ui.remote.srcObject = null
  logLine('已挂断（刷新页面可重新入场）')
})

ui.btnTone.addEventListener('click', async () => {
  if (!state.ac) { showNotice('先点「开始通话」把音频链建起来'); return }
  await state.ac.resume()
  try {
    const buf = await fetch('/api/tone').then((r) => r.arrayBuffer())
    const audio = await state.ac.decodeAudioData(buf)
    if (state.toneSource) { try { state.toneSource.stop() } catch { /* 已停 */ } }
    const src = state.ac.createBufferSource()
    src.buffer = audio
    src.connect(state.dest)
    src.start()
    state.toneSource = src
    logLine('测试音已灌进通话轨（本机不响，对端应该能听到）')
  } catch (e) {
    logLine(`测试音失败：${e.name} / ${e.message}`)
  }
})

ui.btnStopTone.addEventListener('click', () => {
  if (state.toneSource) { try { state.toneSource.stop() } catch { /* 已停 */ } state.toneSource = null; logLine('测试音已停') }
})

ui.chkFrame.addEventListener('change', () => {
  if (ui.chkFrame.checked) startFrames()
  else stopFrames()
})

if (ui.btnHiRes) {
  ui.btnHiRes.addEventListener('click', () => { void sendHighFrame() })
}

// 本地画面（小窗）折叠：✕ 收起，「我的画面」再展开
if (ui.localBadge && ui.btnHideLocal && ui.btnShowLocal) {
  const setLocalHidden = (hidden) => {
    ui.localBadge.classList.toggle('hidden', hidden)
    ui.btnShowLocal.classList.toggle('hidden', !hidden)
  }
  ui.btnHideLocal.addEventListener('click', () => setLocalHidden(true))
  ui.btnShowLocal.addEventListener('click', () => setLocalHidden(false))
}

void join()
  .then(async () => {
    if (!AUTO) return
    await new Promise((r) => setTimeout(r, 800))
    logLine(`AUTO：自动开始（cam=${CAM_MATCH || '默认'}）`)
    await grantDevices()
    if (AUTO_FRAME && ui.chkFrame) {
      ui.chkFrame.checked = true
      startFrames()
    }
    ui.btnStart.click()
  })
  .catch((e) => {
    setPeer('未连接', false)
    logLine(`启动失败：${e?.message || e}`)
  })
