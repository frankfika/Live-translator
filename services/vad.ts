import { calculateRMS } from './audioUtils';

/**
 * 自适应 VAD（纯逻辑，不依赖 Web Audio，便于单测）。
 *
 * 旧实现是固定阈值 RMS > 0.015 + 400ms 静音切段，问题：
 * 1. 固定阈值：空调/风扇/键盘底噪高的环境一直判成"在说话"，安静环境下小声又收不到
 * 2. 没有预录（pre-roll）：检测到说话时第一个音节已经过去了，ASR 首字经常丢
 * 3. 400ms 静音就切：句中正常换气都会被切断，翻译成了零碎半句，准确度很差
 * 4. 单帧超阈值就触发：一声咳嗽/敲桌子就开一个段
 *
 * 新实现：
 * - 噪声底（noise floor）用"非说话帧"的慢速 EMA 跟踪，阈值 = max(绝对下限, 噪声底 × 倍数)
 * - 连续 N 帧超阈值才算开始说话（去掉瞬态噪音）
 * - 保留最近 ~300ms 作为预录，拼在段首
 * - 静音 ~700ms 才切段；段太长（>12s）时在段内最安静的位置切一刀，既保证实时又不切在字中间
 * - 段内有效语音帧太少（全是瞬态）直接丢弃
 */

export interface VadOptions {
  sampleRate: number;
  /** 灵敏度：low=嘈杂环境只收清晰人声，high=安静环境连小声也收 */
  sensitivity?: 'low' | 'medium' | 'high';
}

export interface VadSegment {
  samples: Float32Array;
  /** 段内有效语音时长 ms */
  voicedMs: number;
}

interface Profile {
  minThreshold: number;
  floorMultiplier: number;
  startFrames: number;
  minVoicedMs: number;
}

const PROFILES: Record<NonNullable<VadOptions['sensitivity']>, Profile> = {
  low: { minThreshold: 0.02, floorMultiplier: 3.2, startFrames: 4, minVoicedMs: 450 },
  medium: { minThreshold: 0.010, floorMultiplier: 2.6, startFrames: 3, minVoicedMs: 320 },
  high: { minThreshold: 0.005, floorMultiplier: 2.0, startFrames: 2, minVoicedMs: 220 },
};

const PRE_ROLL_MS = 300;
const HANGOVER_MS = 700;
const SOFT_MAX_MS = 12000;
const HARD_MAX_MS = 20000;

export class AdaptiveVad {
  private readonly sampleRate: number;
  private readonly profile: Profile;
  private noiseFloor = 0.003;
  private calibrated = false;
  private calibrationFrames = 0;

  private speaking = false;
  private aboveCount = 0;
  private silenceMs = 0;
  private voicedMs = 0;
  private segment: Float32Array[] = [];
  private segmentLen = 0;
  /** 段内每帧的 RMS，用于软切时找最安静的位置 */
  private segmentRms: number[] = [];
  private preRoll: Float32Array[] = [];
  private preRollLen = 0;

  onSpeechStart?: () => void;
  onSegment?: (seg: VadSegment) => void;
  /** 段被判为噪音丢弃时回调（UI 复位用） */
  onDiscard?: () => void;

  constructor(opts: VadOptions) {
    this.sampleRate = opts.sampleRate;
    this.profile = PROFILES[opts.sensitivity ?? 'medium'];
  }

  get isSpeaking() { return this.speaking; }
  get currentNoiseFloor() { return this.noiseFloor; }

  threshold(): number {
    return Math.max(this.profile.minThreshold, this.noiseFloor * this.profile.floorMultiplier);
  }

  process(frame: Float32Array) {
    const rms = calculateRMS(frame);
    const frameMs = (frame.length / this.sampleRate) * 1000;
    const thr = this.threshold();
    const loud = rms >= thr;

    if (!this.speaking) {
      this.updateNoiseFloor(rms, loud);
      this.pushPreRoll(frame);
      if (loud) {
        this.aboveCount++;
        if (this.aboveCount >= this.profile.startFrames) this.beginSegment();
      } else {
        this.aboveCount = 0;
      }
      return;
    }

    // 说话中
    this.segment.push(frame);
    this.segmentLen += frame.length;
    this.segmentRms.push(rms);
    // 结束判定用稍低的阈值（迟滞），避免句尾弱音被提前切掉
    if (rms >= thr * 0.7) {
      this.voicedMs += frameMs;
      this.silenceMs = 0;
    } else {
      this.silenceMs += frameMs;
    }

    const durMs = (this.segmentLen / this.sampleRate) * 1000;
    if (this.silenceMs >= HANGOVER_MS) {
      this.finishSegment();
    } else if (durMs >= HARD_MAX_MS) {
      this.finishSegment();
    } else if (durMs >= SOFT_MAX_MS && this.silenceMs >= 120) {
      // 已经很长了，遇到一个短停顿就切，保证字幕不会憋太久
      this.finishSegment();
    } else if (durMs >= SOFT_MAX_MS + 3000) {
      this.splitAtQuietest();
    }
  }

