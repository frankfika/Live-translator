import { downsampleTo16k, encodeWAV, calculateRMS } from './audioUtils';
import { buildMicrophoneConstraints } from './mediaDevices';
import { Provider, ProviderConfig } from './providers';

/**
 * 实时会话：mic/system audio → VAD → 切片 → Provider.transcribe → Provider.translate
 *
 * 重要：这一层不绑定任何具体 ASR/LLM。Provider 决定走哪家。
 * 之前 P0-1 (CSP) / P0-2 (mic feedback) / P0-3 (AudioContext resume) / P0-4 (Tauri 权限) 的
 * 修法都保留 — 这些跟 provider 无关。
 */

const VAD_THRESHOLD = 0.015;
const SILENCE_DURATION_MS = 400;
const MIN_SPEECH_DURATION_MS = 300;
// 上限 60s — 之前的 15s 会在长句(会议发言)中间强制切段,导致后半段
// 被 isProcessing 静默吞掉。60s 对会议发言足够,且能切给多说话人。
const MAX_SPEECH_DURATION_MS = 60000;

export interface LiveCallbacks {
  onOpen: () => void;
  onClose: () => void;
  onError: (error: Error) => void;
  onInputTranscription: (text: string) => void;
  onOutputTranscription: (text: string) => void;
  onTurnComplete: () => void;
  onAudioData: (data: Float32Array) => void;
  onVADSpeechStart?: () => void;
  onVADSpeechEnd?: () => void;
}

export interface LiveConfig {
  systemInstruction: string;
  provider: Provider;
  providerConfig: ProviderConfig;
}

export class LiveSession {
  private provider: Provider;
  private providerConfig: ProviderConfig;
  private inputAudioContext: AudioContext | null = null;
  private mediaStream: MediaStream | null = null;
  private processor: ScriptProcessorNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private isConnected = false;
  private ownsStream = false;
  private callbacks: LiveCallbacks | null = null;
  private systemInstruction = '';
  private silentSink: GainNode | null = null;

  // VAD
  private audioBuffer: Float32Array[] = [];
  private isSpeaking = false;
  private silenceStartTime = 0;
  private speechStartTime = 0;
  private sourceSampleRate = 16000;
  private isProcessing = false;
  // 上一段还没处理完,新段就来了 → 暂存到 pending,处理完接着处理
  // 之前直接静默丢,长句中段/快速说话场景下后半段全没了
  private pendingSamples: Float32Array | null = null;

  constructor(provider: Provider, providerConfig: ProviderConfig) {
    this.provider = provider;
    this.providerConfig = providerConfig;
  }

  async connect(callbacks: LiveCallbacks, existingStream?: MediaStream) {
    if (this.isConnected) return;
    try {
      // 1) Provider 配置校验（比连接更早失败，省下打开 mic 的成本）
      const err = this.provider.validateConfig(this.providerConfig);
      if (err) {
        callbacks.onError(new Error(`${this.provider.displayName} 配置错误: ${err}`));
        return;
      }

      this.callbacks = callbacks;
      this.systemInstruction = this.systemInstruction || '';

      // 2) AudioContext — 跟 P0-3 修复一致：resume + 兜底 native sampleRate
      try {
        this.inputAudioContext = new AudioContext({ sampleRate: 16000 });
      } catch {
        this.inputAudioContext = new AudioContext();
      }
      if (this.inputAudioContext.state === 'suspended') {
        try { await this.inputAudioContext.resume(); } catch { /* user gesture */ }
      }
      this.sourceSampleRate = this.inputAudioContext.sampleRate;

      // 3) Media stream
      if (existingStream) {
        this.mediaStream = existingStream;
        this.ownsStream = false;
      } else {
        // 走 buildMicrophoneConstraints() 而非裸 { audio: true } —
        // 默认开回声消除/降噪/AGC，避免会议场景啸叫/收音混乱。
        // 不传 deviceId：LiveSession 不感知设备选择，设备由 App.tsx 通过
        // existingStream 传入；这里只是没传 stream 时的兜底分支。
        this.mediaStream = await navigator.mediaDevices.getUserMedia({
          audio: buildMicrophoneConstraints(),
        });
        this.ownsStream = true;
      }

      this.isConnected = true;
      this.setupAudioProcessing();
      callbacks.onOpen();
    } catch (err) {
      this.isConnected = false;
      callbacks.onError(err as Error);
    }
  }

  private setupAudioProcessing() {
    if (!this.inputAudioContext || !this.mediaStream || !this.callbacks) return;

    this.source = this.inputAudioContext.createMediaStreamSource(this.mediaStream);
    this.processor = this.inputAudioContext.createScriptProcessor(1024, 1, 1);

    this.processor.onaudioprocess = (event) => {
      if (!this.isConnected) return;
      const inputData = event.inputBuffer.getChannelData(0);
      const samples = new Float32Array(inputData);
      this.callbacks?.onAudioData(samples);
      this.processVAD(samples);
    };

    // P0-2 修复：ScriptProcessor 必须 connect 到某个节点才能触发 onaudioprocess，
    // 但连到 destination 会触发 macOS 防啸叫静音。改连 mute GainNode。
    const sink = this.inputAudioContext.createGain();
    sink.gain.value = 0;
    this.source.connect(this.processor);
    this.processor.connect(sink);
    this.silentSink = sink;
  }

