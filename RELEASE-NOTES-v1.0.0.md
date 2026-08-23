# AI 同声传译 · 实时字幕 v1.0.0

> Real-time AI-powered simultaneous interpretation with live subtitles.

## 🎉 首个正式版

基于 **Tauri 2 + React 19 + TypeScript + Rust** 的桌面应用，支持多种国产 AI 模型，提供麦克风、虚拟声卡、系统音频三种音频输入方式，专为会议/同传场景设计。

## 📥 下载

| 平台 | 文件 | 大小 |
|---|---|---|
| **macOS (Apple Silicon)** | `ai-interpreter-v1.0.0-macOS-aarch64.dmg` | 5.4 MB |
| **macOS (Apple Silicon)** | `ai-interpreter-v1.0.0-macOS-aarch64.app.zip` | 5.1 MB |

> Windows / Linux 二进制将在 `gh auth refresh -s workflow` 后由 GitHub Actions 自动构建后上传到本 Release。

## 🔧 核心修复（针对第三方会议场景失效）

### v1.0.0 解决的"在会议中无效"问题

| 症状 | 根因 | 修复 |
|---|---|---|
| **macOS 麦克风收音失败** | `src-tauri/Info.plist` 缺失 `NSMicrophoneUsageDescription`，macOS WKWebView 调 `getUserMedia` 静默拒绝 | 新增 `Info.plist`，含中英文麦克风权限描述 |
| **会议场景回声啸叫** | `buildMicrophoneConstraints` 把 `echoCancellation/noiseSuppression/autoGainControl` 全部关闭 | 改为默认开启，UI 新增"回声消除"开关 |
| **macOS "系统音频"模式无效** | macOS WKWebView **不支持** `getDisplayMedia`（Tauri/README 之前没说清） | macOS 直接引导用户安装 BlackHole 虚拟声卡并做正确路由；Windows 保留 `getDisplayMedia` + "勾选共享音频"提示 |
| **只有内建麦的 Mac 设备列表为空** | `normalizeAudioInputDevices` 把 `default`/`communications` 设备过滤掉 | 保留并显示为"系统默认输入设备" |
| **未授权时设备 label 全空** | `enumerateDevices` 未授权时不返回 label | 保留为"输入设备 N"占位，并自动标记 BlackHole/VB-Cable/Voicemeeter 等虚拟声卡 |
| **自定义 OpenAI 兼容 baseUrl 被拦截** | CSP `connect-src` 只放行固定域名 | 改为 `https:` / `wss:` 通配（桌面应用场景下安全可控） |

## ✨ 功能

- 🎙 **多种音频输入** — 内建/外接麦克风、USB 麦、蓝牙耳机、虚拟声卡（BlackHole / VB-Cable / Voicemeeter）；Windows 还支持 `getDisplayMedia` 抓系统音频
- 🤖 **多 Provider** — SiliconFlow（默认）、阿里云百炼 DashScope、智谱 BigModel、自定义 OpenAI 兼容
- 🌐 **14 种语言双向翻译** — 中英日韩法德西俄阿等，自动识别方向
- ⚡ **流式输出** — VAD 检测说话停顿，逐字显示译文
- 🪟 **副屏悬浮字幕** — `Cmd/Ctrl+Shift+S` 唤出 always-on-top 字幕窗
- 📦 **跨平台打包** — macOS / Windows / Linux（CI 自动构建）
- 🔌 **离线设置** — API Key 存本地 SQLite，不上传

## 📋 使用方法（会议场景）

### 场景 A：自己说，对方听（最简单）
1. 打开 App → 设置 → 音频 → 选"麦克风 / 虚拟声卡" + 你的麦克风
2. 设置 → 连接 → 填 API Key（SiliconFlow 默认）
3. 设置 → 语言 → 选翻译语言对（如 Chinese ⇄ English）
4. 点"开始翻译"，对着麦克风说话，字幕实时显示

### 场景 B：会议软件里翻译对方说话（推荐）
1. 在 Mac 上安装 [BlackHole](https://existential.audio/blackhole/)（App 内"音频"tab 有"打开下载页"按钮 + 安装引导）
2. 系统设置 → 声音 → 输出选 BlackHole
3. 会议软件（Zoom/腾讯会议/Teams/飞书）音频输出也设 BlackHole
4. App → 设置 → 音频 → 选"麦克风 / 虚拟声卡"，输入选 BlackHole
5. 开始翻译 → 字幕就是会议对方的实时翻译

### 场景 C：Windows 抓系统音频
1. 不装虚拟声卡，直接"系统音频"模式
2. 点"开始翻译"会弹共享窗口
3. **勾选"共享系统音频"**（关键），选择带音频的标签页

## ⚙️ 系统要求

- macOS 10.15+ (Apple Silicon / Intel 通用构建请提 Issue)
- Windows 10+（待 CI 构建）
- Linux（待 CI 构建）
- Node.js 18+（仅开发）
- Rust 1.77+（仅开发）

## 🐛 已知问题

- 本 Release 仅含 macOS Apple Silicon (aarch64) 构建。Intel Mac / Windows / Linux 需要等 GitHub Actions CI 构建（用户 `gh auth refresh -s workflow` 后自动跑）
- Tauri 2.9.4 在 macOS Apple Silicon 沙箱环境下 dmg bundler 的 AppleScript 美化步骤报 `-10004 privilege violation`（不影响 dmg 主文件生成，仅影响 Finder 窗口美化）。本 Release 的 dmg 是手动 `bundle_dmg.sh --skip-jenkins` 打包，校验通过；CI runner 上正常环境会走默认流程

## 📜 完整文档

- [README](README.md)
- [QUICK-START](QUICK-START.md)
- [API-CONFIG](API-CONFIG.md)
- [AUDIO-FIX-REPORT](AUDIO-FIX-REPORT.md)
- [README-TAURI](README-TAURI.md)

## License

MIT
