# AI 同声传译 · 实时字幕 (Tauri 桌面版)

基于 Tauri 2 的跨平台桌面应用，提供实时同声传译和双语字幕。

## 功能特性

### 核心
- 🎙 **多源音频** — 内建/外接麦、虚拟声卡（BlackHole / VB-Cable）、系统音频（Windows: getDisplayMedia；macOS: 需用 BlackHole 虚拟声卡）
- 🤖 **多 Provider** — SiliconFlow / 阿里云百炼 / 智谱 BigModel / 自定义 OpenAI 兼容
- 🌐 **14 种语言双向翻译** — 中英日韩法德西俄阿越土印等
- ⚡ **流式输出** — VAD 检测说话停顿，逐字显示
- 🪟 **悬浮字幕条** — 透明置顶、自动淡出、可锁定鼠标穿透，`Cmd/Ctrl+Shift+S` 显示/隐藏
- 📦 **三平台打包** — macOS .dmg / Windows .msi / Linux .deb & AppImage
- 💾 **本地数据库** — 会话记录自动存 SQLite

### 桌面专属
- 全局快捷键（`Cmd/Ctrl+Shift+S` / `Cmd/Ctrl+Shift+R`）
- 系统托盘（显示主窗口 / 显示/隐藏字幕 / 退出）
- 多窗口（主窗 + 副屏字幕窗）
- macOS 权限引导（系统设置 → 隐私与安全性 → 麦克风）
- 设备热插拔自动检测

## 技术栈

**前端：** React 19.2 + TypeScript 5.8 + Vite 6.2 + Tailwind

**后端：** Tauri 2.11 + Rust 2021 + SQLite (rusqlite，WAL 模式 + FK 开启)

**音频：** Web Audio API（ScriptProcessor + AudioContext + VAD）

**AI：** Provider 抽象（`services/providers/`），可插拔

> 历史：本应用早期版本用单一 Google Gemini Live API；2026-08 重构为可插拔多 provider 架构。所有 Gemini 路径已删除，详见 [API-README.md](API-README.md)。

## 项目结构

```
.
├── App.tsx                    # 主应用入口
├── components/
│   ├── LanguageSettings.tsx   # 设置弹窗（Provider/音频/语言 三 tab）
│   ├── AudioVisualizer.tsx    # 实时电平可视化
│   └── SubtitleCard.tsx       # 字幕卡片
├── services/
│   ├── providers/             # ★ 多 Provider 抽象
│   │   ├── types.ts
│   │   ├── siliconflow.ts     # 默认
│   │   ├── dashscope.ts       # 阿里云百炼
│   │   ├── zhipu.ts           # 智谱 GLM
│   │   ├── custom.ts          # OpenAI 兼容
│   │   └── registry.ts
│   ├── liveSession.ts         # 音频采集 + VAD + 切片
│   ├── mediaDevices.ts        # 设备枚举 + 错误解读
│   ├── audioUtils.ts          # 重采样 / WAV 编码 / RMS
│   └── tauri.ts               # Tauri API 封装
├── src-tauri/                 # Rust 后端
│   ├── src/
│   │   ├── lib.rs
│   │   ├── commands/          # settings / transcripts / window
│   │   ├── db/                # SQLite schema + connection
│   │   └── models/
│   ├── capabilities/default.json
│   ├── tauri.conf.json
│   └── Cargo.toml
├── package.json
├── vite.config.ts
└── tsconfig.json
```

## 数据存储

- **macOS**: `~/.ai-interpreter/data.db`
- **Windows**: `%USERPROFILE%\.ai-interpreter\data.db`
- **Linux**: `~/.ai-interpreter/data.db`

## 快捷键

| 键 | 动作 |
| --- | --- |
| `Cmd/Ctrl+Shift+S` | 显示/隐藏悬浮字幕（全局） |
| `Cmd/Ctrl+Shift+R` | 开始/停止翻译（全局） |
| `Cmd/Ctrl+Shift+L` | 锁定/解锁字幕条（鼠标穿透） |

## 已知限制

- **macOS 13 及更早**：系统没有进程回环 API，「电脑声音」需要 BlackHole 虚拟声卡（应用会自动识别）。macOS 14.6+ 和 Windows 原生支持。
- **共享屏幕隐藏**：依赖系统 API（macOS `NSWindowSharingNone`、Windows `WDA_EXCLUDEFROMCAPTURE`），Linux 不支持；部分会议软件的“共享窗口”模式本来就不会拍到字幕窗。

## 开发

```bash
npm install
npm run dev        # 启动 Tauri 桌面 app（首次编译 1-3 分钟）
npm run check      # tsc + cargo check
npm run test       # vitest
npm run build      # 打包 .dmg / .msi / .deb / .AppImage
```

## 故障排除

### 编译失败

```bash
# Rust 侧
cd src-tauri && cargo clean && cargo build

# Node 侧
rm -rf node_modules package-lock.json && npm install
```

### 数据库损坏

```bash
rm ~/.ai-interpreter/data.db
```

应用会在下次启动时自动重建 schema。

## 路线图

当前实现已经覆盖实时翻译 + 桌面集成的核心场景。后续可能加：

- 副屏自动检测（Cmd+Shift+S 唤出时按焦点窗口选 monitor）
- 实时双语字幕叠加（OBS 直播场景）
- 多会议并行
- 云同步会话记录
- 自动更新（tauri-plugin-updater）

## License

MIT
