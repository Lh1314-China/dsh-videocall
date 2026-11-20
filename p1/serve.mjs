/**
 * p1/serve.mjs —— P1 自环：起通话服务 + 建一间房 + 打印两个可直接打开的 URL
 * ============================================================================
 *   node p1/serve.mjs          # 默认 8790
 *   node p1/serve.mjs 8793
 *
 * 两个 URL 的差别只在 `cam=`：
 *   HOST  → 用 OBS 虚拟摄像头（皮套那一路）
 *   GUEST → 用物理摄像头（人那一路）
 * 程序会一直跑，Ctrl+C 结束。
 * ============================================================================
 */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startCallServer } from '../server/index.js'

const here = dirname(fileURLToPath(import.meta.url))
const root = dirname(here)
const port = Number(process.argv[2] || 8790)

const srv = await startCallServer({
  port,
  staticDir: join(root, 'static'),
  log: (m) => console.log('[call]', m),
  publicConfig: {
    avatarMatch: 'obs',
    avatarWidth: 1280,
    avatarHeight: 720,
    avatarFps: 30,
    avatarMirror: false,
    lowWidth: 160,
    lowFps: 1,
    jpegQuality: 0.55,
    highWidth: 1280,
  },
})

const room = srv.createRoom({ label: 'p1-selfloop' })
const base = `http://127.0.0.1:${srv.port}/call.html`
const q = `room=${encodeURIComponent(room.id)}&t=${encodeURIComponent(room.token)}`

console.log('')
console.log('ROOM  ' + room.id)
console.log('HOST  ' + `${base}?${q}&auto=1&cam=obs`)
console.log('GUEST ' + `${base}?${q}&auto=1&cam=FHD`)
console.log('')
console.log('（Ctrl+C 结束）')
