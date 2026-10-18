import { buildMicrophoneConstraints, formatMediaError, isVirtualAudioDevice, isLoopbackInputDevice } from './mediaDevices';
import { isTauriApp } from './tauri';
import { AudioSource } from '../types';

/**
 * 按用户选择的音频源拿到一路可以喂给 LiveSession 的输入。
 *
 * system（会议 / 浏览器 / 视频的声音）解析顺序：
 *   桌面端：原生回环采集（Windows / macOS 14.6+，无需任何虚拟声卡）
 *        → 已安装的回环类输入设备（BlackHole / VB-Cable / 立体声混音 / PulseAudio Monitor）
 *        → Windows 上再试 getDisplayMedia
 *   浏览器：getDisplayMedia 共享标签页 / 整个屏幕的音频
 *
 * microphone：getUserMedia。选中的是虚拟声卡时自动关闭回声消除/降噪/AGC，
 *   否则会议软件推过来的远端人声会被当成"回声"消掉 —— 这是"接会议没反应"的主因之一。
 */

export type CaptureResult =
  | { kind: 'stream'; stream: MediaStream; label: string; stop: () => void }
  | { kind: 'pcm'; sampleRate: number; label: string; stop: () => void };

export interface CaptureOptions {
  source: AudioSource;
  deviceId: string;
  echoCancellation: boolean;
  /** pcm 模式的数据回调 */
  onPcm: (samples: Float32Array) => void;
  /** 设备被拔出 / 共享被用户停止 */
  onEnded: (reason: string) => void;
}

const IS_MAC = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform || navigator.userAgent);
const IS_WINDOWS = typeof navigator !== 'undefined' && /Win/i.test(navigator.platform || navigator.userAgent);

export class CaptureError extends Error {
  /** 建议用户去设置的哪个 tab */
  readonly settingsTab?: 'audio' | 'connection';
  constructor(message: string, settingsTab?: 'audio' | 'connection') {
    super(message);
    this.settingsTab = settingsTab;
  }
}

export async function acquireAudio(opts: CaptureOptions): Promise<CaptureResult> {
  if (!navigator.mediaDevices) {
    throw new CaptureError('当前环境不支持音频采集。请使用最新版 Chrome / Edge，或安装桌面版。');
  }
  return opts.source === 'system' ? acquireSystem(opts) : acquireMicrophone(opts);
}

async function listInputs(): Promise<MediaDeviceInfo[]> {
  try {
    return (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
  } catch {
    return [];
  }
}

function watchEnded(stream: MediaStream, onEnded: (reason: string) => void, reason: string) {
  stream.getAudioTracks().forEach((t) => {
    t.onended = () => onEnded(reason);
  });
}

function rawConstraints(deviceId?: string): MediaTrackConstraints {
  return {
    ...buildMicrophoneConstraints(deviceId, { echoCancellation: false, noiseSuppression: false, autoGainControl: false }),
    channelCount: { ideal: 2 },
  };
}

async function acquireMicrophone(opts: CaptureOptions): Promise<CaptureResult> {
  let label = '麦克风';
  let processing = opts.echoCancellation;
  if (opts.deviceId) {
    const dev = (await listInputs()).find((d) => d.deviceId === opts.deviceId);
    if (dev?.label) label = dev.label;
    if (dev && (isVirtualAudioDevice(dev.label) || isLoopbackInputDevice(dev.label))) processing = false;
  }
  const constraints = processing
    ? buildMicrophoneConstraints(opts.deviceId)
    : rawConstraints(opts.deviceId);
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: constraints });
  } catch (err) {
    // 之前选中的设备被拔了：退回系统默认设备，而不是直接失败
    if (opts.deviceId && err instanceof DOMException && (err.name === 'OverconstrainedError' || err.name === 'NotFoundError')) {
      stream = await navigator.mediaDevices.getUserMedia({ audio: buildMicrophoneConstraints(undefined, { echoCancellation: opts.echoCancellation, noiseSuppression: opts.echoCancellation, autoGainControl: opts.echoCancellation }) });
      label = '系统默认麦克风';
    } else {
      throw new CaptureError(formatMediaError(err, '麦克风访问失败'), 'audio');
    }
  }
  if (!opts.deviceId) label = stream.getAudioTracks()[0]?.label || '系统默认麦克风';
  watchEnded(stream, opts.onEnded, '音频设备已断开（可能被拔出或被其他应用占用）');
  return { kind: 'stream', stream, label, stop: () => stream.getTracks().forEach((t) => t.stop()) };
}

