import { invoke, Channel } from '@tauri-apps/api/core';

/** 桌面端原生系统音频（回环）采集。Rust 侧见 src-tauri/src/audio.rs */

export interface NativeAudioHandle {
  sampleRate: number;
  device: string;
  stop: () => void;
}

let supportedCache: boolean | null = null;

export async function nativeSystemAudioSupported(): Promise<boolean> {
  if (supportedCache !== null) return supportedCache;
  try {
    supportedCache = await invoke<boolean>('system_audio_supported');
  } catch {
    supportedCache = false;
  }
  return supportedCache;
}

export async function startNativeSystemAudio(onPcm: (samples: Float32Array) => void): Promise<NativeAudioHandle> {
  const channel = new Channel<ArrayBuffer | number[]>();
  let active = true;
  channel.onmessage = (data) => {
    if (!active) return;
    // Rust 发的是原始 f32 LE 字节
    const buf = data instanceof ArrayBuffer ? data : new Uint8Array(data as number[]).buffer;
    onPcm(new Float32Array(buf));
  };
  const info = await invoke<{ sampleRate: number; device: string }>('start_system_audio', { onAudio: channel });
  return {
    sampleRate: info.sampleRate,
    device: info.device,
    stop: () => {
      active = false;
      void invoke('stop_system_audio').catch(() => {});
    },
  };
}
