# DESIGN · dsh-videocall

> 一句话：**插件在 127.0.0.1 起一个独立小服务，两个浏览器用 WebRTC 直连；助手出镜靠 OBS 虚拟摄像头，出声靠 Web Audio 造轨，"看"用户靠 canvas 抽帧回传。**

```
┌─────────────── 一台 Windows（DSH 桌面版 0.2.2.0）───────────────┐
│                                                                  │
│  VTube Studio ──Spout2/窗口──► OBS ──虚拟摄像头──► Chromium 设备枚举 │
│        ▲                                             │           │
│        │ ws://127.0.0.1:8001（口型/表情，现有链路）      │ getUserMedia
│  vtube-bridge（VTS 控制台）                      ▼           │
│                                                   ┌──────────┐   │
│  DSH Host ── dsh-videocall 插件 ──┬──────────────►│ 通话页 A │   │
│                                   │  127.0.0.1:8790│ (助手侧) │   │
│                                   │  HTTP + SSE   └────┬─────┘   │
│                                   │                     │ WebRTC│
│                                   │  ┌──────────────┐   │       │
│                                   └─►│ 独立通话服务  │◄──┘       │
│                                      │ 房间/令牌/信令 │           │
│                                      │ 抽帧接收       │◄──────┐   │
│                                      └──────────────┘       │   │
│                                                             │   │
└─────────────────────────────────────────────────────────────┼───┘
                                                              │
                                     手机浏览器（同一个 URL）──┘
                                     P2 时经 Cloudflare 隧道
```

---

## 1. 四个必答问题

### 1.1 插件自起 HTTP 怎么和 DSH 主服务共存？

**各占各的端口，互不注册。**

- DSH 的 Web 前端走自己的 Typert Gateway（WebSocket upgrade + RPC，见 RESEARCH 参考 7，版本 `0.2.2-rc.3`），那是 Host↔官方 Client 的私有协议，**不对外开放挂载点**；
- 本插件在 `apply()` 里 `listen(127.0.0.1, 8790)`，端口被占就 `+1` 重试（最多 6 次），把真实端口写进日志和 `videocall_status`；
- 生命周期挂在 `ctx.effect(() => () => server.close())`：插件卸载 → 服务关；插件重载 → 重新起；
- **失败不致命**：端口全占就记一行日志、注册 0 个工具，DSH 照常跑（跟 `dsh-shiori-shore` 同一条纪律）。

### 1.2 插件能不能注册 WebSocket upgrade？签名大致什么样？

- **没有公开的第三方挂载点**（`host-plugin.md` / `plugin-development.md` 里都没有；Gateway 的 upgrade 是它自己的 `ctx.appReady` 之后注册的）——**这一点标"未核实"的部分是：是否存在未文档化的私有挂载**，本版不去碰。
- 所以**我们不用 WebSocket**，信令改成 **SSE + POST**：
  - `GET /api/events?...` → `text/event-stream`，服务端 `res.write("event: answer\ndata: {...}\n\n")`；
  - `POST /api/signal` → 把 offer / answer / candidate 转发给房间里的另一位；
  - 好处：零依赖（Node 内置没有 WS 服务端，`ws` 是外部包）、跨隧道更稳、抓包可读；
  - 代价：单向推送（信令本来就低频，够用）；每个 peer 一条长连接（2 人房间最多 2 条）。

### 1.3 静态资源（HTML/JS）怎么发？

`server/index.js` 的 `sendFile()`：

- 只发 `static/` 下的白名单扩展名（`.html/.js/.css/.svg/.json`）；
- `resolve()` 之后校验 `file.startsWith(root + sep)`，挡 `../` 穿越（实测 `GET /../package.json` 返回 404）；
- `cache-control: no-store`（这是开发期页面，缓存只会让人怀疑"改了没生效"）。

### 1.4 插件 Config 怎么定义与持久化？

- 形态：`export const Config = z.object({...})`（RESEARCH 参考 3）；字段只有 `boolean / string / natural / array`，**不用 `.extra()`、不写 `.max()`**（`hostdeps.mjs` 里记的两个真实回归）；
- 持久化：**由 profile 的 `cordis.patch.yml` 承载**，插件自己不写 profile（`plugin-development.md` 明令）；
- 降级：schemastery 拿不到 ⇒ `Config = undefined`，配置照旧从 `config:` 读，只是没有 schema 校验（本机已实测这条路径能加载）；
- 运行期状态（房间、令牌、最新帧）只在内存，**重启即清**——令牌本来就不该跨重启。

