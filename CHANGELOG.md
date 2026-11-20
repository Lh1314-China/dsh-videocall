# Changelog

## 0.2.0 — 2026-11-20

这一版把「能不能天天用」的问题解决了。

### 新增

**常驻房**
- 房间信息存 `~/.dsh/dsh-videocall/room.json`，重启插件后复用同一个链接
- `videocall_room` 不传 label 时返回常驻房；传 label 才开临时房
- 令牌有效期从 1 小时改为 7 天

**网络档案**
- 记住去过的几个网络（名字 + IP），存 `networks.json`
- 面板显示"当前 IP / 匹配档案"，可增删
- 换网络时加一条 + 更新证书即可，下次回到这个网络不用再配

**内嵌控制面板**
- 左侧栏新增「视频通话」入口（`sidebar.panellist`）
- 整页面板挂在 `main` 槽，不再是弹新窗口
- 数据走 DSH 自己的 webServer（`/__videocall/panel`），同源、无跨域、无证书问题
- 面板内容：当前状态 / 常驻房链接（含复制）/ 网络档案 / 隧道阀门 / 路径设置

**隧道**
- `videocall_tunnel` 工具：`start` / `stop` / `status`
- 面板「激活 / 停用」按钮
- 启动时带 `--protocol http2 --edge-ip-version 4`（国内网络 QUIC 常被卡）
- 隧道起来后自动写入 Host 白名单，切断时收回

**多 IP 证书**
- `tools/make-cert.ps1` 支持 `-Ips "a,b,c"`，一张证书装多个网络
- 首次启动证书不存在时**自动生成**（含当前 IP + 档案里所有 IP）

**兼容其他隧道**
- `publicBaseUrl` 可在面板里改，无需碰配置文件
- 插件只认"对外地址"和"Host 白名单"，frp / 花生壳 / 任何 TCP 隧道都能接
- 启动时用 `publicBaseUrl` 覆盖配置

### 修复

- **抽帧抓错对象**：原来抓 `ui.local`（自己），改成 `ui.remote`（对端）
- **`offered` 永不复位**：对端重连后本端不再发 offer，两边干等——对端离开时拆连接并重置
- **`pc` 不重建**：对端换了但连接对象还是旧的——`peer-joined` 时补建
- **房间被离线 peer 占死**：`join` 前先剔除已断开的占位
- **iOS 枚举不到摄像头**：只授麦克风时 `enumerateDevices()` 不列 videoinput，改为先请求一次摄像头权限
- **匹配不到摄像头就静默不送画面**：改为回退到第一个可用摄像头
- **`lanIp` 吃启动快照**：换网络后链接和连接地址不更新，改为实时 `currentLanIp()`
- **管理端点拒绝换网后的新地址**：`isLoopback` 改为实时查网卡
- **面板无法滚动**：main 容器限高且不滚，`page` 层补 `height: 100%` + `overflowY: auto`
- **`dsh.client` 缺 `inject` 字段**：Client 端不加载

### 界面

- 本地画面小窗可折叠（✕ 收起，「我的画面」展开）
- 小窗尺寸从 160px 缩到 116px，`object-fit: cover` 避免竖屏撑成两半

### 文档

- README 重写：定位、三步上手、换网络、公网三条路、排障表
- 新增 `tools/allow-firewall.bat`：放行 8790 入站（解决"手机打不开"）
- 明确标注 Windows-only、公网非开箱即用、校园网客户端隔离无解

---

## 0.1.0 — 2026-11-20

首个版本。

**通道**
- 浏览器 ↔ 浏览器 WebRTC 通话，信令走 SSE + POST（零依赖，不用 WebSocket）
- 插件自起独立小服务，默认只绑 `127.0.0.1:8790`，不碰 DSH 主端口
- 端口被占自动往后挪，最多 6 次

**皮套**
- 助手出镜走 OBS 虚拟摄像头，浏览器 `enumerateDevices` 选设备
- 设备匹配关键字可配置（`avatarMatch`，默认 `obs`）

**声音**
- Web Audio `MediaStreamAudioDestinationNode` 造音频轨，**零驱动**
- 内置测试音（`/api/tone`）

**看**
- 低档持续抽帧（默认 160×120 / 1 fps / JPEG 55）
- 高档按需拉一帧（`highWidth`，默认 1280）

**安全**
- Host 校验（挡 DNS rebinding）、Origin 校验（挡 CSRF）
- 每 IP join 限流、128 位随机令牌、请求体上限、路径穿越拦截