async function acquireSystem(opts: CaptureOptions): Promise<CaptureResult> {
  if (isTauriApp()) {
    // 1) 原生回环
    const { startNativeSystemAudio, nativeSystemAudioSupported } = await import('./nativeAudio');
    let nativeError = '';
    if (await nativeSystemAudioSupported()) {
      try {
        const handle = await startNativeSystemAudio(opts.onPcm);
        return { kind: 'pcm', sampleRate: handle.sampleRate, label: `系统声音 · ${handle.device}`, stop: handle.stop };
      } catch (err) {
        nativeError = err instanceof Error ? err.message : String(err);
        console.warn('[audio] native loopback failed, falling back:', nativeError);
      }
    }

    // 2) 回环类输入设备
    const loop = await findLoopbackInput();
    if (loop) {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: rawConstraints(loop.deviceId) }).catch((err) => {
        throw new CaptureError(formatMediaError(err, '无法打开回环设备'), 'audio');
      });
      watchEnded(stream, opts.onEnded, '回环音频设备已断开');
      return { kind: 'stream', stream, label: loop.label, stop: () => stream.getTracks().forEach((t) => t.stop()) };
    }

    // 3) Windows WebView2 支持 getDisplayMedia
    if (IS_WINDOWS && navigator.mediaDevices.getDisplayMedia) {
      return acquireDisplayAudio(opts);
    }

    if (IS_MAC) {
      throw new CaptureError(
        '无法录制系统声音。\n' +
          (nativeError ? `原因：${nativeError}\n` : '') +
          'macOS 14.6 及以上：请在「系统设置 → 隐私与安全性 → 录屏与系统录音」中允许本应用，然后重试。\n' +
          '更早的 macOS：请安装免费的 BlackHole 虚拟声卡，并把会议软件的扬声器设为 BlackHole。',
        'audio',
      );
    }
    const labels = (await listInputs()).map((d) => d.label).filter(Boolean);
    throw new CaptureError(
      '没有找到可用的系统音频来源。\n' +
        (nativeError ? `原因：${nativeError}\n` : '') +
        'Linux：需要 PulseAudio 或 PipeWire（命令 parec 或 pw-record 可用）。\n' +
        `检测到的输入设备：${labels.length ? labels.join('、') : '无'}`,
      'audio',
    );
  }

  // 浏览器
  if (!navigator.mediaDevices.getDisplayMedia) {
    throw new CaptureError('当前浏览器不支持共享音频。请使用 Chrome / Edge，或安装桌面版。', 'audio');
  }
  return acquireDisplayAudio(opts);
}

async function findLoopbackInput(): Promise<{ deviceId: string; label: string } | null> {
  let inputs = await listInputs();
  // 未授权时 label 为空，先申请一次权限再枚举
  if (inputs.length && inputs.every((d) => !d.label)) {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      s.getTracks().forEach((t) => t.stop());
      inputs = await listInputs();
    } catch { /* 用户拒绝 */ }
  }
  const hit = inputs.find((d) => isLoopbackInputDevice(d.label)) ?? inputs.find((d) => isVirtualAudioDevice(d.label));
  return hit ? { deviceId: hit.deviceId, label: hit.label } : null;
}

async function acquireDisplayAudio(opts: CaptureOptions): Promise<CaptureResult> {
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: true, // Chrome 要求必须带 video，拿到后立刻停掉
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        // 共享时本地照常能听到
        suppressLocalAudioPlayback: false,
      } as MediaTrackConstraints,
      // Chrome 扩展字段：允许共享整个系统音频 / 默认不显示本页
      systemAudio: 'include',
      selfBrowserSurface: 'exclude',
      surfaceSwitching: 'include',
      preferCurrentTab: false,
    } as DisplayMediaStreamOptions);
  } catch (err) {
    if (err instanceof DOMException && err.name === 'NotAllowedError') {
      throw new CaptureError('已取消共享。要翻译会议声音，请在弹窗里选择会议所在的标签页，并勾选「同时分享标签页音频」。', 'audio');
    }
    throw new CaptureError(formatMediaError(err, '共享音频失败'), 'audio');
  }
  stream.getVideoTracks().forEach((t) => t.stop());
  const audioTracks = stream.getAudioTracks();
  if (audioTracks.length === 0) {
    stream.getTracks().forEach((t) => t.stop());
    throw new CaptureError(
      '没有拿到声音。\n请重新开始，并在共享弹窗里：\n· 选「Chrome 标签页」→ 选会议所在标签页 → 打开「同时分享标签页音频」；或\n· 选「整个屏幕」→ 打开「同时分享系统音频」（仅 Windows / ChromeOS）。',
      'audio',
    );
  }
  const audioOnly = new MediaStream(audioTracks);
  watchEnded(audioOnly, opts.onEnded, '共享已停止');
  return {
    kind: 'stream',
    stream: audioOnly,
    label: audioTracks[0].label || '共享的音频',
    stop: () => stream.getTracks().forEach((t) => t.stop()),
  };
}
