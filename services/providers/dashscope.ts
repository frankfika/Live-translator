import { Provider, ProviderConfig, AsrRequest, TranslateRequest } from './types';
import {
  stripTrailingSlash,
  asHttpError,
  streamChatCompletion,
  apiKeyLooksValid,
} from './siliconflow';

/**
 * DashScope 的 OpenAI 兼容 LLM endpoint 不在 /api/v1 下，而在 /compatible-mode/v1。
 * 用户可能在设置里填了三种形态：
 *   1) 默认 `https://dashscope.aliyuncs.com/api/v1` → 切到 /compatible-mode/v1
 *   2) 已经手动填了 `https://dashscope.aliyuncs.com/compatible-mode/v1` → 保持不变
 *   3) 自定义代理/反代，比如 `https://my-proxy.com/dashscope/api/v1` → 把末段 /api/v1 换成 /compatible-mode/v1
 *   4) 裸 host `https://dashscope.aliyuncs.com`（没 /api/v1 也没 /compatible-mode/v1）→ 补 /compatible-mode/v1
 * 旧版的 `replace(/\/api\/v1$/, '/compatible-mode/v1')` 能 cover 1/3，漏 2/4。
 * 这里拆三个 case 显式处理。
 */
export function rewriteDashScopeBaseUrl(baseUrl: string): string {
  const stripped = stripTrailingSlash(baseUrl);
  // case 2: 已经是 compatible-mode，保持不变
  if (/\/compatible-mode\/v1$/.test(stripped)) {
    return stripped;
  }
  // case 1 + 3: 末段是 /api/v1（含 path 前缀的反代），换成 /compatible-mode/v1
  if (/\/api\/v1$/.test(stripped)) {
    return stripped.replace(/\/api\/v1$/, '/compatible-mode/v1');
  }
  // case 4: 都没接，补一段
  return `${stripped}/compatible-mode/v1`;
}

/**
 * 阿里云百炼 (DashScope) — Qwen 系列官方平台
 * ASR: paraformer-realtime-v2 (流式短音频) / paraformer-v2 (文件转写)
 * LLM: qwen-plus / qwen-max / qwen-turbo / qwen3-max 等
 *
 * 设计取舍：
 * - LLM 用 OpenAI 兼容接口（/compatible-mode/v1/chat/completions）
 *   → 跟 SiliconFlow / DeepSeek 等统一一套流式解析
 * - ASR 用官方 REST（paraformer-v2 同步文件转写），因为兼容模式
 *   没有 ASR endpoint，硬塞会让协议变怪
 *
 * 文档:
 * - LLM: https://help.aliyun.com/zh/model-studio/developer-reference/use-qwen-by-calling-api
 * - ASR: https://help.aliyun.com/zh/model-studio/developer-reference/paraformer-recorded-speech-recognition-api
 */
export class DashScopeProvider implements Provider {
  readonly id = 'dashscope';
  readonly displayName = '阿里云百炼 (DashScope)';
  readonly description = 'Qwen 原厂平台，国内最快，需要阿里云账号';
  readonly defaultBaseUrl = 'https://dashscope.aliyuncs.com/api/v1';
  readonly defaultAsrModel = 'paraformer-v2';
  readonly defaultLlmModel = 'qwen-plus';
  readonly keyUrl = 'https://bailian.console.aliyun.com/';

  validateConfig(cfg: ProviderConfig): string | null {
    const keyErr = apiKeyLooksValid(cfg.apiKey);
    if (keyErr) return keyErr;
    if (!cfg.asrModel.trim()) return '缺少 ASR 模型名（推荐 paraformer-v2）';
    if (!cfg.llmModel.trim()) return '缺少翻译模型名（推荐 qwen-plus）';
    return null;
  }

  async transcribe({ audio, cfg }: AsrRequest): Promise<string> {
    // DashScope paraformer-v2 是同步 file-upload 模式
    // 文档: POST /api/v1/services/audio/asr/transcription
    // 用 multipart/form-data，file 字段为二进制音频
    const url = `${stripTrailingSlash(cfg.baseUrl)}/services/audio/asr/transcription`;
    const formData = new FormData();
    formData.append('file', audio, 'audio.wav');
    formData.append('model', cfg.asrModel);
    // paraformer-v2 支持的音频格式: pcm/wav/mp3/opus/speex/aac/amr
    formData.append('format', 'wav');
    formData.append('sample_rate', '16000');

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${cfg.apiKey}` },
      body: formData,
    });

    if (!response.ok) {
      throw await asHttpError(response, 'DashScope ASR');
    }

    const result = await response.json();
    // 响应: { output: { text: "...", sentences: [...] } } 或 { output: { transcription_url: "..." } }
    // 同步模式下 output.text 直接是结果；异步模式需要再轮询 transcription_url
    const text = result?.output?.text;
    if (typeof text === 'string') return text.trim();

    // 异步模式：轮询
    const transcriptionUrl = result?.output?.transcription_url;
    if (transcriptionUrl) {
      return await this.pollTranscription(transcriptionUrl, cfg.apiKey);
    }

    throw new Error('DashScope ASR 响应格式异常：既没有 output.text 也没有 transcription_url');
  }

  private async pollTranscription(url: string, apiKey: string): Promise<string> {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1500));
      const r = await fetch(url, { headers: { 'Authorization': `Bearer ${apiKey}` } });
      if (!r.ok) continue;
      const j = await r.json();
      const status = j?.output?.task_status;
      if (status === 'SUCCEEDED') {
        return (j?.output?.results?.[0]?.transcription_text || '').trim();
      }
      if (status === 'FAILED') {
        throw new Error(`DashScope 异步转写失败: ${j?.output?.message || '未知原因'}`);
      }
    }
    throw new Error('DashScope 异步转写超时（>60s）');
  }

  async translate({ text, systemInstruction, onChunk, cfg }: TranslateRequest): Promise<void> {
    // OpenAI 兼容模式：必须把 baseUrl 从 /api/v1 切到 /compatible-mode/v1
    // 详细 case 拆解见 rewriteDashScopeBaseUrl 上方注释
    const baseUrl = rewriteDashScopeBaseUrl(cfg.baseUrl);
    const url = `${baseUrl}/chat/completions`;
    await streamChatCompletion({
      url,
      apiKey: cfg.apiKey,
      model: cfg.llmModel,
      systemInstruction,
      userText: text,
      onChunk,
    });
  }
}