  /** 强制把当前段吐出（停止时调用） */
  flush() {
    if (this.speaking) this.finishSegment();
  }

  reset() {
    this.speaking = false;
    this.aboveCount = 0;
    this.silenceMs = 0;
    this.voicedMs = 0;
    this.segment = [];
    this.segmentLen = 0;
    this.segmentRms = [];
    this.preRoll = [];
    this.preRollLen = 0;
  }

  private updateNoiseFloor(rms: number, loud: boolean) {
    // 前 ~0.5s 快速校准；之后只用非说话帧慢速跟踪。
    // 噪声上升慢（防止把说话当噪声），下降快（环境变安静时迅速恢复灵敏度）
    if (!this.calibrated) {
      this.calibrationFrames++;
      this.noiseFloor = this.calibrationFrames === 1 ? rms : this.noiseFloor * 0.8 + rms * 0.2;
      if (this.calibrationFrames >= 15) this.calibrated = true;
      return;
    }
    if (loud) return;
    const alpha = rms > this.noiseFloor ? 0.02 : 0.15;
    this.noiseFloor = this.noiseFloor * (1 - alpha) + rms * alpha;
    this.noiseFloor = Math.min(Math.max(this.noiseFloor, 0.0005), 0.08);
  }

  private pushPreRoll(frame: Float32Array) {
    this.preRoll.push(frame);
    this.preRollLen += frame.length;
    const max = (PRE_ROLL_MS / 1000) * this.sampleRate;
    while (this.preRoll.length > 1 && this.preRollLen - this.preRoll[0].length >= max) {
      this.preRollLen -= this.preRoll.shift()!.length;
    }
  }

  private beginSegment() {
    this.speaking = true;
    this.segment = this.preRoll;
    this.segmentLen = this.preRollLen;
    this.segmentRms = this.preRoll.map((f) => calculateRMS(f));
    this.preRoll = [];
    this.preRollLen = 0;
    this.silenceMs = 0;
    const frameMs = this.segment.length ? (this.segment[0].length / this.sampleRate) * 1000 : 0;
    this.voicedMs = this.aboveCount * frameMs;
    this.aboveCount = 0;
    this.onSpeechStart?.();
  }

  private emit(frames: Float32Array[], voicedMs: number) {
    if (voicedMs < this.profile.minVoicedMs) {
      this.onDiscard?.();
      return;
    }
    const total = frames.reduce((n, f) => n + f.length, 0);
    const merged = new Float32Array(total);
    let off = 0;
    for (const f of frames) { merged.set(f, off); off += f.length; }
    this.onSegment?.({ samples: merged, voicedMs });
  }

  private finishSegment() {
    const frames = this.segment;
    const voiced = this.voicedMs;
    // 去掉段尾多余的静音（保留 ~200ms 收尾）
    const frameMs = frames.length ? (frames[0].length / this.sampleRate) * 1000 : 1;
    const trailing = Math.max(0, Math.floor((this.silenceMs - 200) / frameMs));
    const kept = trailing > 0 ? frames.slice(0, Math.max(1, frames.length - trailing)) : frames;
    this.speaking = false;
    this.segment = [];
    this.segmentLen = 0;
    this.segmentRms = [];
    this.silenceMs = 0;
    this.voicedMs = 0;
    this.emit(kept, voiced);
  }

  /** 在段的后半部分找最安静的帧切开，前半段发出去，后半段继续累积 */
  private splitAtQuietest() {
    const n = this.segment.length;
    const from = Math.floor(n * 0.5);
    let best = from;
    for (let i = from; i < n - 1; i++) {
      if (this.segmentRms[i] < this.segmentRms[best]) best = i;
    }
    const head = this.segment.slice(0, best + 1);
    const tail = this.segment.slice(best + 1);
    const tailRms = this.segmentRms.slice(best + 1);
    const ratio = head.length / n;
    const headVoiced = this.voicedMs * ratio;
    this.segment = tail;
    this.segmentRms = tailRms;
    this.segmentLen = tail.reduce((s, f) => s + f.length, 0);
    this.voicedMs -= headVoiced;
    this.emit(head, headVoiced);
  }
}
