# API 配置

## 多 Provider 支持

应用现在支持 4 套服务，可在「设置 → 连接」下拉里切换：

| Provider | 推荐用途 | ASR 默认模型 | 翻译默认模型 | Key 申请 |
| --- | --- | --- | --- | --- |
| **SiliconFlow（硅基流动）** | 默认，国内一站式，开箱即用 | `FunAudioLLM/SenseVoiceSmall` | `Qwen/Qwen3-32B` | <https://cloud.siliconflow.cn/account/ak> |
| **阿里云百炼 (DashScope)** | Qwen 原厂，模型最新 | `paraformer-v2` | `qwen-plus` | <https://bailian.console.aliyun.com/> |
| **智谱 BigModel (GLM)** | 清华系，GLM-4-Plus 翻译质量高 | `glm-4-voice` | `glm-4-plus` | <https://bigmodel.cn/usercenter/apikeys> |
| **自定义 (OpenAI 兼容)** | Moonshot / DeepSeek / Ollama / 私有部署 | 自填 | 自填 | — |

每套服务都有免费的额度，**自用场景下任一 provider 都够用**。

## 配置方式

### 方式 1: 在 App 里直接填（推荐）

打开应用 → 按 `S` 打开设置 → 「连接」标签 → 选 Provider → 填 API Key → 保存。

所有配置保存在本机（SQLite `settings` 表，Tauri 桌面 + 纯网页模式共用同一张表），不会上传到任何服务器。

### 方式 2: 环境变量（CI / 自动化场景）

```bash
# 任意一个即可，应用按以下优先级读取
export SILICONFLOW_API_KEY="sk-..."
export DASHSCOPE_API_KEY="sk-..."
export ZHIPU_API_KEY="..."
export API_KEY="..."   # 兜底
```

.env 文件同样生效：

```env
# 默认 provider 是 SiliconFlow，按你选的 provider 填对应 key
SILICONFLOW_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxxxxx
# 如果切到 DashScope 也读 DASHSCOPE_API_KEY
DASHSCOPE_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxxxxx
```

## 切换 Provider

1. 打开设置 → 「连接」
2. 下拉选新 Provider
3. **baseUrl / ASR 模型 / 翻译模型会自动填默认值**（除非你已经手填过）
4. 填对应 API Key → 保存

如果当前在录音中，会自动断开旧会话并以新 Provider 重连，无需手动重启。

## 自定义 (Custom) Provider 高级用法

选「自定义 (OpenAI 兼容)」后，可以填：

- **API 地址（baseUrl）** — 任何兼容 OpenAI Chat Completions 的服务
- **语音识别 (ASR) 模型名** — 走 `POST {baseUrl}/audio/transcriptions`（multipart form）
- **翻译 (LLM) 模型名** — 走 `POST {baseUrl}/chat/completions`（OpenAI 兼容流式）

适用：

- **Moonshot Kimi**: baseUrl `https://api.moonshot.cn/v1`，LLM `moonshot-v1-8k`，ASR 留空（暂未实现）
- **DeepSeek**: baseUrl `https://api.deepseek.com/v1`，LLM `deepseek-chat`，ASR 留空
- **Ollama 本地**: baseUrl `http://localhost:11434/v1`，LLM 任意本地模型
- **公司内部 LLM 网关**

## 验证

1. 填完 Key → 点「保存」
2. 看到绿色提示「API Key 已配置，可以开始翻译」即可
3. 点「开始」（空格键），对着麦克风说话
4. 几秒内应该看到原文 + 译文滚动

## 常见问题

### Q: 切到 DashScope 报错"未检测到音频轨道"或"转录失败"？

A: DashScope ASR 需要 `wav` 格式（应用已自动处理），但请确认 Key 是 `sk-` 开头的阿里云百炼正式 Key，不是 `Bearer` 那种。

### Q: 自定义 Provider 一直 401 / 403？

A: 自定义模式走 OpenAI 兼容协议。检查：
1. baseUrl 是否正确（结尾不要带 `/`）
2. API Key 是否有该模型的访问权限
3. 服务商是否真的暴露了 `/audio/transcriptions` 端点（很多纯 LLM 厂没 ASR）

### Q: 为什么默认是 SiliconFlow？

A: 三个原因：
1. ASR + LLM 一站式，不用自己拼多套
2. 国内直连，速度稳定
3. 免费额度大（实测个人用几年没问题）

但如果你已经在用阿里云 / 智谱生态，**直接切过去就行**，模型质量和延迟通常更好。

## 安全

- ✅ API Key 仅发送到对应 Provider 的服务器
- ✅ `.env` 在 `.gitignore` 中，不会被提交
- ✅ Tauri 桌面版 Key 存 SQLite `settings` 表（本地数据库）
- ⚠️ 不要在公开场合分享 API Key
- ⚠️ 不要把 Key 硬编码到代码里

---

最后更新: 2026-08-12
