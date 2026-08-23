# 快速开始

3 步上手，2 分钟内跑起来。

## 1. 安装依赖

```bash
npm install
```

## 2. 启动应用

```bash
npm run dev
```

会同时启动 Vite + Tauri 桌面 app。第一次会编译 Rust 端，等 1-3 分钟。

## 3. 配置 Provider + 开始

应用打开后：

1. 点右上角齿轮（或按 `S`）打开设置
2. 在「连接」标签下拉选一个 Provider
3. 填入 API Key（点链接跳转申请）
4. 「音频」标签选好输入设备 → 点「测试输入」确认电平条会动
5. 「语言」标签选两种翻译语言
6. 回到主界面，按「开始」（或按空格）

对着麦克风说话，几秒内就会看到双语字幕滚动。

## 三种 Provider 选择

| 你的情况 | 推荐 |
| --- | --- |
| 第一次用，没账号 | **SiliconFlow**（一键拿 Key，免费额度大） |
| 已有阿里云账号 | **阿里云百炼 (DashScope)** |
| 已有智谱账号 | **智谱 BigModel (GLM)** |
| 想用本地的 LLM / DeepSeek / Moonshot | **自定义 (OpenAI 兼容)** |

## 设备小贴士

- **内建麦克风** — 默认就能用
- **外接 USB 麦 / 领夹麦** — 设置 → 音频 → 选具体设备
- **会议软件声音** — 装 BlackHole (macOS) / VB-Cable (Windows) 虚拟声卡，把会议软件输出设到虚拟声卡，然后在设置里选它作为输入设备
- **macOS 限制** — 浏览器 `getDisplayMedia({ audio: true })` 在 macOS WKWebView 下抓不到系统音频，必须用虚拟声卡
- **热插拔** — 拔/插设备后点「刷新列表」

## 快捷键

| 按键 | 动作 |
| --- | --- |
| 空格 | 开始 / 停止翻译 |
| `S` | 打开设置 |
| `E` | 导出当前会话字幕 |
| `Cmd/Ctrl + Shift + S` | 显示/隐藏副屏字幕窗（macOS/Windows 桌面） |

## 出错了？

看 `AUDIO-FIX-REPORT.md` 了解常见音频问题的处理；
看 `API-CONFIG.md` 了解 Provider 配置详情；
看 `API-README.md` 了解 4 套 Provider 的最小可工作示例。
