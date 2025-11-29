# Live Translator - 实时同声传译

实时语音翻译应用，支持多语言同声传译，边说边翻译并显示字幕。

## 功能特性

- 实时语音识别与翻译
- 支持 14 种语言互译（中/英/日/韩/法/德/西/俄等）
- 流式字幕显示
- 音频可视化波形
- 深色主题 UI

## 技术栈

- React 18 + TypeScript
- Vite
- Tailwind CSS v4
- Gemini Live API (WebSocket 流式)

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 配置环境变量

创建 `.env` 文件：

```env
GEMINI_API_KEY=your_gemini_api_key
```

获取 API Key: [Google AI Studio](https://aistudio.google.com/apikey)

### 3. 启动开发服务器

```bash
npm run dev
```

访问 http://localhost:3000

## 使用说明

1. 点击 **Start** 开始录音
2. 对着麦克风说话，系统会自动识别并翻译
3. 点击齿轮图标可切换翻译语言对
4. 点击 **Stop** 停止录音

## 项目结构

```
├── src/
│   ├── App.tsx          # 主应用组件
│   └── main.tsx         # 入口文件
├── components/
│   ├── AudioVisualizer.tsx   # 音频波形可视化
│   ├── LanguageSettings.tsx  # 语言设置弹窗
│   └── SubtitleCard.tsx      # 字幕卡片
├── services/
│   └── liveClient.ts    # Gemini Live API 客户端
├── types.ts             # 类型定义
└── index.html
```

## License

MIT
