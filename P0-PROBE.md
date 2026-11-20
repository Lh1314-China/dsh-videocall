# P0-PROBE · 先证明"浏览器能看见 OBS 虚拟摄像头"

> 任务书的顺序是"**先 P0 验证方案，再 P1 代码**；P0 不通，后面全省"。所以这份文件只干一件事：
> **把"VTS → OBS → 浏览器能选到它"这条链，用肉眼和一份 JSON 钉死。**

---

## 0. 本机现状（已实测，2026-11-20）

| 检查 | 结果 |
|---|---|
| `C:\Program Files\obs-studio\bin\64bit\obs64.exe` | 不存在 |
| 卸载表里 `DisplayName -match OBS` | 无记录 |
| `HKLM:\SOFTWARE\Classes\CLSID` 里名字含 `OBS Virtual Camera` 的过滤器 | 无 |
| 浏览器 | Edge `157.0.4341.60`（默认路径未见 Chrome） |
| Node | `v22.23.2` |

**结论：P0 现在必然不通过，卡点是"机器上没有 OBS"，不是代码。**
下一步是先装 OBS（用户自己决定装不装，我不代装第三方软件），装完再跑下面的探针。

---

## 1. 跑探针（3 条命令）

```powershell
cd <插件目录>
node p0\serve.mjs
```

另开一个窗口：

```powershell
start msedge http://127.0.0.1:8799/p0.html
```

页面里按顺序点：

1. **① 授权 + 枚举设备** —— 先 `getUserMedia({video:true})` 拿权限，再 `enumerateDevices()`。
   （不先授权，Chromium 给的 `label` 可能是空的，见 RESEARCH 参考 5 同类约束）
2. **② 打开 OBS 设备** —— 用 `deviceId:{exact}` 真打开，读 `track.getSettings()` 与 `readyState`。
3. **复制结果 JSON** —— 粘回来，这就是验收证据。

> 为什么必须是 `127.0.0.1`：`enumerateDevices` 要求 secure context，而 localhost/127.0.0.1 天然算安全上下文，**P0 完全不需要 HTTPS**。

---

## 2. 通过 / 不通过判据

| 编号 | 判据 | 通过 |
|---|---|---|
| P0-1 | 设备列表里出现 `kind === 'videoinput'` 且 `label` 含 `OBS` | ☐ |
| P0-2 | 用该 `deviceId` 能 `getUserMedia` 成功，`track.readyState === 'live'` | ☐ |
| P0-3 | `settings.width ≥ 640` 且 `settings.height ≥ 480` | ☐ |
| P0-4 | `settings.frameRate ≥ 15` | ☐ |
| P0-5 | 预览连续 60 秒不黑屏、不掉线 | ☐ |
| P0-6 | 关掉 OBS 的"启动虚拟摄像机"后，再点 ② 能明确报错（而不是静默失败） | ☐ |

**P0-1 ~ P0-3 全过**才算 P0 通过；P0-4/5 是"能用"的门槛；P0-6 是"出错要看得见"的门槛。

---

## 3. 不通过时的排查顺序（别跳步）

1. **页面地址是不是 `127.0.0.1` / `localhost`**：`file://` 打开会直接没有 `navigator.mediaDevices`。
2. **有没有先点 ① 授权**：没授权时标签可能为空，看起来像"没有 OBS"。
3. **OBS 里点没点「启动虚拟摄像机」**（OBS 主界面右下角 `Start Virtual Camera`）。
4. **OBS 是不是刚启动**：虚拟摄像头注册到 DirectShow 有延迟，等 10~20 秒，再点一次 ①。
5. **重启浏览器**：设备列表在页面生命周期内是缓存的，新设备常常要新开标签/重启才出现。
6. **用别的程序验证**：Windows「相机」App 能不能看到 OBS Virtual Camera。能看到 ⇒ 是浏览器侧问题；看不到 ⇒ 是 OBS/驱动侧问题。
7. **杀软/防火墙**：少数安全软件会拦 DirectShow 枚举。
8. **OBS 版本**：太老的版本虚拟摄像头模块名不同（`OBS Virtual Camera` vs `OBS-Camera`），换新版再试。

---

## 4. 记录模板（复制回填）

```json
{
  "when": "2026-11-20T…",
  "machine": "Windows / Edge 157.0.4341.60 / Node 22.23.2",
  "obs": { "installed": false, "version": null },
  "secureContext": true,
  "permission": "已授权（getUserMedia 成功）",
  "devices": [
    { "kind": "videoinput", "label": "OBS Virtual Camera", "deviceId": "…" }
  ],
  "chosen": { "label": "OBS Virtual Camera", "settings": { "width": 1280, "height": 720, "frameRate": 30 } },
  "verdict": "通过：打开成功 1280×720@30fps"
}
```

---

## 5. 装好 OBS 之后的最小配置（给 P1 用）

1. OBS 里加一个 **Spout2 源**（需装 `obs-spout2-plugin`，**版本未核实**），选 VTS 的输出；
   或者退一步：**窗口捕获** VTS 窗口。
2. 画面缩放到 1280×720（16:9），帧率 30。
3. 点 **启动虚拟摄像机**。
4. 回到 `p0.html` 重新点 ① → ②，把 JSON 贴回来。

---

## 6. 探针脚本本身（已交付，可直接跑）

- `p0/p0.html` —— 页面逻辑：授权 → 枚举 → 打开 → 打印 settings → 复制 JSON。
- `p0/serve.mjs` —— 20 行零依赖静态服务，只服务 `p0.html`，默认 `127.0.0.1:8799`。
