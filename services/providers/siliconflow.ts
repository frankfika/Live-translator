import { Provider, ProviderConfig, AsrRequest, TranslateRequest, ChatTurn, TtsRequest, TtsVoice } from './types';

const API_BASE = 'https://api.siliconflow.cn/v1';

/**
 * 占位 API Key 集合：UI / .env.example 里出现的"假"key 模式。
 * 这些值一旦写进 localStorage / Tauri store 就会被当作"已配置"放行，
 * 然后 fetch 401 → 报错信息让人摸不着头脑（"我明明填了 key 啊"）。
 * 在 provider 层再做一道防御，避免静默放过。
 */
const PLACEHOLDER_API_KEYS = new Set([
  'your_siliconflow_api_key_here',
  'your_api_key_here',
  'test_key_placeholder',
  'sk-xxxxx',
  'sk-xxxxxxxx',
  'sk-xxxxxxxxxx',
  'sk-your-key',
  'sk-your-key-here',
  'placeholder',
  'changeme',
]);

/**
 * SiliconFlow（硅基流动）— 国产，主打一站式托管多种开源模型
 * ASR: FunAudioLLM/SenseVoiceSmall（多语种，体积小，速度快）
 * LLM: Qwen3-32B（默认）/ Qwen2.5-7B-Instruct / DeepSeek-V3 等
 * 文档: https://docs.siliconflow.cn/cn/api-reference/audio/create-transcription
 */
export class SiliconFlowProvider implements Provider {
  readonly id = 'siliconflow';
  readonly displayName = 'SiliconFlow（硅基流动）';
  readonly description = '国产，一站式托管多款开源模型，免费额度大';
  readonly defaultBaseUrl = API_BASE;
  readonly defaultAsrModel = 'FunAudioLLM/SenseVoiceSmall';
  readonly defaultLlmModel = 'Qwen/Qwen3-32B';
  readonly keyUrl = 'https://cloud.siliconflow.cn/account/ak';
  /** CosyVoice2 预置音色（男：alex/benjamin/charles/david，女：anna/bella/claire/diana），中英日韩都能说 */
  readonly voices: TtsVoice[] = [
    { id: 'alex', label: '男声 · 沉稳（alex）' },
    { id: 'benjamin', label: '男声 · 低沉（benjamin）' },
    { id: 'charles', label: '男声 · 磁性（charles）' },
    { id: 'david', label: '男声 · 欢快（david）' },
    { id: 'anna', label: '女声 · 沉稳（anna）' },
    { id: 'bella', label: '女声 · 激情（bella）' },
    { id: 'claire', label: '女声 · 温柔（claire）' },
    { id: 'diana', label: '女声 · 欢快（diana）' },
  ];

  validateConfig(cfg: ProviderConfig): string | null {
    const keyErr = apiKeyLooksValid(cfg.apiKey);
    if (keyErr) return keyErr;
    if (!cfg.asrModel.trim()) return '缺少 ASR 模型名';
    if (!cfg.llmModel.trim()) return '缺少翻译模型名';
    return null;
  }

  async transcribe({ audio, cfg, signal }: AsrRequest): Promise<string> {
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
      throw await asHttpError(response, 'SiliconFlow ASR');
    }
    const result = await response.json();
    return (result.text || '').trim();
  }

  async translate({ text, systemInstruction, onChunk, cfg, history, signal }: TranslateRequest): Promise<void> {
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
      extraBody: thinkingOffBody(cfg.llmModel),
    });
  }

  async synthesize({ text, voice, cfg, signal }: TtsRequest): Promise<ArrayBuffer> {
    const model = SILICONFLOW_TTS_MODEL;
    return openAiSpeech({
      url: `${stripTrailingSlash(cfg.baseUrl)}/audio/speech`,
      apiKey: cfg.apiKey,
      body: {
        model,
        input: text,
        // 系统预置音色要带模型前缀
        voice: voice.includes(':') ? voice : `${model}:${voice || 'alex'}`,
        response_format: 'wav',
        sample_rate: 24000,
        stream: false,
      },
      signal,
    });
  }
}

export const SILICONFLOW_TTS_MODEL = 'FunAudioLLM/CosyVoice2-0.5B';

/** OpenAI 兼容的 /audio/speech，返回音频字节 */
export async function openAiSpeech(opts: {
  url: string;
  apiKey: string;
  body: Record<string, unknown>;
  signal?: AbortSignal;
}): Promise<ArrayBuffer> {
  const response = await fetch(opts.url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${opts.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(opts.body),
    signal: opts.signal,
  });
  if (!response.ok) throw await asHttpError(response, '语音合成');
  return response.arrayBuffer();
}

