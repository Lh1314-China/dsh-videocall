/**
 * dsh-videocall · client 半端
 *
 * 形状参照一个已有的侧栏面板插件：一个侧栏图标 + 一张整页面板。
 * 数据全部来自 Host 的 /__videocall/panel（同源，不碰外部 HTTPS 服务）。
 *
 * 客户端能用的服务有限（layout / slots / sessions / locale / theme / timer），
 * 读文件、起进程都得由 Host 供，所以这里只负责渲染与调用。
 */

window.__ModuleLoader__.load({
  id: 'dsh-videocall',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback } = React

    const API = '/__videocall/panel'

    async function getPanel() {
      const res = await fetch(API, { cache: 'no-store' })
      if (!res.ok) throw new Error('HTTP ' + res.status)
      return res.json()
    }

    async function postPanel(body) {
      const res = await fetch(API, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error((j && j.error) || 'HTTP ' + res.status)
      return j
    }

    // ── 侧栏图标：一台摄像机 ────────────────────────────────────
    function VideocallIcon() {
      return h(
        'svg',
        { viewBox: '0 0 24 24', width: 18, height: 18, 'aria-hidden': true, style: { display: 'block' } },
        h('rect', {
          x: 2, y: 6, width: 13, height: 12, rx: 2.5,
          fill: 'none', stroke: 'currentColor', strokeWidth: 1.8,
        }),
        h('path', {
          d: 'M15 10l6-3v10l-6-3z',
          fill: 'none', stroke: 'currentColor', strokeWidth: 1.8,
          strokeLinejoin: 'round', strokeLinecap: 'round',
        }),
      )
    }

    const S = {
      // main 的容器限高且自己不滚，所以滚动必须由这一层负责。
      // 只写 overflow 不写 height：% 高度落空，照样滚不动。
      page: {
        height: '100%',
        maxHeight: '100%',
        boxSizing: 'border-box',
        overflowY: 'auto',
        padding: '20px 24px 72px',
        maxWidth: 820,
        margin: '0 auto',
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
        color: 'inherit',
        font: 'inherit',
      },
      h2: { fontSize: 16, margin: 0, fontWeight: 600 },
      card: { border: '1px solid rgba(127,127,127,.22)', borderRadius: 12, padding: 14, display: 'flex', flexDirection: 'column', gap: 10 },
      h3: { fontSize: 12, margin: 0, opacity: 0.62, letterSpacing: '.04em', fontWeight: 600 },
      row: { display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' },
      kv: { display: 'grid', gridTemplateColumns: '110px 1fr', rowGap: 5, fontSize: 13 },
      k: { opacity: 0.62 },
      v: { fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 12, wordBreak: 'break-all' },
      btn: { border: '1px solid rgba(127,127,127,.35)', background: 'transparent', color: 'inherit', padding: '8px 14px', borderRadius: 9, font: 'inherit', cursor: 'pointer' },
      btnOn: { borderColor: '#3c8a66', background: 'rgba(47,107,79,.28)' },
      btnOff: { borderColor: '#7a3242', background: 'rgba(90,37,48,.28)' },
      label: { fontSize: 12, opacity: 0.62, marginBottom: 3, display: 'block' },
      input: { width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid rgba(127,127,127,.3)', background: 'transparent', color: 'inherit', font: 'inherit', boxSizing: 'border-box' },
      msg: { fontSize: 12, opacity: 0.72, minHeight: 16 },
      err: { fontSize: 12, color: '#fca5a5' },
      ok: { fontSize: 12, color: '#6ee7b7' },
      hint: { fontSize: 12, opacity: 0.5 },
    }

    const FIELDS = [
      ['publicBaseUrl', '外部地址（自建隧道填这里）', '例如 https://frp.example.com 或 https://1.2.3.4:6000'],
      ['tunnelBin', 'cloudflared 可执行文件', '留空 = 插件目录 bin/cloudflared.exe'],
      ['tlsPfx', 'HTTPS 证书（PFX）', '留空 = 插件目录 certs/dev.pfx'],
      ['tlsPass', '证书口令', '默认 dsh-videocall'],
      ['avatarMatch', '皮套摄像头匹配关键字', 'obs'],
      ['obsPath', 'OBS 可执行文件（仅记录）', 'D:\\OBS\\bin\\64bit\\obs64.exe'],
      ['vtsPath', 'VTube Studio 可执行文件（仅记录）', '…\\VTube Studio.exe'],
    ]

    function VideocallPanel() {
      const [data, setData] = useState(null)
      const [err, setErr] = useState('')
      const [busy, setBusy] = useState('')
      const [msg, setMsg] = useState('')
      const [paths, setPaths] = useState({})
      const [dirty, setDirty] = useState(false)
      const [netName, setNetName] = useState('')
      const [netIp, setNetIp] = useState('')

      const load = useCallback(async () => {
        try {
          const j = await getPanel()
          setData(j)
          setErr('')
        } catch (e) {
          setErr(String((e && e.message) || e))
        }
      }, [])

      useEffect(() => {
        void load()
        const t = setInterval(() => { void load() }, 5000)
        return () => clearInterval(t)
      }, [load])

      useEffect(() => {
        if (data && data.paths && !dirty) setPaths(Object.assign({}, data.paths))
      }, [data, dirty])

      const act = async (action, extra) => {
        setBusy(action)
        setMsg('')
        try {
          const j = await postPanel(Object.assign({ action }, extra || {}))
          setMsg(j.note || (j.url ? '已激活：' + j.url : '完成'))
          await load()
        } catch (e) {
          setErr(String((e && e.message) || e))
        } finally {
          setBusy('')
        }
      }

      const savePaths = async () => {
        setBusy('savePaths')
        setMsg('')
        try {
          const j = await postPanel({ action: 'savePaths', paths })
          setMsg(j.note || '已保存')
          setDirty(false)
          await load()
        } catch (e) {
          setErr(String((e && e.message) || e))
        } finally {
          setBusy('')
        }
      }

      const svc = (data && data.service) || {}
      const tun = (data && data.tunnel) || {}
      const rooms = (data && data.rooms) || []
      const frames = (data && data.frames) || []

      const kvRows = [
        ['监听', svc.listen || '—'],
        ['HTTPS', svc.tls ? '已开启' : '未开启'],
        ['局域网', svc.lanMode ? '是' : '否'],
        ['对外地址', svc.url || '—'],
        ['隧道', tun.running ? (tun.url || '已开') : '未启动'],
      ]
      if (tun.running) kvRows.push(['隧道时长', (tun.uptimeSec || 0) + ' 秒'])
      if (tun.lastError) kvRows.push(['隧道错误', tun.lastError])
      for (const rm of rooms) {
        const peers = (rm.peers || []).map(function (p) { return p.id + (p.online ? '·在线' : '·离线') }).join(' ') || '无对端'
        kvRows.push(['房间 ' + String(rm.id).slice(0, 8), (rm.label || '未命名') + ' · ' + peers])
      }
      const fr = frames[0]
      if (fr) kvRows.push(['最近一帧', fr.width + '×' + fr.height + ' · ' + fr.bytes + ' 字节 · ' + fr.ageSec + ' 秒前'])

      const roomUrl = (data && data.room && data.room.url) || ''

      const copyRoomUrl = async () => {
        if (!roomUrl) return
        try {
          await navigator.clipboard.writeText(roomUrl)
          setMsg('链接已复制，发给手机就能进')
        } catch (e) {
          setMsg('复制失败，请手动选中下面那行文字')
        }
      }

      const openRoom = () => {
        if (!roomUrl) return
        window.open(roomUrl, '_blank', 'noopener')
      }

      const net = (data && data.network) || { list: [], currentIp: '', matched: '' }

      const addNet = async () => {
        setBusy('addNetwork')
        setMsg('')
        try {
          const j = await postPanel({ action: 'addNetwork', name: netName, ip: netIp })
          setMsg(j.note || '已添加')
          setNetName('')
          setNetIp('')
          await load()
        } catch (e) {
          setErr(String((e && e.message) || e))
        } finally {
          setBusy('')
        }
      }

      const delNet = async (ip) => {
        setBusy('removeNetwork')
        setMsg('')
        try {
          const j = await postPanel({ action: 'removeNetwork', ip })
          setMsg(j.note || '已删除')
          await load()
        } catch (e) {
          setErr(String((e && e.message) || e))
        } finally {
          setBusy('')
        }
      }

      const regen = async () => {
        setBusy('regenCert')
        setMsg('正在生成证书，可能要几秒…')
        try {
          const j = await postPanel({ action: 'regenCert' })
          setMsg(j.ok ? (j.note || '证书已更新') : ('失败：' + (j.detail || j.error || '未知原因')))
          await load()
        } catch (e) {
          setErr(String((e && e.message) || e))
        } finally {
          setBusy('')
        }
      }

      return h(
        'div',
        { style: S.page },
        h('h2', { style: S.h2 }, '视频通话'),
        err ? h('div', { style: S.err }, err) : null,
        msg ? h('div', { style: S.ok }, msg) : null,

        h(
          'div',
          { style: S.card },
          h('h3', { style: S.h3 }, '当前状态'),
          h(
            'div',
            { style: S.kv },
            kvRows.map(function (r, i) {
              return [
                h('div', { key: 'k' + i, style: S.k }, r[0]),
                h('div', { key: 'v' + i, style: S.v }, String(r[1])),
              ]
            }),
          ),
          h('div', { style: S.hint }, '每 5 秒自动刷新。'),
        ),

        h(
          'div',
          { style: S.card },
          h('h3', { style: S.h3 }, '常驻房链接'),
          h('div', { style: S.v }, roomUrl || '（还没就绪）'),
          h(
            'div',
            { style: S.row },
            h('button', {
              type: 'button',
              style: S.btn,
              disabled: !roomUrl,
              onClick: function () { void copyRoomUrl() },
            }, '复制链接'),
            h('button', {
              type: 'button',
              style: S.btn,
              disabled: !roomUrl,
              onClick: openRoom,
            }, '本机打开'),
          ),
          h('div', { style: S.hint }, '这个链接重启插件后仍然有效，手机存书签，下次直接进，不用再开新房。'),
        ),

        h(
          'div',
          { style: S.card },
          h('h3', { style: S.h3 }, '网络档案'),
          h(
            'div',
            { style: S.kv },
            [
              h('div', { key: 'k1', style: S.k }, '当前 IP'),
              h('div', { key: 'v1', style: S.v }, net.currentIp || '—'),
              h('div', { key: 'k2', style: S.k }, '匹配档案'),
              h('div', { key: 'v2', style: S.v }, net.matched || '（未登记，可加一个）'),
            ],
          ),
          (net.list || []).length
            ? h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
                net.list.map(function (n) {
                  return h(
                    'div',
                    { key: n.ip, style: { display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 } },
                    h('div', { style: { flex: '1 1 auto' } }, (n.name || '未命名') + '  ·  ' + n.ip),
                    h('button', {
                      type: 'button',
                      style: S.btn,
                      disabled: Boolean(busy),
                      onClick: function () { void delNet(n.ip) },
                    }, '删除'),
                  )
                }),
              )
            : h('div', { style: S.hint }, '还没有档案。加一个，换网络时就不用重配。'),
          h(
            'div',
            { style: S.row },
            h('input', {
              style: Object.assign({}, S.input, { flex: '1 1 150px', width: 'auto' }),
              placeholder: '网络名（如 宿舍）',
              value: netName,
              onChange: function (ev) { setNetName(ev.target.value) },
            }),
            h('input', {
              style: Object.assign({}, S.input, { flex: '1 1 150px', width: 'auto' }),
              placeholder: 'IP（如 10.1.2.3）',
              value: netIp,
              onChange: function (ev) { setNetIp(ev.target.value) },
            }),
            h('button', {
              type: 'button',
              style: S.btn,
              disabled: Boolean(busy),
              onClick: function () { void addNet() },
            }, '添加'),
          ),
          h(
            'div',
            { style: S.row },
            h('button', {
              type: 'button',
              style: Object.assign({}, S.btn, S.btnOn),
              disabled: Boolean(busy) || !(net.list || []).length,
              onClick: function () { void regen() },
            }, busy === 'regenCert' ? '生成中…' : '更新证书（把所有 IP 写进去）'),
          ),
          h('div', { style: S.hint }, '证书把所有 IP 包进去之后，换到哪个网络都不用重新生成。改完需重载插件。'),
        ),

        h(
          'div',
          { style: S.card },
          h('h3', { style: S.h3 }, '一键就位'),
          h(
            'div',
            { style: S.row },
            h('button', {
              type: 'button',
              style: Object.assign({}, S.btn, S.btnOn),
              disabled: Boolean(busy),
              onClick: function () { void act('activate') },
            }, busy === 'activate' ? '正在起…' : '激活（起公网隧道）'),
            h('button', {
              type: 'button',
              style: Object.assign({}, S.btn, S.btnOff),
              disabled: Boolean(busy),
              onClick: function () { void act('deactivate') },
            }, busy === 'deactivate' ? '正在切…' : '停用（切断隧道）'),
            h('button', {
              type: 'button',
              style: S.btn,
              onClick: function () { void load() },
            }, '刷新状态'),
          ),
          h('div', { style: S.hint }, '激活 = 打开公网隧道；停用立刻切断，本机通话不受影响。'),
        ),

        h(
          'div',
          { style: S.card },
          h('h3', { style: S.h3 }, '路径设置'),
          h('div', { style: S.hint }, '保存进 panel.json，重载插件后生效。'),
          FIELDS.map(function (f) {
            return h(
              'div',
              { key: f[0] },
              h('label', { style: S.label, htmlFor: 'vc-' + f[0] }, f[1]),
              h('input', {
                id: 'vc-' + f[0],
                style: S.input,
                placeholder: f[2],
                value: paths[f[0]] || '',
                onChange: function (ev) {
                  const next = Object.assign({}, paths)
                  next[f[0]] = ev.target.value
                  setPaths(next)
                  setDirty(true)
                },
              }),
            )
          }),
          h(
            'div',
            { style: S.row },
            h('button', {
              type: 'button',
              style: Object.assign({}, S.btn, S.btnOn),
              disabled: Boolean(busy),
              onClick: function () { void savePaths() },
            }, busy === 'savePaths' ? '保存中…' : '保存路径'),
          ),
        ),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('sidebar.panellist', function () {
          return ctx.slots.register(
            {
              name: 'sidebar.panellist',
              id: 'videocall-panel',
              order: 56,
              label: '视频通话',
            },
            VideocallIcon,
          )
        })

        ctx.slots.inject('main', function () {
          return ctx.slots.register(
            {
              name: 'main',
              key: 'videocall-panel',
            },
            VideocallPanel,
          )
        })
      },
    }
  },
})
