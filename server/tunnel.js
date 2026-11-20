/**
 * server/tunnel.js —— Cloudflare Quick Tunnel 的开关（阀门）
 * ============================================================================
 * 为什么单独一个模块：隧道是「临时借道」，必须能一键切断。
 *  - start()：拉起 cloudflared，等它吐出 https://xxx.trycloudflare.com
 *  - stop() ：立刻杀掉子进程，公网通道断开（本机服务不受影响）
 *  - status()：跑没跑、地址是什么、跑了多久
 *
 * 不写死二进制路径：调用方传进来，找不到就明确报错。
 * ============================================================================
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'

const URL_RE = /https:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com/iu
const START_TIMEOUT_MS = 40_000

export function createTunnel({ binPath = '', targetPort = 8790, log = () => {} } = {}) {
  let child = null
  let url = ''
  let startedAt = 0
  let lastError = ''
  let lastOutput = ''

  const isRunning = () => Boolean(child && child.exitCode === null)

  function killChild() {
    if (!child) return
    try {
      if (process.platform === 'win32') {
        // Windows 上 cloudflared 会派生子进程，kill 树才干净
        spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
      } else {
        child.kill('SIGTERM')
      }
    } catch { /* 已经没了 */ }
    child = null
  }

  function start() {
    if (!binPath) return Promise.resolve({ ok: false, reason: 'missing-bin', message: '没配置 cloudflared 路径' })
    if (!existsSync(binPath)) return Promise.resolve({ ok: false, reason: 'bin-not-found', message: `找不到 ${binPath}` })
    if (isRunning()) return Promise.resolve({ ok: true, already: true, url })

    url = ''
    lastError = ''
    lastOutput = ''
    startedAt = Date.now()

    return new Promise((resolve) => {
      let settled = false
      const done = (v) => { if (!settled) { settled = true; resolve(v) } }

      try {
        // 国内网络下 QUIC/IPv6 常被卡：强制 HTTP/2 + IPv4 更容易通
        child = spawn(binPath, [
          'tunnel',
          '--no-autoupdate',
          '--protocol', 'http2',
          '--edge-ip-version', '4',
          '--url', `http://127.0.0.1:${targetPort}`,
        ], {
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      } catch (e) {
        done({ ok: false, reason: 'spawn-failed', message: String(e?.message ?? e) })
        return
      }

      const onData = (buf) => {
        const text = String(buf)
        lastOutput = (lastOutput + text).slice(-4000)
        const m = text.match(URL_RE) || lastOutput.match(URL_RE)
        if (m && !url) {
          url = m[0]
          log(`隧道已建立：${url}`)
          done({ ok: true, url })
        }
        if (/ERR_|failed|error/i.test(text)) lastError = text.trim().slice(0, 300)
      }
      child.stdout?.on('data', onData)
      child.stderr?.on('data', onData)
      child.on('exit', (code) => {
        const wasRunning = Boolean(url)
        child = null
        if (!wasRunning) done({ ok: false, reason: 'exited', code, message: lastError || lastOutput.slice(-300) })
        else log(`隧道进程退出 code=${code}`)
      })
      child.on('error', (e) => { lastError = String(e?.message ?? e); done({ ok: false, reason: 'error', message: lastError }) })

      setTimeout(() => {
        if (!url) done({ ok: false, reason: 'timeout', message: lastError || lastOutput.slice(-300) || '40 秒内没拿到隧道地址' })
      }, START_TIMEOUT_MS)
    })
  }

  function stop() {
    const had = isRunning()
    killChild()
    const wasUrl = url
    url = ''
    startedAt = 0
    log(had ? `隧道已切断（原地址 ${wasUrl}）` : '隧道本来就没开')
    return { ok: true, stopped: had, previousUrl: wasUrl }
  }

  function status() {
    return {
      running: isRunning(),
      url: url || '',
      host: url ? (() => { try { return new URL(url).host } catch { return '' } })() : '',
      uptimeSec: startedAt ? Math.round((Date.now() - startedAt) / 1000) : 0,
      lastError,
    }
  }

  return { start, stop, status, isRunning }
}