// ── 共享工具 ─────────────────────────────────────────────────────────

/**
 * 占位 API Key 防御性校验。返回 null 表示通过，返回字符串表示具体原因。
 * 触发任一即拒绝：
 *   - 空 / 纯空格
 *   - 命中 PLACEHOLDER_API_KEYS 集合（来自 UI 默认值 / .env.example / 文档）
 *   - 形如 sk-xxxx / sk-xxx... 的纯占位 pattern
 *   - 长度 < 16（SiliconFlow 真实 key 是 sk- 前缀 + 49 字符，其他 OpenAI 兼容 key
 *     也很少有 < 16 的，所以这是一个足够宽松的下界）
 */
export function apiKeyLooksValid(key: string): string | null {
  const trimmed = key.trim();
  if (!trimmed) return '缺少 API Key';
  if (PLACEHOLDER_API_KEYS.has(trimmed.toLowerCase())) {
    return 'API Key 仍是占位符，请在设置里填写真实 Key';
  }
  if (/^sk-?x+$/i.test(trimmed)) {
    return 'API Key 是 sk-xxxx 占位符';
  }
  if (trimmed.length < 16) {
    return 'API Key 长度过短（< 16 字符），看起来不是真实 Key';
  }
  return null;
}

/**
 * Qwen3 系列默认开启"思考模式"，同传场景下会多出几秒延迟且可能把思考过程吐进译文。
 * SiliconFlow / DashScope 都支持 enable_thinking: false 关闭。其他模型不传，避免 400。
 */
export function thinkingOffBody(model: string): Record<string, unknown> | undefined {
  return /qwen3/i.test(model) ? { enable_thinking: false } : undefined;
}

export function stripTrailingSlash(s: string): string {
  return s.replace(/\/+$/, '');
}

export async function asHttpError(response: Response, label: string): Promise<Error> {
  const body = await response.text().catch(() => '');
  const snippet = body.length > 300 ? body.slice(0, 300) + '…' : body;
  return new Error(`${label} 失败 (HTTP ${response.status}): ${snippet}`);
}

/**
 * OpenAI 兼容 Chat Completions 流式调用。
 * 适用于: DashScope (compatible-mode) / 智谱 (GLM) / DeepSeek / Moonshot /
 *         任何走 /v1/chat/completions 的服务。
 */
export async function streamChatCompletion(opts: {
  url: string;
  apiKey: string;
  model: string;
  systemInstruction: string;
  userText: string;
  onChunk: (chunk: string) => void;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  history?: ChatTurn[];
  /** 额外请求字段（如 Qwen3 的 enable_thinking: false） */
  extraBody?: Record<string, unknown>;
}): Promise<void> {
  const response = await fetch(opts.url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${opts.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: opts.model,
      messages: [
        { role: 'system', content: opts.systemInstruction },
        ...(opts.history ?? []),
        { role: 'user', content: opts.userText },
      ],
      temperature: opts.temperature ?? 0.1,
      max_tokens: opts.maxTokens ?? 800,
      stream: true,
      ...(opts.extraBody ?? {}),
    }),
    signal: opts.signal,
  });

  if (!response.ok) {
    throw await asHttpError(response, 'LLM');
  }
  if (!response.body) {
    throw new Error('LLM 响应体为空');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const data = trimmed.slice(5).trim();
      if (!data || data === '[DONE]') continue;

      let parsed: any;
      try {
        parsed = JSON.parse(data);
      } catch (e) {
        // SSE 偶发半行/心跳/garbage 行不算致命 — 至少 console.warn 让 debug 时能看见
        console.warn(
          `[streamChatCompletion] SSE chunk JSON parse error: ${(e as Error).message}; raw=${data.slice(0, 120)}`,
        );
        continue;
      }

      // 错误 chunk：OpenAI 风格 `{"error":{"message":"..."}}` 或 Anthropic 风格
      // `{"type":"error","error":{"type":"...","message":"..."}}`，任一出现立刻 throw
      // 让上层（App 的流式管线）拿到并 fallback，而不是继续 ignore 静默吞掉。
      if (parsed && parsed.error) {
        const errObj = parsed.error;
        const errMsg =
          typeof errObj === 'string'
            ? errObj
            : errObj?.message || JSON.stringify(errObj).slice(0, 200);
        throw new Error(`LLM 错误: ${errMsg}`);
      }

      const content = parsed.choices?.[0]?.delta?.content;
      if (content) opts.onChunk(content);
    }
  }
}
