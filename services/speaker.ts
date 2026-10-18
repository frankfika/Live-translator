import { Provider, ProviderConfig } from './providers';
import { decodeWav } from './wav';
import { isTauriApp } from './tauri';

/**
 * 把"我说的话"的译文合成语音，播放到指定输出设备（通常是虚拟声卡 → 会议软件的麦克风）。
 *
 * - 顺序播放，不叠音
 * - 积压太多时丢掉旧的，只念最新的（同传宁可漏一句也不能越拖越晚）
 * - 桌面端交给 Rust 播放（可以指定任意输出设备，Linux 走 PulseAudio）；
 *   浏览器端用 AudioContext.setSinkId（Chrome / Edge 支持）
 */

export interface OutputDeviceInfo {
  id: string;
  label: string;
  isVirtual: boolean;
}

const MAX_BACKLOG = 2;

export class Speaker {
  private queue: string[] = [];
  private busy = false;
  private stopped = false;
  private ctrl: AbortController | null = null;
  private webCtx: AudioContext | null = null;

  constructor(
    private readonly provider: Provider,
    private readonly cfg: ProviderConfig,
    private readonly voice: string,
    private readonly device: string,
    private readonly onError?: (msg: string) => void,
  ) {}

  say(text: string) {
    if (this.stopped || !text.trim()) return;
    this.queue.push(text);
    while (this.queue.length > MAX_BACKLOG) this.queue.shift();
    void this.drain();
  }

  stop() {
    this.stopped = true;
    this.queue = [];
    this.ctrl?.abort();
    void this.webCtx?.close().catch(() => {});
    this.webCtx = null;
  }

  private async drain() {
    if (this.busy) return;
    this.busy = true;
    try {
      while (!this.stopped && this.queue.length) {
        const text = this.queue.shift()!;
        try {
          await this.speakOnce(text);
        } catch (err) {
          if (this.stopped) return;
          // Tauri 的 invoke 失败时 reject 的是字符串，不是 Error
          const msg = err instanceof Error ? (err.name === 'AbortError' ? '语音合成超时' : err.message) : String(err);
          this.onError?.(`语音输出失败：${msg}`);
        }
      }
    } finally {
      this.busy = false;
    }
  }

  private async speakOnce(text: string) {
    if (!this.provider.synthesize) throw new Error(`${this.provider.displayName} 不支持语音合成`);
    this.ctrl = new AbortController();
    const timer = setTimeout(() => this.ctrl?.abort(), 20000);
    let wav: ArrayBuffer;
    try {
      wav = await this.provider.synthesize({ text, voice: this.voice, cfg: this.cfg, signal: this.ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
    if (this.stopped) return;
    const { samples, sampleRate } = decodeWav(wav);
    await playSamples(samples, sampleRate, this.device, (ctx) => { this.webCtx = ctx; });
  }
}

/** 播放一段单声道 PCM。桌面端立即返回（Rust 侧排队播放），浏览器端等播完 */
export async function playSamples(
  samples: Float32Array,
  sampleRate: number,
  device: string,
  onWebContext?: (ctx: AudioContext) => void,
): Promise<void> {
  if (isTauriApp()) {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('play_audio', { device, sampleRate, pcmB64: pcm16Base64(samples) });
    // 桌面端 Rust 侧排队；这里按时长等待，保证下一句不会提前合成完挤占队列太多
    await new Promise((r) => setTimeout(r, (samples.length / sampleRate) * 1000));
    return;
  }
  const ctx = new AudioContext();
  onWebContext?.(ctx);
  const sinkCtx = ctx as AudioContext & { setSinkId?: (id: string) => Promise<void> };
  if (device && sinkCtx.setSinkId) await sinkCtx.setSinkId(device).catch(() => {});
  const buffer = ctx.createBuffer(1, samples.length, sampleRate);
  buffer.copyToChannel(samples, 0);
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.connect(ctx.destination);
  await new Promise<void>((resolve) => {
    src.onended = () => resolve();
    src.start();
  });
  await ctx.close().catch(() => {});
}

/** float32 → 16 位小端 PCM → base64（Linux 上 Tauri IPC 传不了原始字节） */
export function pcm16Base64(samples: Float32Array): string {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
  }
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

export async function listOutputDevices(): Promise<OutputDeviceInfo[]> {
  if (isTauriApp()) {
    const { invoke } = await import('@tauri-apps/api/core');
    try {
      return await invoke<OutputDeviceInfo[]>('list_output_devices');
    } catch {
      return [];
    }
  }
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices
      .filter((d) => d.kind === 'audiooutput')
      .map((d) => ({ id: d.deviceId, label: d.label || '输出设备', isVirtual: /cable|blackhole|virtual|voicemeeter|虚拟/i.test(d.label) }));
  } catch {
    return [];
  }
}

const IS_LINUX = typeof navigator !== 'undefined' && /Linux/i.test(navigator.platform || navigator.userAgent) && !/Android/i.test(navigator.userAgent);

/**
 * 决定译文语音播到哪：用户指定了就用；否则自动选虚拟声卡；Linux 桌面端自动建虚拟麦克风。
 * 找不到合适设备时抛出带安装指引的错误。
 */
export async function resolveOutputDevice(preferred: string): Promise<{ id: string; label: string }> {
  const devices = await listOutputDevices();
  if (preferred) {
    const hit = devices.find((d) => d.id === preferred);
    return { id: preferred, label: hit?.label ?? preferred };
  }
  if (isTauriApp() && IS_LINUX) {
    const { invoke } = await import('@tauri-apps/api/core');
    const sink = await invoke<string>('setup_virtual_mic');
    return { id: sink, label: 'AI-Interpreter-Virtual-Mic' };
  }
  const virtual = devices.find((d) => d.isVirtual);
  if (virtual) return { id: virtual.id, label: virtual.label };
  throw new Error(VIRTUAL_MIC_HELP);
}

const IS_MAC = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform || navigator.userAgent);

export const VIRTUAL_MIC_HELP = IS_MAC
  ? '要让会议对方听到译文，需要一个虚拟麦克风。\n请安装免费的 BlackHole（existential.audio/blackhole），然后在会议软件里把麦克风选成「BlackHole 2ch」。'
  : '要让会议对方听到译文，需要一个虚拟麦克风。\n请安装免费的 VB-Cable（vb-audio.com/Cable），然后在会议软件里把麦克风选成「CABLE Output」。';
