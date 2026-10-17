import { downsampleTo16k, encodeWAV, calculateRMS } from './audioUtils';
import { AdaptiveVad, VadSegment } from './vad';
import { judgeTranscript, cleanTranslation, isSkipOutput, mightBeSkipPrefix } from './textFilter';
import { Provider, ProviderConfig, ChatTurn } from './providers';

/**
 * 实时会话：音频帧 → 自适应 VAD → 段队列 → ASR → 文本过滤 → LLM 流式翻译
 *
 * 音频来源两种：
 * - MediaStream（麦克风 / 虚拟声卡 / 浏览器标签页音频）：attachStream()
 * - 原生 PCM（桌面端 Rust 采集的系统回环音频）：feed()
 *
 * 相比旧版的关键修复：
 * - pendingSamples 只有一个槽位，第三段会覆盖第二段 → 改成 FIFO 队列，积压时合并相邻段
 * - 单段网络错误直接把整个会话打成 ERROR → 改成非致命告警，只有鉴权失败/连续失败才停
 * - ASR/LLM 请求没有超时，卡住后后续全部堆积 → 加 AbortController 超时
 * - 翻译不带上下文 → 带最近 3 轮原文/译文，术语和指代更一致
 */

const ASR_TIMEOUT_MS = 20000;
const LLM_TIMEOUT_MS = 30000;
const HISTORY_TURNS = 3;
const MAX_QUEUE = 6;
const MAX_MERGED_SAMPLES_SEC = 25;
const MAX_CONSECUTIVE_FAILURES = 4;

export interface LiveCallbacks {
  onOpen: () => void;
  onClose: () => void;
  /** 致命错误：会话已停止 */
  onError: (error: Error) => void;
  /** 非致命：单段失败，会话继续 */
  onWarning?: (message: string) => void;
  onSpeechStart?: () => void;
  /** 开始识别某一段 */
  onSegmentStart?: (id: string) => void;
  onTranscript?: (id: string, text: string) => void;
  /** 当前段的完整译文（已清洗，流式累积） */
  onTranslation?: (id: string, text: string) => void;
  onTurnComplete?: (id: string, original: string, translated: string) => void;
  /** 段被判定为噪音 / 无内容 */
  onDiscard?: (id?: string) => void;
  /** 输入电平 0..1，约 20fps */
  onLevel?: (level: number) => void;
}

export interface LiveConfig {
  provider: Provider;
  providerConfig: ProviderConfig;
  systemInstruction: string;
  vadSensitivity?: 'low' | 'medium' | 'high';
}

let segSeq = 0;

export class LiveSession {
  private readonly cfg: LiveConfig;
  private callbacks: LiveCallbacks | null = null;
  private connected = false;

  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  private sink: GainNode | null = null;

  private vad: AdaptiveVad | null = null;
  private sampleRate = 16000;
  private queue: Float32Array[] = [];
  private working = false;
  private history: ChatTurn[] = [];
  private failures = 0;
  private inflight: AbortController | null = null;

  private levelAcc = 0;
  private levelFrames = 0;
  private lastLevelAt = 0;

  constructor(cfg: LiveConfig) {
    this.cfg = cfg;
  }

  get isConnected() { return this.connected; }

  /** 校验配置并准备 VAD。返回 false 表示已通过 onError 报错 */
  private open(callbacks: LiveCallbacks, sampleRate: number): boolean {
    const err = this.cfg.provider.validateConfig(this.cfg.providerConfig);
    if (err) {
      callbacks.onError(new Error(`${this.cfg.provider.displayName} 配置错误：${err}`));
      return false;
    }
    this.callbacks = callbacks;
    this.sampleRate = sampleRate;
    this.vad = new AdaptiveVad({ sampleRate, sensitivity: this.cfg.vadSensitivity });
    this.vad.onSpeechStart = () => this.callbacks?.onSpeechStart?.();
    this.vad.onDiscard = () => this.callbacks?.onDiscard?.();
    this.vad.onSegment = (seg) => this.enqueue(seg);
    this.connected = true;
    return true;
  }