---

## 2. 一次通话的时序

```
A（助手侧标签页）                     服务                         B（手机/另一标签页）
   │  POST /api/join {room, token}     │                                  │
   │─────────────────────────────────►│◄──── POST /api/join ─────────────│
   │  {peerId, initiator:true}         │      {peerId, initiator:false}   │
   │  GET /api/events (SSE)            │                                  │
   │─────────────────────────────────►│◄──── GET /api/events ────────────│
   │◄── event: peer-joined ────────────│                                  │
   │  createOffer → setLocalDesc       │                                  │
   │  POST /api/signal {type:offer}    │                                  │
   │─────────────────────────────────►│──── event: offer ───────────────►│
   │                                   │        setRemoteDesc → answer    │
   │◄── event: answer ─────────────────│◄──── POST /api/signal {answer} ──│
   │  ICE candidate ⇄ 双向转发          │                                  │
   │═══════════════════════ DTLS/SRTP 直连（不经服务）═══════════════════│
   │  POST /api/frame (1 fps jpeg) ◄────│                                  │
```

要点：**媒体不走服务**（服务只转发几十条信令），所以 8790 端口的负载与视频清晰度无关。

---

## 3. 媒体拓扑

| 方向 | 轨道 | 来源 | 说明 |
|---|---|---|---|
| A → B | video | `getUserMedia({video:{deviceId: OBS}})` | 皮套画面；没选设备就不送画面 |
| A → B | audio | `MediaStreamAudioDestinationNode.stream` | 助手声音，**零驱动**；不发声时是静音轨 |
| A → B | audio(可选) | 麦克风 | 助手真人说话时才需要，默认不加 |
| B → A | video | 手机前摄 / 另一台摄像头 | 用户的脸 |
| B → A | audio | 麦克风 | 用户说话（第一版不做服务端 ASR） |
| B → A | 抽帧 | canvas 160×120 JPEG | 1 fps，POST 回 `/api/frame` |

**为什么不用"把 mp3 塞进 VTS"**：那条路是本地播放 + 推参数（RESEARCH 参考 2），声音到不了浏览器。浏览器要的是 `MediaStreamTrack`，Web Audio 的 `MediaStreamAudioDestinationNode` 正好给一条（RESEARCH 参考 5）。

**为什么保留静音轨**：一开始就 `addTrack`，SDP 稳定；等真要说话时只是往 `dest` 里 `connect` 一个 source，不用重新协商。

---

## 4. 画面链路与"没有 OBS"的兜底

首选链：`VTS → Spout2 输出 → OBS 的 Spout2 源 → OBS 虚拟摄像头 → Chromium enumerateDevices`。

- Spout2 需要 OBS 装 `obs-spout2-plugin`（**本机未装 OBS，也未验证该插件版本**，标未核实）；
- 退一步：OBS 直接窗口捕获 VTS 窗口（慢半拍、可能有黑边，但零插件）。

**兜底链（不装 OBS 也能跑）**：浏览器 `getDisplayMedia()` 让用户手动选 VTS 窗口 → 得到 video track → 直接进 `RTCPeerConnection`。
代价：每次通话要用户点一次"共享窗口"，页面顶部有共享提示条；且要求 VTS 窗口不被最小化遮挡。**这条兜底是本设计新增的，未实测**。

---

## 5. "助手看用户"：抽帧 → 附件 → 工具

1. B 侧（以及任何开了抽帧的页面）每秒把本地预览画到 160×120 canvas，`toDataURL('image/jpeg', 0.55)`；
2. `POST /api/frame`，服务端校验令牌后交给插件回调，插件只保留**每个房间最新一帧**（内存，最多 6 间）；
3. 助手调 `videocall_look` → `ctx.get('attachments').saveImage({data, mediaType:'image/jpeg', name})` → 工具输出 `{type:'text'} + {type:'image', attachment}`（RESEARCH 参考 8 的原样路径）；
4. 没开抽帧 / 没授权 → 工具直接报"还没有画面"，**不编造**。

