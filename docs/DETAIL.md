# dsh-videocall · 说明

## 它是什么

一条**局域网内的视频通话通道**，挂在 DSH 上。

- 助手出镜的是**皮套**：VTube Studio → OBS → OBS 虚拟摄像头 → 浏览器 `getUserMedia`
- 助手的声音走 **Web Audio 造 track**，不需要虚拟声卡、不需要装驱动
- 助手看你：页面按档位抽帧回传（低画质看轮廓 / 按需高清）
- 插件自己起一个服务（默认绑 `0.0.0.0:8790`，HTTPS），**不碰 DSH 主端口**
- 控制面板内嵌在 DSH 左侧栏，数据走 DSH 自己的 webServer（同源）

## 为什么不用 QQ 做视频电话

QQ 官方 Bot API 没有实时音视频（RTC）。这不是工程量问题，是没有这个接口。

## 工作链路

```
手机/另一台浏览器 ──HTTPS──> 插件自带服务(0.0.0.0:8790)
        │                          │
        ├─◀ video: 皮套（OBS 虚拟摄像头）
        ├─◀ audio: 助手声音（Web Audio track）
        ├─▶ video: 你的摄像头
        └─▶ audio: 你的麦克风
                                   │
                    抽帧 POST ─────┘──> 附件 ──> 模型 read_image
```

## 数据文件

全部在 `~/.dsh/dsh-videocall/`：

| 文件 | 内容 | 删除后果 |
|---|---|---|
| `room.json` | 常驻房 id + 令牌 | 下次启动新建一间，旧链接失效 |
| `networks.json` | 网络档案（名字 + IP） | 重新从当前 IP 初始化 |
| `panel.json` | 面板保存的路径/外部地址 | 回落到 `cordis.patch.yml` 里的配置 |

证书在插件目录 `certs/dev.pfx`，删了会在下次启动自动重建。

## 配置项

在 profile 的 `cordis.patch.yml`，`dsh-videocall` 那一行的 `config:` 下。部分项也能在面板里改。

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 关掉就完全不加载 |
| `host` | `127.0.0.1` | 非局域网模式时的绑定地址 |
| `port` | `8790` | 被占自动往后挪（最多 6 次） |
| `publicBaseUrl` | `''` | 外部地址；走 frp 等自建隧道时填这里 |
| `tokenTtlSec` | `604800` | 令牌有效期（7 天） |
| `oneShotToken` | `false` | 令牌首个使用者定来源 IP |
| `allowedOrigins` | `[]` | 额外允许的 Origin |
| `rateLimitPerMin` | `30` | 每 IP 每分钟 join 上限 |
| `avatarMatch` | `obs` | 皮套摄像头匹配关键字 |
| `avatarWidth/Height/Fps` | `1280/720/30` | 皮套那一路请求的分辨率 |
| `avatarMirror` | `false` | 本地预览是否镜像 |
| `lowWidth/lowFps/jpegQuality` | `160/1/55` | 低档抽帧 |
| `highWidth` | `1280` | 「拉一帧高清」的宽度 |
| `iceServers` | STUN | ICE 服务器列表 |
| `turnUrl/User/Credential` | `''` | 可选 TURN（对称 NAT 用） |
| `lanMode` | `false` | **开：监听 0.0.0.0 + HTTPS**（手机同网直连必须） |
| `tlsPfx` | `''` | 证书路径，空 = `certs/dev.pfx` |
| `tlsPass` | `dsh-videocall` | 证书口令 |
| `tunnelBin` | `''` | cloudflared 路径，空 = `bin/cloudflared.exe` |
| `dataDir` | `''` | 数据目录，空 = `~/.dsh/dsh-videocall` |

## 面板 API（DSH 同源）

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/__videocall/panel` | 完整状态（服务/隧道/房间/帧/路径/网络） |
| POST | `{action:'activate'}` | 起隧道 |
| POST | `{action:'deactivate'}` | 切断隧道 |
| POST | `{action:'savePaths', paths}` | 保存路径 |
| POST | `{action:'addNetwork', name, ip}` | 加网络档案 |
| POST | `{action:'removeNetwork', ip}` | 删网络档案 |
| POST | `{action:'regenCert'}` | 用所有档案 IP 重新生成证书 |

独立面板页：`https://<本机IP>:8790/panel`（同样只允许本机访问）

## 工具

| 工具 | 干什么 |
|---|---|
| `videocall_room` | 返回常驻房链接（传 label 则开临时房） |
| `videocall_status` | 服务/房间/对端/帧状态 |
| `videocall_look` | 最新一帧存成附件交给模型 |
| `videocall_netcheck` | 本机 IP、监听、HTTPS、建议地址、隧道状态 |
| `videocall_tunnel` | 隧道阀门 start/stop/status |
| `videocall_ping` | 往通话页推提示字 |
| `videocall_stop` | 关服务 |

## 安全

默认就位：

- Host 校验（挡 DNS rebinding）、Origin 校验（挡 CSRF）
- 每 IP join 限流、128 位随机令牌 + 定长比较
- 请求体上限（JSON 1 MB / 帧 4 MB）
- 静态文件白名单 + 路径穿越拦截
- **管理端点只认本机**（回环 + 本机当前所有网卡地址，实时校验）
- 日志不打令牌

已知弱点：

- 令牌在 URL 里会进浏览器历史（常驻房 7 天）
- 自签证书需手机手动接受一次
- `turnCredential` 明文存在配置里

## 已知限制

- **Windows only**：OBS 虚拟摄像头是 DirectShow 组件
- 公网需要自备隧道（Cloudflare / frp / 花生壳），不是开箱即用
- 校园网若开客户端隔离，同网设备也互不相通
- 对称 NAT 下 P2P 会失败，需要 TURN

## 排障顺序

1. `videocall_status` 看服务在不在、端口多少
2. `videocall_netcheck` 看 IP、证书、建议地址
3. 本机 `curl -k https://<IP>:<port>/api/health` 应返回 200
4. 浏览器开 `/panel` 看状态
5. 手机打不开 → 防火墙（`tools/allow-firewall.bat`）+ 证书是否含该 IP