  /** 用 MediaStream 作为输入（调用方负责 stream 的生命周期） */
  async attachStream(callbacks: LiveCallbacks, stream: MediaStream): Promise<void> {
    if (this.connected) return;
    try {
      // 不强制 16k：部分 WebView 在非原生采样率下 createMediaStreamSource 会报错或静音
      this.ctx = new AudioContext();
      if (this.ctx.state === 'suspended') {
        try { await this.ctx.resume(); } catch { /* 需要用户手势，下面会再试 */ }
      }
      if (!this.open(callbacks, this.ctx.sampleRate)) {
        await this.ctx.close().catch(() => {});
        this.ctx = null;
        return;
      }
      this.stream = stream;
      this.source = this.ctx.createMediaStreamSource(stream);
      // 2048 @48k ≈ 43ms 一帧，VAD 粒度足够，回调频率减半
      this.processor = this.ctx.createScriptProcessor(2048, 1, 1);
      this.processor.onaudioprocess = (e) => {
        if (!this.connected) return;
        this.handleFrame(new Float32Array(e.inputBuffer.getChannelData(0)));
      };
      // ScriptProcessor 必须连到 destination 才会触发回调；中间加 0 增益避免回放
      this.sink = this.ctx.createGain();
      this.sink.gain.value = 0;
      this.source.connect(this.processor);
      this.processor.connect(this.sink);
      this.sink.connect(this.ctx.destination);
      if (this.ctx.state === 'suspended') await this.ctx.resume().catch(() => {});
      callbacks.onOpen();
    } catch (err) {
      this.connected = false;
      callbacks.onError(err as Error);
    }
  }

  /** 外部 PCM 输入模式（原生系统音频采集） */
  attachPcm(callbacks: LiveCallbacks, sampleRate: number): void {
    if (this.connected) return;
    if (this.open(callbacks, sampleRate)) callbacks.onOpen();
  }

  /** 喂一帧 PCM（单声道 float32，采样率 = attachPcm 时传入的） */
  feed(samples: Float32Array) {
    if (!this.connected) return;
    this.handleFrame(samples);
  }

  private handleFrame(frame: Float32Array) {
    this.vad?.process(frame);
    // 电平：限频上报，避免 React 每帧重渲染
    this.levelAcc += calculateRMS(frame);
    this.levelFrames++;
    const now = performance.now();
    if (now - this.lastLevelAt > 50) {
      const rms = this.levelAcc / this.levelFrames;
      this.levelAcc = 0;
      this.levelFrames = 0;
      this.lastLevelAt = now;
      // 对数映射：-60dB..0dB → 0..1
      const db = 20 * Math.log10(Math.max(rms, 1e-6));
      this.callbacks?.onLevel?.(Math.min(1, Math.max(0, (db + 60) / 60)));
    }
  }

  private enqueue(seg: VadSegment) {
    this.queue.push(seg.samples);
    // 积压过多：丢最老的，保证字幕跟得上当前说话
    while (this.queue.length > MAX_QUEUE) this.queue.shift();
    void this.drain();
  }

  private async drain() {
    if (this.working) return;
    this.working = true;
    try {
      while (this.connected && this.queue.length) {
        // 积压时把相邻段合成一段：少一次往返，而且上下文更完整翻得更准
        let samples = this.queue.shift()!;
        const maxLen = MAX_MERGED_SAMPLES_SEC * this.sampleRate;
        while (this.queue.length && samples.length + this.queue[0].length <= maxLen) {
          const next = this.queue.shift()!;
          const merged = new Float32Array(samples.length + next.length);
          merged.set(samples);
          merged.set(next, samples.length);
          samples = merged;
        }
        await this.processSegment(samples);
      }
    } finally {
      this.working = false;
    }
  }

