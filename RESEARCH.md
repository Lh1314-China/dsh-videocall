# RESEARCH · dsh-videocall

> 代号 `dsh-videocall`｜收件人：开发协作者｜发件人：作者｜日期 2026-11-20
>
> 纪律：能读到的写"已核实 + 出处"；读不到的写"未核实"；**不写"我印象中/一般来说"**。
> 本文件所有版本号、端口、字段名都来自本机磁盘上的真实文件或当场抓取的官方页面。

---

## 参考 1：VTube Studio Public API（官方开发页）

- **出处**：https://github.com/DenchiSoft/VTubeStudio （GitHub，DenchiSoft；页面实测可访问，2026-11-20 抓取）
- **解决什么**：助手"出镜"的脸从哪来、怎么让它张嘴。VTS 是本地 WebSocket 服务，外部脚本可以推参数、触发热键、读模型状态。
- **关键事实（页面原文）**：
  - 默认端点 `ws://localhost:8001`，**用户可在 App 里改端口**；
  - 每条请求必须带 `"apiName": "VTubeStudioPublicAPI"` 与 `"apiVersion": "1.0"`；
  - UDP 在 `47779` 每 2 秒广播一次实例信息（`instanceID` / `windowTitle` / `port`），可用来发现多开实例；
  - 连不上时先让用户确认 VTS 主界面勾了 **"Allow Plugin API access"**；
  - 注参数的标准报文（原文示例）：
    ```json
    {
      "apiName": "VTubeStudioPublicAPI",
      "apiVersion": "1.0",
      "requestID": "SomeID",
      "messageType": "InjectParameterDataRequest",
      "data": {
        "faceFound": false,
        "mode": "set",
        "parameterValues": [ { "id": "FaceAngleX", "value": 12.31 } ]
      }
    }
    ```
- **坑**：
  - 端口可改 ⇒ 我们的插件必须把端口做成配置，不能写死 8001；
  - 文档提到"部分能力需要额外 Permission"，但**具体是否包含 `InjectParameterData` 未核实**——本机脚本没显式申请权限也能推 `MouthOpen`（见参考 2 的运行记录），所以这一版按"能推"设计，权限异常留到 P3 再查。
- **我们怎么用**：`dsh-videocall` **不直连 VTS**。VTS 的画面交给 OBS（Spout2 或窗口捕获），口型仍由 `vtube-bridge` 那条现有链路负责。通话插件只消费"已经是画面的东西"。

---

## 参考 2：本机 `vtube-bridge/vts_client.py` + `vts_speak.py`（源码级，非公开文档）

- **出处**：
  - `vtube-bridge\vts_client.py`（190 行）
  - `vtube-bridge\vts_speak.py`（152 行）
  - 同目录 `vts_token.json` 存在 ⇒ 这台机器上 VTS 鉴权**成功过**
- **解决什么**：把"VTS 怎么鉴权、口型怎么算"从文档层面落到能跑的代码层面。
- **关键实现（读到的原文要点）**：
  - 连接：`websockets.sync.client.connect("ws://127.0.0.1:8001")`；信封 `{apiName:"VTubeStudioPublicAPI", apiVersion:"1.0", requestID:<uuid4 hex>, messageType, data}`；
  - 鉴权两步：`AuthenticationTokenRequest{pluginName, pluginDeveloper}` → 拿 `data.authenticationToken` 落盘 → `AuthenticationRequest{pluginName, pluginDeveloper, authenticationToken}` → `data.authenticated`；
  - 口型参数确认是 **`MouthOpen`（0~1）**，叠加 `MouthSmile`；表情走 `ExpressionActivationRequest`；热键先 `HotkeysInCurrentModelRequest` 按名字查 ID，再 `HotkeyTriggerRequest`；
  - TTS：`edge_tts`，voice `zh-CN-XiaoyiNeural`、rate `+8%`、pitch `+4Hz`，输出 mp3；
  - 包络算法（30fps）：RMS → 归一化 `(v/peak)**0.65` → 一阶平滑 `prev*0.55 + v*0.45` → 下限 `0.02`；
  - 播放：WinMM MCI（`mciSendStringW`，`open ... type mpegvideo alias`），播完归零。
- **坑**：
  - 这条链路是"**本地播放 + 按时间轴推参数**"，不是"把音频塞进 VTS"。所以它**不能**直接给浏览器供声；
  - MCI 播放与 VTS 注入之间靠 `time.time()` 对齐，机器一卡就会漂。
- **我们怎么用**：包络算法直接复用（将来真 TTS 时按帧算 `MouthOpen`）；但**通话的声音走另一条路**：浏览器 Web Audio 造 audio track（参考 5）。

---

## 参考 3：DSH 官方 Host 插件文档 `host-plugin.md`

