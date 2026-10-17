/**
 * Provider 抽象：每个 Provider 知道如何调一家 ASR + 一家 LLM。
 *
 * 设计原则：
 * - 单一入口 `transcribe()` / `translate()`，跟具体 API 形状解耦
 * - Preset（siliconflow / dashscope / zhipu）+ Custom（OpenAI 兼容）通吃
 * - 配置驱动，UI 只关心 ProviderConfig，不关心每个 provider 内部协议差异
 *
 * 故意把"ASR endpoint 形状"和"LLM endpoint 形状"做成 provider 自己实现，
 * 是因为 SiliconFlow ASR 是 multipart-form，DashScope ASR 是自家 REST，
 * 智谱 ASR 又不一样。统一成 OpenAI 兼容形态会逼每个 provider 都做
 * 一层 proxy，反而把简单问题搞复杂。
 */

export interface ProviderConfig {
  apiKey: string;
  baseUrl: string;
  asrModel: string;
  llmModel: string;
  /** 个别 provider 需要的额外参数（如 DashScope 的 ASR 格式） */
  extra?: Record<string, string>;
}

export interface AsrRequest {
  /** 16kHz mono PCM WAV blob */
  audio: Blob;
  cfg: ProviderConfig;
  /** 超时 / 停止时中断请求 */
  signal?: AbortSignal;
}

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface TranslateRequest {
  text: string;
  systemInstruction: string;
  cfg: ProviderConfig;
  onChunk: (chunk: string) => void;
  /** 最近几轮"原文→译文"，作为上下文提升连贯性和术语一致性 */
  history?: ChatTurn[];
  signal?: AbortSignal;
}

export interface Provider {
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  readonly defaultBaseUrl: string;
  readonly defaultAsrModel: string;
  readonly defaultLlmModel: string;
  /** 提供商主页/Key 申请页，方便用户跳转 */
  readonly keyUrl: string;
  /** 当用户在 Custom 模式下，应该填什么 baseUrl 提示 */
  readonly customHint?: string;

  /** 必填字段校验（apiKey、模型名等） */
  validateConfig(cfg: ProviderConfig): string | null;

  /** 调 ASR；返回识别文本 */
  transcribe(req: AsrRequest): Promise<string>;

  /** 调 LLM 流式翻译；onChunk 多次回调，最后不保证 finish 信号（用 Promise resolve 表达） */
  translate(req: TranslateRequest): Promise<void>;
}
