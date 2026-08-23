import { Provider, ProviderConfig, AsrRequest, TranslateRequest } from './types';
import {
  stripTrailingSlash,
  asHttpError,
  streamChatCompletion,
  apiKeyLooksValid,
} from './siliconflow';

/**
 * 智谱 BigModel (GLM) — 清华系
 * ASR: glm-4-voice（实验性，支持中英）— 智谱当前没有稳态 ASR endpoint，
 *      所以 defaultAsrModel 留空强制用户在设置里填，避免误用 / 一键默认值踩雷。
 *      GLM-4-Voice 官方标注"实验性"，生产请先在智谱 playground 验证。
 * LLM: glm-4-plus / glm-4-air / glm-4-flash
 *
 * 设计取舍：
 * - LLM 用 OpenAI 兼容接口（/api/paas/v4/chat/completions）
 * - ASR 用 GLM-4-Voice 同步转写：multipart 上传 + 简单返回
 *   文档: https://docs.bigmodel.cn/api-reference/模型-api/语音识别
 *
 * 注：GLM-4-Voice 的响应是 { text: "..." } 简单 JSON，比 DashScope 简单。
 */
export class ZhipuProvider implements Provider {
  readonly id = 'zhipu';
  readonly displayName = '智谱 BigModel (GLM)';
  readonly description = '清华系国产，GLM-4-Plus 翻译质量高';
  readonly defaultBaseUrl = 'https://open.bigmodel.cn/api/paas/v4';
  readonly defaultAsrModel = '';
  readonly defaultLlmModel = 'glm-4-plus';
  readonly keyUrl = 'https://bigmodel.cn/usercenter/apikeys';

  validateConfig(cfg: ProviderConfig): string | null {
    const keyErr = apiKeyLooksValid(cfg.apiKey);
    if (keyErr) return keyErr;
    if (!cfg.asrModel.trim()) {
      return '请填写智谱 ASR 模型名，推荐 glm-4-voice（实验性）';
    }
    if (!cfg.llmModel.trim()) return '缺少翻译模型名（推荐 glm-4-plus）';
    return null;
  }

  async transcribe({ audio, cfg }: AsrRequest): Promise<string> {
    const url = `${stripTrailingSlash(cfg.baseUrl)}/audio/transcriptions`;
    const formData = new FormData();
    formData.append('file', audio, 'audio.wav');
    formData.append('model', cfg.asrModel);

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${cfg.apiKey}` },
      body: formData,
    });

    if (!response.ok) {
      throw await asHttpError(response, '智谱 ASR');
    }
    const result = await response.json();
    return (result.text || '').trim();
  }

  async translate({ text, systemInstruction, onChunk, cfg }: TranslateRequest): Promise<void> {
    const url = `${stripTrailingSlash(cfg.baseUrl)}/chat/completions`;
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
