# API Provider 配置

应用通过 Provider 抽象支持 4 套后端（SiliconFlow / DashScope / Zhipu / 自定义 OpenAI 兼容），在「设置 → 连接」标签下拉切换。

> ⚠️ 历史：本应用早期版本使用过 Google Gemini（单一 provider），2026-08 改为可插拔多 provider 架构。所有 Gemini 路径已删除，**GEMINI_API_KEY 已被忽略**。

---

## 1. SiliconFlow（默认）

**适用**：第一次用 / 想开箱即用 / 想要免费额度。

- **baseUrl**：`https://api.siliconflow.cn/v1`
- **ASR 默认模型**：`FunAudioLLM/SenseVoiceSmall`
- **翻译默认模型**：`Qwen/Qwen3-32B`
- **Key 申请**：<https://cloud.siliconflow.cn/account/ak>
- **环境变量**：`SILICONFLOW_API_KEY=sk-...`

最小配置（.env）：
```env
SILICONFLOW_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxxxxx
```

---

## 2. 阿里云百炼 (DashScope)

**适用**：已经在用阿里云生态 / 想用 Qwen 最新模型。

- **ASR 端点**：`https://dashscope.aliyuncs.com/api/v1/services/audio/asr`
- **LLM 端点**：`https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions`（OpenAI 兼容）
- **ASR 默认模型**：`paraformer-v2`
- **翻译默认模型**：`qwen-plus`
- **Key 申请**：<https://bailian.console.aliyun.com/>
- **环境变量**：`DASHSCOPE_API_KEY=sk-...`

最小配置（.env）：
```env
DASHSCOPE_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxxxxx
```

---

## 3. 智谱 BigModel (GLM)

**适用**：GLM-4 系列翻译质量高 / 清华系偏好。

- **baseUrl**：`https://open.bigmodel.cn/api/paas/v4`
- **ASR 默认模型**：`glm-4-voice`
- **翻译默认模型**：`glm-4-plus`
- **Key 申请**：<https://bigmodel.cn/usercenter/apikeys>
- **环境变量**：`ZHIPU_API_KEY=...`

最小配置（.env）：
```env
ZHIPU_API_KEY=xxxxxxxx.xxxxxxxxxxxxxxxx
```

---

## 4. 自定义 (OpenAI 兼容)

**适用**：Moonshot / DeepSeek / Ollama / 任何 OpenAI 协议服务 / 公司内部 LLM 网关。

需要在 UI 里手填：

- **API 地址（baseUrl）** — 任何兼容 OpenAI Chat Completions 的服务
- **语音识别 (ASR) 模型名** — 走 `POST {baseUrl}/audio/transcriptions`（multipart form）
- **翻译 (LLM) 模型名** — 走 `POST {baseUrl}/chat/completions`（OpenAI 兼容流式）

常见 baseUrl：

| 服务 | baseUrl | LLM 模型示例 | ASR |
| --- | --- | --- | --- |
| Moonshot Kimi | `https://api.moonshot.cn/v1` | `moonshot-v1-8k` | — |
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat` | — |
| OpenAI 官方 | `https://api.openai.com/v1` | `gpt-4o-mini` | `whisper-1` |
| Ollama 本地 | `http://localhost:11434/v1` | 任意本地模型 | — |

环境变量（自定义 provider）：
```env
# 任意一个即可，应用按以下优先级读取
API_KEY=sk-...   # 自定义 provider 通用兜底
```

---

## 配置方式

### 方式 1: 在 App 里直接填（推荐）

打开应用 → 按 `S` 打开设置 → 「连接」标签 → 选 Provider → 填 API Key → 保存。

所有配置保存在本机 SQLite `settings` 表（Tauri 桌面模式 + 纯网页模式都走同一张表，不会上传到任何服务器）。

### 方式 2: 环境变量（CI / 自动化场景）

```bash
# 任意一个即可，应用按 provider 选对应 key
export SILICONFLOW_API_KEY="sk-..."
export DASHSCOPE_API_KEY="sk-..."
export ZHIPU_API_KEY="..."
export API_KEY="..."   # 兜底（自定义 provider）
```

`.env` 文件同样生效：
```env
SILICONFLOW_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxxxxx
DASHSCOPE_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxxxxx
```

---

## 常见问题

### Q: GEMINI_API_KEY 还有用吗？

**A**: 没有。Gemini provider 已在 2026-08 重构中删除。设了 `GEMINI_API_KEY` 也不会被读取。

### Q: 自定义 Provider 一直 401 / 403？

**A**: 自定义模式走 OpenAI 兼容协议。检查：
1. baseUrl 是否正确（结尾不要带 `/`）
2. API Key 是否有该模型的访问权限
3. 服务商是否真的暴露了 `/audio/transcriptions` 端点（很多纯 LLM 厂没 ASR，比如 Moonshot / DeepSeek / Ollama）

### Q: 切到 DashScope 报错"未检测到音频轨道"或"转录失败"？

**A**: DashScope ASR 需要 `wav` 格式（应用已自动处理），但请确认 Key 是 `sk-` 开头的阿里云百炼正式 Key，不是 `Bearer` 那种。

### Q: 为什么默认是 SiliconFlow？

**A**: 三个原因：
1. ASR + LLM 一站式，不用自己拼多套
2. 国内直连，速度稳定
3. 免费额度大（实测个人用几年没问题）

但如果你已经在用阿里云 / 智谱生态，**直接切过去就行**，模型质量和延迟通常更好。

---

**最后更新**: 2026-08-12
