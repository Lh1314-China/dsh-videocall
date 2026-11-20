/**
 * static/panel.js —— 控制面板的前端逻辑（原生 ES 模块，零依赖）
 * ============================================================================
 * 只和本机回环打交道：状态轮询、激活/停用隧道、保存路径。
 * 管理端点服务端会拒绝非回环访问，所以这页放外面也调不动。
 * ============================================================================
 */
const $ = (id) => document.getElementById(id)

const ui = {
  pillService: $('pillService'),
  pillTunnel: $('pillTunnel'),
  pillRooms: $('pillRooms'),
  statusTable: $('statusTable'),
  btnActivate: $('btnActivate'),
  btnDeactivate: $('btnDeactivate'),
  btnRefresh: $('btnRefresh'),
  actionMsg: $('actionMsg'),
  pathsForm: $('pathsForm'),
  pathsMsg: $('pathsMsg'),
}

const FIELD_IDS = ['tunnelBin', 'tlsPfx', 'tlsPass', 'avatarMatch', 'obsPath', 'vtsPath']
let timer = null

const esc = (s) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

function pill(el, text, state) {
  el.textContent = text
  el.className = 'pill' + (state ? ' ' + state : '')
}

const row = (k, v) => `<tr><td>${esc(k)}</td><td class="mono">${esc(v)}</td></tr>`

function say(el, text, kind) {
  el.textContent = text
  el.className = 'msg' + (kind ? ' ' + kind : '')
}

async function load() {
  try {
    const r = await fetch('/api/panel', { cache: 'no-store' })
    const j = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(j.detail || j.error || 'HTTP ' + r.status)
    render(j)
  } catch (e) {
    ui.statusTable.innerHTML = row('错误', String(e?.message ?? e))
    pill(ui.pillService, '服务 不可达', 'off')
  }
}

function render(j) {
  const svc = j.service || {}
  const tun = j.tunnel || {}
  const rooms = j.rooms || []
  const frames = j.frames || []

  pill(ui.pillService, svc.running ? `服务 ${svc.listen}` : '服务 未运行', svc.running ? 'on' : 'off')
  pill(ui.pillTunnel, tun.running ? '隧道 已开' : '隧道 已关', tun.running ? 'on' : 'off')
  pill(ui.pillRooms, `房间 ${rooms.length}`, rooms.length ? 'on' : '')

  const rows = []
  rows.push(row('监听', svc.listen || '—'))
  rows.push(row('HTTPS', svc.tls ? '已开启' : '未开启'))
  rows.push(row('局域网模式', svc.lanMode ? '是' : '否'))
  rows.push(row('对外地址', svc.url || '—'))
  rows.push(row('隧道', tun.running ? (tun.url || '—') : '未启动'))
  if (tun.running) rows.push(row('隧道时长', (tun.uptimeSec || 0) + ' 秒'))
  if (tun.lastError) rows.push(row('隧道错误', tun.lastError))

  for (const rm of rooms) {
    const peers = (rm.peers || [])
      .map((p) => p.id + (p.online ? ' · 在线' : ' · 离线'))
      .join(' / ') || '无对端'
    rows.push(row('房间 ' + String(rm.id).slice(0, 8), (rm.label || '未命名') + ' · ' + peers))
  }

  const fr = frames[0]
  if (fr) rows.push(row('最近一帧', `${fr.width}×${fr.height} · ${fr.bytes} 字节 · ${fr.ageSec} 秒前`))

  ui.statusTable.innerHTML = rows.join('')

  const paths = j.paths || {}
  for (const k of FIELD_IDS) {
    const el = $('p_' + k)
    if (el && !el.dataset.touched) el.value = paths[k] || ''
  }
}

async function post(path, body) {
  const r = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(j.detail || j.error || 'HTTP ' + r.status)
  return j
}

ui.btnActivate.addEventListener('click', async () => {
  ui.btnActivate.disabled = true
  say(ui.actionMsg, '正在起隧道…')
  try {
    const j = await post('/api/panel/activate')
    if (j.ok) say(ui.actionMsg, '已激活：' + (j.url || ''), 'ok')
    else say(ui.actionMsg, '没起来：' + (j.message || j.reason || '未知原因'), 'err')
    await load()
  } catch (e) {
    say(ui.actionMsg, String(e?.message ?? e), 'err')
  } finally {
    ui.btnActivate.disabled = false
  }
})

ui.btnDeactivate.addEventListener('click', async () => {
  ui.btnDeactivate.disabled = true
  say(ui.actionMsg, '正在切断…')
  try {
    const j = await post('/api/panel/deactivate')
    say(ui.actionMsg, j.stopped ? '已切断（原地址 ' + (j.previousUrl || '') + '）' : '隧道本来就没开', 'ok')
    await load()
  } catch (e) {
    say(ui.actionMsg, String(e?.message ?? e), 'err')
  } finally {
    ui.btnDeactivate.disabled = false
  }
})

ui.btnRefresh.addEventListener('click', () => { void load() })

ui.pathsForm.addEventListener('submit', async (ev) => {
  ev.preventDefault()
  const payload = {}
  for (const k of FIELD_IDS) payload[k] = ($('p_' + k)?.value || '').trim()
  try {
    const j = await post('/api/panel/paths', payload)
    say(ui.pathsMsg, j.note || '已保存', 'ok')
    await load()
  } catch (e) {
    say(ui.pathsMsg, String(e?.message ?? e), 'err')
  }
})

for (const k of FIELD_IDS) {
  const el = $('p_' + k)
  if (el) el.addEventListener('input', () => { el.dataset.touched = '1' })
}

void load()
timer = setInterval(() => { void load() }, 5000)
window.addEventListener('beforeunload', () => { if (timer) clearInterval(timer) })