为什么 160×120：一眼看轮廓/表情/是否在镜头里够了；真要细节再让对方切"原图档"（P3）。

---

## 6. 安全模型

| 面 | 做法 |
|---|---|
| 绑定地址 | 默认 `127.0.0.1`，**代码里没有 `0.0.0.0` 分支**；要上手机走隧道（P2） |
| 房间令牌 | `randomBytes(16).toString('base64url')`，`timingSafeEqual` 定长比较；一房一令牌 |
| 令牌传递 | 页面 URL 参数 + SSE 查询串（EventSource 不能带自定义头，这是硬约束） |
| 房间容量 | 最多 2 个 peer，满了返回 `room-full` |
| 请求体 | JSON 上限 1 MB，帧上限 4 MB，超了直接 413/断开 |
| 静态资源 | 扩展名白名单 + `startsWith(root+sep)` 防穿越 |
| 日志 | 不打印令牌全文；房间只打前 8 位 |
| 不碰的东西 | DSH 主端口、profile 文件、内核/驱动、外部 exe |

> 已知弱点（不粉饰）：令牌在 URL 里，会进浏览器历史；本版**没有**做一次性消费与来源校验（Origin 检查）。P2 上隧道前必须补：令牌一次性 + 短 TTL + `Origin` 白名单。

---

## 7. 配置（`cordis.patch.yml` 的 `config:`）

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `host` | `127.0.0.1` | 只允许回环；**别改成 `0.0.0.0`** |
| `port` | `8790` | 被占自动 +1（最多 6 次） |
| `tokenTtlSec` | `3600` | 房间令牌有效期 |
| `iceServers` | `stun:stun.l.google.com:19302` | 字符串数组，内部转 `{urls}` |
| `publicBaseUrl` | 空 | 走隧道后填 `https://xxx.trycloudflare.com`，`videocall_room` 生成的就是这个前缀 |
| `dataDir` | 空 → `~/.dsh/dsh-videocall` | 数据目录 |

工具面（4 个）：`videocall_room`（开房给链接）、`videocall_status`（端口/房间/帧）、`videocall_look`（看一眼，出图）、`videocall_ping`（往页面推一行提示）、`videocall_stop`（关服务）。

---

## 8. 阶段与判据

| 阶段 | 内容 | 通过判据 |
|---|---|---|
| **P0** | VTS → OBS → 浏览器能枚举并打开虚拟摄像头 | `p0.html` 里 label 含 `OBS`，打开后 `settings.width ≥ 640`、`readyState === 'live'` |
| **P1** | localhost 双标签页自环：信令 + 媒体 + 抽帧 + 测试音 | 两边 `connectionState === 'connected'`；B 能听到 A 的测试音；`videocall_look` 能出图 |
| **P2** | 隧道（Cloudflare Quick Tunnel）手机扫码 | 手机与桌面 `connectionState==='connected'`，抽帧 < 3 秒延迟；补令牌一次性 + Origin 白名单 |
| **P3** | 接 DSH：真 TTS（edge-tts 出 mp3 → Web Audio 轨）、口型同步（复用包络算法）、来电唤醒会话（`sessionController.prompt`） | 说话有口型；被叫醒的会话里出现通话事件 |

**P0 不通，后面全省**——这条是任务书原话，本设计照办。

---

## 9. 我没核实的东西（显式清单）

1. **OBS 的 Spout2 插件**：具体包名/版本/是否支持 VTS 直出——本机没装 OBS，未核实。
2. **`OBS Virtual Camera` 在 Edge/Chromium 下是否需要 640×480 才能被枚举**：任务书里这条其实是 **QQ 的限制**，浏览器侧未见证据，未核实。
3. **Cloudflare Quick Tunnel 国内连通性与延迟**：未实测。
4. **对称 NAT 下只靠 STUN 的失败率**：未实测；失败时 P2 需自建 TURN。
5. **`getDisplayMedia` 抓 VTS 窗口**的实际帧率与黑边情况：未实测（兜底方案）。
6. **`ctx.get('attachments')` 在通话插件上下文里是否一定挂载**：代码已做空值保护，但"一定在"未核实。
7. **是否存在未文档化的插件 WS upgrade 挂载点**：未核实（本版不碰）。
8. **VTS 的 `InjectParameterData` 是否需要单独 Permission**：未核实（本地脚本未申请也能推）。