  private async processSegment(samples: Float32Array) {
    const cb = this.callbacks;
    if (!cb) return;
    const id = `seg-${Date.now()}-${++segSeq}`;
    cb.onSegmentStart?.(id);
    const { provider, providerConfig, systemInstruction } = this.cfg;

    try {
      const pcm16k = downsampleTo16k(samples, this.sampleRate);
      const wav = encodeWAV(pcm16k, 16000);

      const raw = await this.withTimeout(ASR_TIMEOUT_MS, (signal) =>
        provider.transcribe({ audio: wav, cfg: providerConfig, signal }),
      );
      if (!this.connected) return;
      const verdict = judgeTranscript(raw);
      if (!verdict.keep) {
        cb.onDiscard?.(id);
        this.failures = 0;
        return;
      }
      const original = verdict.text;
      cb.onTranscript?.(id, original);

      let acc = '';
      await this.withTimeout(LLM_TIMEOUT_MS, (signal) =>
        provider.translate({
          text: original,
          systemInstruction,
          cfg: providerConfig,
          history: [...this.history],
          signal,
          onChunk: (chunk) => {
            acc += chunk;
            const clean = cleanTranslation(acc);
            if (!clean || mightBeSkipPrefix(clean)) return;
            this.callbacks?.onTranslation?.(id, clean);
          },
        }),
      );
      if (!this.connected) return;

      const translated = cleanTranslation(acc);
      if (isSkipOutput(translated)) {
        cb.onDiscard?.(id);
      } else {
        this.history.push({ role: 'user', content: original }, { role: 'assistant', content: translated });
        if (this.history.length > HISTORY_TURNS * 2) this.history.splice(0, this.history.length - HISTORY_TURNS * 2);
        cb.onTurnComplete?.(id, original, translated);
      }
      this.failures = 0;
    } catch (err) {
      if (!this.connected) return;
      this.failures++;
      const e = err as Error;
      const msg = e?.name === 'AbortError' ? '请求超时' : e?.message || String(err);
      cb.onDiscard?.(id);
      if (isFatal(msg) || this.failures >= MAX_CONSECUTIVE_FAILURES) {
        const hint = isFatal(msg) ? '' : `（连续 ${this.failures} 次失败）`;
        cb.onError(new Error(`${humanizeError(msg)}${hint}`));
        void this.disconnect();
      } else {
        cb.onWarning?.(humanizeError(msg));
      }
    }
  }

  private async withTimeout<T>(ms: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const ctrl = new AbortController();
    this.inflight = ctrl;
    const timer = setTimeout(() => ctrl.abort(), ms);
    try {
      return await run(ctrl.signal);
    } finally {
      clearTimeout(timer);
      if (this.inflight === ctrl) this.inflight = null;
    }
  }

  async disconnect() {
    if (!this.connected && !this.ctx) return;
    // 把正在说的半句也送出去？停止时用户通常不想再等，直接丢弃
    this.connected = false;
    this.queue = [];
    this.inflight?.abort();
    this.inflight = null;
    this.vad?.reset();
    for (const node of [this.sink, this.processor, this.source]) {
      try { node?.disconnect(); } catch { /* noop */ }
    }
    if (this.processor) this.processor.onaudioprocess = null;
    this.sink = this.processor = this.source = null;
    this.stream = null;
    if (this.ctx) {
      await this.ctx.close().catch(() => {});
      this.ctx = null;
    }
    const cb = this.callbacks;
    this.callbacks = null;
    cb?.onClose();
  }
}

/** 鉴权 / 余额 / 模型不存在这类，重试没意义，直接停 */
function isFatal(msg: string): boolean {
  return /HTTP (401|402|403|404)\b|配置错误|invalid api key|unauthorized|insufficient|余额/i.test(msg);
}

export function humanizeError(msg: string): string {
  if (/HTTP 401|unauthorized|invalid api key/i.test(msg)) return 'API Key 无效或已过期，请在设置里更新。';
  if (/HTTP 402|insufficient|余额/i.test(msg)) return '账户余额不足，请到服务商控制台充值。';
  if (/HTTP 403/.test(msg)) return '服务商拒绝访问（403），请检查 Key 权限或模型开通状态。';
  if (/HTTP 404/.test(msg)) return '接口或模型不存在（404），请检查 API 地址和模型名。';
  if (/HTTP 429|rate limit/i.test(msg)) return '请求太频繁被限流，稍后自动恢复。';
  if (/HTTP 5\d\d/.test(msg)) return '服务商暂时不可用，稍后自动重试。';
  if (/Failed to fetch|NetworkError|network|Load failed/i.test(msg)) return '网络连接失败，请检查网络。';
  if (/超时/.test(msg)) return '请求超时，网络较慢。';
  return msg;
}
