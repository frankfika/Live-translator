# AI 同声传译 · 实时字幕

一个基于 Tauri 2 + React 19 的桌面端实时语音翻译工具，支持多种国产 AI 模型。

## 📥 下载 v1.0.0

👉 [GitHub Releases](https://github.com/frankfika/Live-translator/releases/tag/v1.0.0)

| 平台 | 架构 | 文件 |
|---|---|---|
| **macOS** | Apple Silicon | `ai-interpreter-v1.0.0-macOS-aarch64.dmg` (5.4 MB) |
| Windows / Linux | x86_64 | CI 构建中，待 `gh auth refresh -s workflow` 后自动追加 |

## 🔧 v1.0.0 修复（针对"第三方会议无效"问题）

v1.0.0 完整修复了用户在 Zoom/腾讯会议/Teams 等第三方会议软件中使用时遇到的音频失效问题：

| 症状 | 根因 | 修复 |
|---|---|---|
| **macOS 麦克风收音失败** | 缺失 `NSMicrophoneUsageDescription`，WKWebView 静默拒绝 | 新增 `src-tauri/Info.plist` |
| **会议回声啸叫** | `echoCancellation/noiseSuppression/autoGainControl` 全部关闭 | 默认开启 + UI 提供开关 |
| **macOS "系统音频"无效** | WKWebView 不支持 `getDisplayMedia` | macOS 引导用 BlackHole 虚拟声卡；Windows 保留 getDisplayMedia |
| **只有内建麦的 Mac 设备列表空** | `default`/`communications` 设备被过滤 | 保留并显示为"系统默认输入设备" |
| **自定义 OpenAI baseUrl 被拦截** | CSP `connect-src` 固定白名单 | 改为 `https:` / `wss:` 通配 |

完整修复报告见 [AUDIO-FIX-REPORT.md](AUDIO-FIX-REPORT.md)，发布说明见 [RELEASE-NOTES-v1.0.0.md](RELEASE-NOTES-v1.0.0.md)。

## 特性

- 🎙 **多种音频输入** — 内建/外接麦克风、USB 麦、蓝牙耳机、虚拟声卡（BlackHole / VB-Cable）；系统音频（Windows: getDisplayMedia 抓会议声音；macOS: 需用 BlackHole 虚拟声卡）
- 🤖 **多 Provider 切换** — SiliconFlow（默认）、阿里云百炼 (DashScope)、智谱 BigModel (GLM)、自定义 OpenAI 兼容服务
- 🌐 **多语种双向翻译** — 中英日韩法德西俄阿等 14 种语言，自动识别方向
- ⚡ **流式输出** — VAD 检测说话停顿，逐字显示译文
- 🪟 **副屏悬浮字幕** — `Cmd/Ctrl+Shift+S` 唤出 always-on-top 字幕窗
- 📦 **三平台打包** — macOS .dmg / Windows .msi / Linux .deb & AppImage
- 🔌 **离线设置** — Key 存本地 SQLite（settings 表），不上传

## 快速开始

```bash
npm install
npm run dev          # 开发模式（首次编译 1-3 分钟）
npm run build        # 生产打包（产出 .dmg/.msi/.deb/.AppImage）
```

详细步骤看 [QUICK-START.md](QUICK-START.md)。

## Provider 配置

打开应用 → 设置 → 连接 → 选 Provider + 填 Key。

| Provider | 说明 |
| --- | --- |
| SiliconFlow | 默认，国产一站式，免费额度大 |
| 阿里云百炼 (DashScope) | Qwen 原厂，模型最新 |
| 智谱 BigModel (GLM) | 清华系，GLM-4-Plus 翻译质量高 |
| 自定义 (OpenAI 兼容) | 任何 OpenAI 协议服务 / 本地 LLM |

详细看 [API-CONFIG.md](API-CONFIG.md)。

## 系统要求

- Node.js 18+
- Rust 1.77+（Tauri 编译需要）
- macOS 10.15+ / Windows 10+ / Linux（带 webkit2gtk）

## 文档

- [QUICK-START.md](QUICK-START.md) — 3 步上手
- [API-CONFIG.md](API-CONFIG.md) — Provider 配置详解
- [AUDIO-FIX-REPORT.md](AUDIO-FIX-REPORT.md) — 音频问题修复记录
- [README-TAURI.md](README-TAURI.md) — Tauri 架构说明

## License

MIT