- **出处**（本机 app.asar 内，已解包到 `%TEMP%\asar-out\`）：
  `dsh/node_modules/@deepseek-ai/dsh-agent-preset/skills/dsh-doc/references/host-plugin.md`（6489 字节）
- **解包方法（已核实，写下来备查）**：`app.asar` 不是标准 asar 头——它是 Chromium Pickle：偏移 4/8/12 各一个 uint32，**JSON 长度在偏移 12，JSON 从偏移 16 开始**，`base = 16 + JSON长度`，文件数据 = `base + offset`。
- **解决什么**：插件长什么样、怎么被 DSH 认出来。
- **关键实现（原文要点）**：
  - bundle = `package.json` 声明 `dsh.bundle.patch`；patch 里 `insert` 一行插件；
    ```yaml
    - insert:
        - id: my-plugin
          name: '@local/my-plugin'
          config: {}
    ```
  - `index.js` 只能二选一：`export function apply(ctx, config) {}`（可带 `export const inject = ['tools']` 与 `export const Config`），或默认导出一个 service class；
  - 所有资源在 `apply` 里用 `ctx.effect` / `ctx.on` 注册，并返回清理函数；
  - 声明了 `Config` 就会在激活时校验该行的 `config`；改已安装插件的 config 前，先经 `Config.listConfigs` 读 schema；
  - 安装走 `plugin_manager` 的 `install_bundle`（**不要**手写 profile 的 `package.json` / `cordis.patch.yml`，不要在 profile 里跑 pnpm）；
  - 新 bundle 可经 HMR 激活；**替换已安装的包要重启**才会加载新的 JS 代。
- **坑**：`Config` 的 schema 库（schemastery）在桌面版 profile 里常常拿不到（参考 6 的 hostdeps 注释里有完整复现），裸 import 会让整条插件不激活。
- **我们怎么用**：`index.js` 严格照这个形态写；schema 加载失败就**不声明 Config**，配置从 patch 的 `config:` 直接读（本插件的 `index.js` 已这样实现并实测可加载）。

---

## 参考 4：DSH 插件开发流程 `plugin-development.md`

- **出处**：同参考 3 目录下 `plugin-development.md`（5461 字节）
- **解决什么**：交付顺序与"别自作主张改 profile"的边界。
- **关键事实**：
  - 先交付**能跑的最小版本**，再谈视觉；用装好的插件当第一预览，**不要先做 HTML 样张/截图脚本**；
  - 能查 `cordis_inspect_list` / `cordis_inspect_query` 就先查真实注册，再读包 README；
  - `DSH_PROFILE` / `DSH_PROFILE_DIR` 在 profile 启动的 shell 里才有；`dsh --profile "$DSH_PROFILE" --dump-config` 可打印合成后的 profile。
- **坑**：文档明确"不要用 logs / 进程列表 / 页面启动载荷判断是否生效"，要看 `application` 与 `warnings`。
- **我们怎么用**：本包的交付说明按"目录 + 安装方式 + 未核实项"写，不假装已验证 UI。

---

## 参考 5：MDN `MediaStreamAudioDestinationNode`

- **出处**：https://developer.mozilla.org/en-US/docs/Web/API/MediaStreamAudioDestinationNode （实测可访问，2026-11-20）
- **解决什么**：助手的声音怎么"零驱动"进 WebRTC。
- **关键实现（原文要点）**：
  - `AudioContext.createMediaStreamDestination()` 得到一个 `MediaStreamAudioDestinationNode`；
  - `.stream` 是**只含一条 audio track 的 MediaStream**，可直接喂给 `RTCPeerConnection`；
  - 基线支持：Chrome 57 / Edge 79 / Firefox 53 / Safari 14.1。
- **坑**：`AudioContext` 在无用户手势时是 `suspended`，必须先 `resume()`；这条 track 在没声音时是"静音轨"，会占一点带宽但能保持 SDP 稳定（我们故意保留）。
- **我们怎么用**：`static/call.js` 里 `setupAudioContext()` 建 `dest`，`createPc()` 时把 `voiceStream` 的 track `addTrack` 进去；`/api/tone` 的 WAV 解码后 `connect(dest)` 就能让对端听到。

---

## 参考 6：本机 `plugins/dsh-shiori-shore/lib/hostdeps.mjs`（我们自己踩过的坑，源码级）

- **出处**：`plugins\dsh-shiori-shore\lib\hostdeps.mjs`
- **解决什么**：为什么"从宿主树取 schemastery"是必须的。
- **原文记录（2026-10-16 复现）**：`@deepseek-ai/schemastery`、`@deepseek-ai/dsh-tools` 在 `package.json` 里是 **optional peer**，桌面版 profile（`autoInstallPeers: false`）永远不装 ⇒ 裸 import 失败 ⇒ 整条 entry 不激活，只剩 `warning: 1 entry did not activate … failed to import`。
- **坑的延伸**：schemastery 3.19.0 的 `.extra('volatile', true)` 有回归，求值返回 `{}`，会把 `cfg.pythonPath` 变成 `"[object Object]"`；以及 schema 里写 `.max()` 校验不过会让整条 entry 不激活。
- **我们怎么用**：`dsh-videocall` 的 Config 只用 `boolean/string/natural/array` + `default`，**不用 `.extra()`、不写 `.max()`**；schema 拿不到就 `Config = undefined`。

---

## 参考 7：`@deepseek-ai/dsh-api-gateway` README（本机 app.asar，版本已核实）

- **出处**：`dsh/node_modules/@deepseek-ai/dsh-api-gateway/package.json` → `"version": "0.2.2-rc.3"`，`description: "Typert Remote Host dispatcher and Client API endpoint"`；README 26093 字节
- **解决什么**：DSH 自己的 Web 前端是怎么和 Host 通信的，我们该不该借用。
- **关键事实（README 原文）**：
  - Gateway 注册的是 **WebSocket upgrade 路由**，且"**只有在应用启动成功后**"才注册（`ctx.appReady`）；
  - 每个 unary 调用走 `ctx.connection.rpc.call('/api', ...)`，流式走 `@Remote({mode:'stream'})`；
  - `ctx.remote.$host` 给出 `isLoopback` 这类 Host 事实；
  - WS 有心跳（`websocketHeartbeatIntervalMs`，两个周期无活动即断开）和 `permessage-deflate` 压缩。
- **坑**：这是 Host↔官方 Client 的**私有协议**（Typert descriptor、`$events` 端点、权限模型都在里面）。第三方插件往里插路由 = 踩主端口 + 踩私有协议，两头都不稳。
- **我们怎么用**：**不碰**。插件自起 HTTP（`server/index.js`），端口独立、协议自定义（HTTP + SSE）。这条与任务书决策①一致，也是唯一干净的做法。

---

## 参考 8：本机"眼睛"插件里的附件落点（源码级）

- **出处**：
  - `plugins/dsh-whale-gaze/index.js:218` 与 `plugins/dsh-whale-sight/index.js:846`
  - `plugins/dsh-whale-gaze/lib/tools.js:97-117`（工具输出里塞 `image` block）
- **解决什么**：抽帧之后，怎么让助手"真的看见"。
- **关键实现（原文）**：
  ```js
  const attachments = ctx.get('attachments')
  const ref = await attachments.saveImage({ data, mediaType: 'image/jpeg', name })
  // → { attachmentId, mediaType, bytes, width, height }
  ```
  工具返回值里放 `frame`，render 时输出 `blocks.push({ type: 'image', attachment: value.frame })`。
- **坑**：`attachments` 服务可能没挂（`ctx.get('attachments')` 为 undefined），必须显式报错，不能静默。
- **我们怎么用**：`videocall_look` 工具原样复用这条路径（同签名、同输出形状）。

---

## 参考 9：本机"唤醒"现成路径（源码级）

- **出处**：`plugins/dsh-shiori-shore/index.js:191-256`（`startWaker`）
- **解决什么**：P3 里"有人打进电话 → 把会话叫醒"该怎么做。
- **关键实现（原文）**：
  ```js
  const sc = ctx.get('sessionController')
  await sc.state({ sessionId }, signal)         // running 就跳过，别打断
  await sc.prompt({ requestId, sessionId, mode: 'queue', content: [{ type: 'text', text }] }, signal)
  ```
- **坑**：目标会话在跑时必须跳过（事件留队列），否则"标记已读却没送到"。
- **我们怎么用**：P3 再挂；P1 不碰会话，避免把现有链路拖下水。

---

## 环境事实（本机实测，2026-11-20）

| 项 | 结果 | 命令依据 |
|---|---|---|
| OBS 安装 | **没有**（默认路径无 `obs64.exe`，卸载表无 OBS 记录，注册表无 `OBS Virtual Camera` 过滤器） | `Test-Path` / 卸载表 / `HKLM:\SOFTWARE\Classes\CLSID` |
| 浏览器 | Edge `157.0.4341.60`；默认路径未找到 Chrome | `VersionInfo.ProductVersion` |
| Node | `v22.23.2` | `node --version` |
| DSH 桌面版 | `0.2.2.0`；`app.asar` 199.3 MB | exe 版本 / 文件大小 |
| VTS | 曾鉴权成功（`vts_token.json` 存在） | 文件存在 |

> 结论：**P0 现在过不了**，卡在"没有 OBS"这一步，不是代码问题。见 `P0-PROBE.md`。

---

## 参考总表（验收用：≥5 且各有出处）

| # | 参考 | 出处类型 | 版本/大小 |
|---|---|---|---|
| 1 | VTube Studio Public API | 官方 GitHub 页面 | 页面实测 |
| 2 | vts_client.py / vts_speak.py | 本机源码 | 190 / 152 行 |
| 3 | host-plugin.md | 本机 asar 解包 | 6489 B |
| 4 | plugin-development.md | 本机 asar 解包 | 5461 B |
| 5 | MDN MediaStreamAudioDestinationNode | MDN 页面 | 页面实测 |
| 6 | hostdeps.mjs（踩坑记录） | 本机源码 | 7239 B |
| 7 | @deepseek-ai/dsh-api-gateway | 本机 asar | 0.2.2-rc.3 |
| 8 | whale-gaze / whale-sight 附件 | 本机源码 | index.js 20KB / 45KB |
| 9 | shiori-shore 唤醒 | 本机源码 | 17794 B |
