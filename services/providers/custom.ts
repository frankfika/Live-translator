import { Provider, ProviderConfig, AsrRequest, TranslateRequest } from './types';
import {
  stripTrailingSlash,
  asHttpError,
  streamChatCompletion,
  apiKeyLooksValid,
} from './siliconflow';

/**
 * 自定义 OpenAI 兼容 Provider — 给高级用户
 * 适用场景：
 *   - 私有部署的 LLM (vLLM / Ollama / LocalAI / LM Studio)
 *   - 小众云厂商（Moonshot、Stepfun、DeepSeek 纯 LLM 等）
 *   - 内部网关反代
 *
 * 用户必须填: baseUrl / llmModel / apiKey；asrModel 可空（纯翻译场景不需要）
 * ASR 默认按 SiliconFlow 兼容协议（multipart form，POST {baseUrl}/audio/transcriptions）
 * LLM 默认按 OpenAI 兼容协议（POST {baseUrl}/chat/completions，stream=true）
 *
 * 如果用户的 ASR endpoint 不是这个形状，留空 asrModel，调用 transcribe 时会拿到
 * 一条带"只翻译已有文字"路径提示的错误。
 */
export class CustomProvider implements Provider {
  readonly id = 'custom';
  readonly displayName = '自定义 (OpenAI 兼容)';
  readonly description = '自填 baseUrl + 模型名，兼容任何 OpenAI 协议服务';
  readonly defaultBaseUrl = 'https://api.openai.com/v1';
  readonly defaultAsrModel = '';
  readonly defaultLlmModel = 'gpt-4o-mini';
  readonly keyUrl = '';
  readonly customHint =
    'ASR 端点 (可选): POST {baseUrl}/audio/transcriptions (multipart) · LLM 端点: POST {baseUrl}/chat/completions (OpenAI 兼容流式)';

  validateConfig(cfg: ProviderConfig): string | null {
    const keyErr = apiKeyLooksValid(cfg.apiKey);
    if (keyErr) return keyErr;
    if (!cfg.baseUrl.trim() || !/^https?:\/\//.test(cfg.baseUrl)) {
      return 'baseUrl 必须以 http(s):// 开头';
    }
    if (!cfg.llmModel.trim()) return '缺少翻译模型名';
    // asrModel 可空：用户可能只想用 LLM 做翻译（输入是已有字幕而非麦克风流）。
    // 真正调用 transcribe() 时才报错，而不是在 validateConfig 阶段堵死。
    return null;
  }

  async transcribe({ audio, cfg, signal }: AsrRequest): Promise<string> {
    if (!cfg.asrModel.trim()) {
      throw new Error(
        'Custom provider 未配置 ASR 模型名 — 请在设置里填写（如 whisper-1）。如果只想做翻译，' +
          '可以保留 ASR 模型名为空，仅在"只翻译已有文字"路径下使用此 provider。',
      );
    }
    const url = `${stripTrailingSlash(cfg.baseUrl)}/audio/transcriptions`;
    const formData = new FormData();
    formData.append('file', audio, 'audio.wav');
    formData.append('model', cfg.asrModel);

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${cfg.apiKey}` },
      body: formData,
      signal,
    });

    if (!response.ok) {
      throw await asHttpError(response, 'ASR');
    }
    const result = await response.json();
    return (result.text || '').trim();
  }

  async translate({ text, systemInstruction, onChunk, cfg, history, signal }: TranslateRequest): Promise<void> {
    if (!cfg.llmModel.trim()) {
      throw new Error('当前 Provider 未配置翻译模型名。请在设置里填写。');
    }
    const url = `${stripTrailingSlash(cfg.baseUrl)}/chat/completions`;
    await streamChatCompletion({
      url,
      apiKey: cfg.apiKey,
      model: cfg.llmModel,
      systemInstruction,
      userText: text,
      onChunk,
      history,
      signal,
    });
  }
}
