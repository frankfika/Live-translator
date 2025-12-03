# LiveTranslator - 实时同声传译

基于 Google Gemini Live API 的实时语音翻译应用，支持多语言同声传译，边说边翻译并显示双语字幕。

## 功能特性

- 实时语音识别与翻译（流式处理，低延迟）
- 支持 15 种语言互译：中文、英语、日语、韩语、法语、德语、西班牙语、俄语、葡萄牙语、意大利语、印地语、阿拉伯语、土耳其语、越南语、瑞典语
- 双语字幕同步显示（原文 + 译文）
- 实时音频波形可视化
- 深色主题现代 UI
- 每日使用次数限制（100次/天）

## 技术栈

- React 18 + TypeScript
- Vite 6
- Tailwind CSS v4
- Google Gemini Live API（WebSocket 实时流式通信）

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 配置环境变量

创建 `.env` 文件：

```env
VITE_GEMINI_API_KEY=your_gemini_api_key
```

获取 API Key: [Google AI Studio](https://aistudio.google.com/apikey)

### 3. 启动开发服务器

```bash
npm run dev
```

访问 http://localhost:3000

## 使用说明

1. 点击 **Start** 按钮开始录音
2. 对着麦克风说话，系统会实时识别并翻译
3. 上方显示原文，下方显示译文
4. 点击齿轮图标切换翻译语言对
5. 点击刷新图标清空历史记录
6. 点击 **Stop** 停止录音

## 项目结构

```
├── src/
│   ├── App.tsx              # 主应用组件
│   └── main.tsx             # 入口文件
├── components/
│   ├── AudioVisualizer.tsx  # 音频波形可视化
│   ├── LanguageSettings.tsx # 语言设置弹窗
│   └── SubtitleCard.tsx     # 字幕卡片组件
├── services/
│   ├── liveClient.ts        # Gemini Live API 客户端
│   └── audioUtils.ts        # 音频处理工具
├── types.ts                 # TypeScript 类型定义
├── index.html               # HTML 模板
├── vite.config.ts           # Vite 配置
└── tailwind.config.js       # Tailwind 配置
```

## 部署到 Vercel

### 1. 准备工作

```bash
npm run build
```

### 2. 部署步骤

1. 登录 [Vercel](https://vercel.com)
2. 点击 **Add New → Project**
3. 导入 GitHub 仓库
4. 点击 **Deploy**

### 3. 环境变量

在 **Settings → Environment Variables** 添加：

| 变量名 | 值 |
|--------|-----|
| `VITE_GEMINI_API_KEY` | 你的 Gemini API Key |

添加后重新部署生效。

## 使用限制

- 每个用户每天限制 100 次使用
- 次日自动重置
- 基于 localStorage 实现

## License

MIT