  private processVAD(samples: Float32Array) {
    const rms = calculateRMS(samples);
    const now = Date.now();
    const isSilent = rms < VAD_THRESHOLD;

    if (!isSilent) {
      if (!this.isSpeaking) {
        this.isSpeaking = true;
        this.speechStartTime = now;
        this.audioBuffer = [];
        this.callbacks?.onVADSpeechStart?.();
      }
      this.audioBuffer.push(new Float32Array(samples));
      this.silenceStartTime = 0;

      if (now - this.speechStartTime > MAX_SPEECH_DURATION_MS) {
        this.endSpeechSegment();
      }
    } else {
      if (this.isSpeaking) {
        this.audioBuffer.push(new Float32Array(samples));
        if (this.silenceStartTime === 0) {
          this.silenceStartTime = now;
        } else if (now - this.silenceStartTime >= SILENCE_DURATION_MS) {
          const speechDuration = now - this.speechStartTime;
          if (speechDuration >= MIN_SPEECH_DURATION_MS) {
            this.endSpeechSegment();
          } else {
            this.resetVAD();
          }
        }
      }
    }
  }

  private resetVAD() {
    this.isSpeaking = false;
    this.silenceStartTime = 0;
    this.speechStartTime = 0;
    this.audioBuffer = [];
  }

  private endSpeechSegment() {
    if (!this.callbacks || this.audioBuffer.length === 0) {
      this.resetVAD();
      return;
    }
    const totalLength = this.audioBuffer.reduce((sum, chunk) => sum + chunk.length, 0);
    const merged = new Float32Array(totalLength);
    let offset = 0;
    for (const chunk of this.audioBuffer) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    this.resetVAD();
    this.callbacks.onVADSpeechEnd?.();
    this.processAudioSegment(merged);
  }

  private async processAudioSegment(samples: Float32Array) {
    if (!this.callbacks) return;
    if (this.isProcessing) {
      // 当前还在处理上一段 → 把新段暂存, finally 里接着处理
      // 之前直接 return 导致快速说话/长句场景下后半段全丢
      this.pendingSamples = samples;
      return;
    }
    this.isProcessing = true;
    try {
      const downsampled = downsampleTo16k(samples, this.sourceSampleRate);
      const wavBlob = encodeWAV(downsampled, 16000);

      // ASR 通过 Provider
      const transcription = await this.provider.transcribe({
        audio: wavBlob,
        cfg: this.providerConfig,
      });
      if (!transcription) {
        // ASR 返空(纯噪音/呼吸/咳嗽) — 显式触发 onTurnComplete 让 UI
        // 从 'processing' phase 复位回 'idle',否则 phase 永远卡住
        this.callbacks.onVADSpeechEnd?.();
        this.callbacks.onTurnComplete();
        return;
      }
      this.callbacks.onInputTranscription(transcription);

      // LLM 流式翻译通过 Provider
      await this.provider.translate({
        text: transcription,
        systemInstruction: this.systemInstruction,
        cfg: this.providerConfig,
        onChunk: (chunk) => this.callbacks?.onOutputTranscription(chunk),
      });

      this.callbacks.onTurnComplete();
    } catch (err) {
      this.callbacks.onError(err as Error);
    } finally {
      this.isProcessing = false;
      // 如果有堆积段,接着处理
      if (this.pendingSamples && this.callbacks) {
        const next = this.pendingSamples;
        this.pendingSamples = null;
        // 异步递归, 不阻塞当前 finally
        void this.processAudioSegment(next);
      }
    }
  }

  getStream(): MediaStream | null {
    return this.mediaStream;
  }

  async disconnect() {
    this.isConnected = false;
    this.resetVAD();
    if (this.silentSink) {
      try { this.silentSink.disconnect(); } catch { /* noop */ }
      this.silentSink = null;
    }
    if (this.source) {
      try { this.source.disconnect(); } catch { /* noop */ }
      this.source = null;
    }
    if (this.processor) {
      try { this.processor.disconnect(); } catch { /* noop */ }
      this.processor = null;
    }
    if (this.mediaStream && this.ownsStream) {
      this.mediaStream.getTracks().forEach((track) => track.stop());
    }
    this.mediaStream = null;
    if (this.inputAudioContext) {
      try { await this.inputAudioContext.close(); } catch { /* noop */ }
      this.inputAudioContext = null;
    }
    this.callbacks?.onClose();
    this.callbacks = null;
  }
}
