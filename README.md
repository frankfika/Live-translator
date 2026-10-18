# AI 同声传译 · 实时字幕

一个基于 Tauri 2 + React 19 的桌面端实时语音翻译工具，支持多种国产 AI 模型。

## 📥 下载 v1.0.0

👉 [GitHub Releases](https://github.com/frankfika/Live-translator/releases/tag/v1.0.0)

| 平台 | 架构 | 文件 |
|---|---|---|
| **macOS** | Apple Silicon | `ai-interpreter-v1.0.0-macOS-aarch64.dmg` (5.4 MB) |
| Windows / Linux | x86_64 | CI 构建中，待 `gh auth refresh -s workflow` 后自动追加 |

## ✨ v1.1：悬浮字幕，用的时候几乎感觉不到它

**不再是一个要盯着看的页面。** 打开后只有屏幕底部一条半透明字幕条 + 菜单栏/托盘图标：

- 🪟 **悬浮字幕条** — 置顶、透明、可拖动、左右边缘可拉宽，高度随字幕自动伸缩
- 🌫 **没人说话时自动淡出** — 只留一个小圆点；有新字幕或鼠标移上去才出现
- 🖱 **锁定 / 鼠标穿透** — `⇧⌘L`（Windows: `Ctrl+Shift+L`）锁定后不挡会议软件按钮，再按一次解锁
- 🙈 **共享屏幕时对方看不到** — 字幕窗默认不出现在屏幕共享 / 录屏里（macOS、Windows 10 2004+）
- 🍎 macOS 不占 Dock，只在菜单栏；关窗口 = 隐藏到托盘

**会议 / 浏览器 / 视频的声音直接抓，不用装虚拟声卡：**

| 平台 | 「电脑声音」模式 |
|---|---|
| Windows | WASAPI 回环原生采集，腾讯会议 / Zoom / Teams / 飞书 / 浏览器都能直接翻 |
| macOS 14.6+ | Core Audio 系统录音原生采集（首次需允许「录屏与系统录音」权限） |
| 更早的 macOS | 自动识别 BlackHole 等虚拟声卡 |
| Linux | 通过 PulseAudio / PipeWire 直接录默认扬声器（parec / pw-record） |
| 浏览器版 | 共享会议标签页音频；字幕用画中画小窗悬浮在所有窗口之上 |

**噪音和准确度：**

- 自适应 VAD：自动跟踪环境底噪，空调 / 键盘 / 咳嗽不再触发；保留 300ms 预录不丢首字；换气停顿不再把一句话切碎
- 过滤 ASR 幻觉："谢谢观看""字幕由…提供"、纯语气词、SenseVoice 标签和表情符号不再上屏
- 翻译带最近 3 句上下文，提示模型结合上下文纠正同音错字；支持**术语表**固定人名 / 产品名译法
- Qwen3 自动关闭思考模式，延迟更低
- 段落排队处理不再丢句；单句网络失败不再中断整个会话
- 选中虚拟声卡 / 回环设备时自动关闭回声消除（否则会把对方的声音当回声消掉）

| 快捷键（全局） | 作用 |
|---|---|
| `⇧⌘R` / `Ctrl+Shift+R` | 开始 / 停止 |
| `⇧⌘S` / `Ctrl+Shift+S` | 显示 / 隐藏字幕条 |
| `⇧⌘L` / `Ctrl+Shift+L` | 锁定（鼠标穿透）/ 解锁 |

设置与完整记录：点字幕条上的齿轮，或托盘菜单「设置与记录…」。

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
