# 发布指南（dsh-videocall）

给作者和发布执行者看的。

## 0. 发布前检查清单

- [ ] `npm run check` 全绿（index / client / server×3 / static 全部 `node --check`）
- [ ] **干净环境自愈测试通过**（见下节）
- [ ] `package.json` 没有 `"private": true`
- [ ] `version` 已递增，`CHANGELOG.md` 有对应条目
- [ ] `engines.node` 与实测一致（当前 `>=20.3.0`）
- [ ] `dsh.compatibility.dsh` 与实测 DSH 版本一致（当前实测 `0.2.2-rc.3`）
- [ ] `dsh.client.inject` 字段存在（缺了 Client 端不加载）
- [ ] `files` 里**没有** `bin/`、`certs/`、`p0/frames/`、日志
- [ ] `cordis.patch.yml` 里没有本机绝对路径
- [ ] `repository` / `homepage` / `bugs` 指向真实仓库
- [ ] `icon.svg` 存在且能渲染
- [ ] 隐私扫描：**没有**本机用户名、真实 IP、连接令牌、宿舍/学校名、私人路径写进任何文件

## 1. 干净环境自愈测试（必做）

模拟一个全新用户的第一次启动。

```powershell
# 1. 备份
$dir = "$env:USERPROFILE\.dsh\dsh-videocall"
$d = "<插件目录>"
Copy-Item "$dir\room.json"        "$env:TEMP\vc-room.json"    -Force
Copy-Item "$dir\networks.json"    "$env:TEMP\vc-net.json"     -Force
Copy-Item "$d\certs\dev.pfx"      "$env:TEMP\vc-cert.pfx"     -Force

# 2. 清空
Remove-Item "$dir\room.json","$dir\networks.json" -Force
Remove-Item "$d\certs\dev.pfx" -Force

# 3. 在 DSH 里禁再启用插件（等价于重启）
#    然后检查：

# 4. 期望结果
#    - certs/dev.pfx 自动生成
#    - room.json 自动新建（新房间）
#    - networks.json 自动初始化（当前 IP）
#    - 服务 tls: true
#    - videocall_room 返回可用的常驻房链接

# 5. 恢复
Copy-Item "$env:TEMP\vc-room.json" "$dir\room.json"    -Force
Copy-Item "$env:TEMP\vc-net.json"  "$dir\networks.json" -Force
Copy-Item "$env:TEMP\vc-cert.pfx"  "$d\certs\dev.pfx"   -Force
#    再重载一次插件
```

**2026-11-20 实测：全部通过。**

## 2. 不能打进包的东西

| 路径 | 原因 | 怎么给用户 |
|---|---|---|
| `bin/cloudflared.exe` | 53 MB 二进制 | 文档说明自己下 `cloudflared-windows-amd64.exe` 放到 `bin/`，或在面板填路径 |
| `certs/*.pfx` | 每台机器证书不同，含本机 IP | 首次启动自动生成 |
| `p0/frames/` | 测试产物 | 不入 `files` |
| `*.log` | 运行日志 | `.gitignore` 已排除 |

`package.json` 的 `files` 字段已经限定，**不要加 `bin/` 或 `certs/`**。

## 3. 建 GitHub 仓库

```bash
git init
git add .
git commit -m "dsh-videocall 0.2.0"
git remote add origin git@github.com:Lh1314-China/dsh-videocall.git
git push -u origin main
```

推完给仓库加 topic：`dsh-plugin`

## 4. 发布 npm

```bash
npm login --registry=https://registry.npmjs.org
npm whoami --registry=https://registry.npmjs.org
npm publish --registry=https://registry.npmjs.org
```

> 默认 registry 可能是镜像（只读），**必须显式加 `--registry`**。
> 2026-10 起新包首版走 staged publishing，发布后需 2FA 批准。

装一次验证：

```bash
dsh plugin --profile desktop add dsh-videocall
```

## 5. 收录社区市场

- https://dshplugin.online/
- 一般要求：仓库满 1 天、有 `dsh-plugin` topic、`docs/DETAIL.md` + `icon.svg`

## 6. 版本策略

| 版本 | 内容 |
|---|---|
| `0.2.x` | 修 bug、补文档 |
| `0.3.0` | 加 TURN、加 frp 自动配置向导 |
| `1.0.0` | 真机全场景跑通（局域网 + 公网 + 多网络切换）+ 排障文档完整 |

## 7. 发布后盯什么

| 反馈 | 先查 |
|---|---|
| 装不上 | `dsh.compatibility.dsh` 范围 |
| 侧栏没入口 | 是否重启过 DSH（Client 端要重启才挂） |
| 手机打不开 | 防火墙 8790、证书是否含当前 IP、是否同一网络 |
| 只有声音 | 手机端摄像头没开（iOS 手势限制 / 下拉停在「不送画面」） |
| 摄像头显示的是浏览器窗口 | OBS 场景抓错了窗口，要抓 VTS 不是 Edge |
