import { AudioSource } from '../types';
import { getSetting, setSetting, isTauriApp } from './tauri';

/**
 * 所有用户设置收拢到一个对象里。
 * 之前 App.tsx 里 10 个 useState + 10 个 useEffect 各自持久化，
 * 现在多窗口（悬浮窗 / 控制面板）要共享同一份设置，统一走这里。
 */
export interface AppSettings {
  langA: string;
  langB: string;
  audioSource: AudioSource;
  audioInputDeviceId: string;
  /** 麦克风模式下的回声消除/降噪/自动增益（虚拟声卡 / 系统音频会强制关闭） */
  echoCancellation: boolean;
  providerId: string;
  apiKey: string;
  baseUrl: string;
  asrModel: string;
  llmModel: string;
  /** 术语表 / 热词：人名、产品名、行业术语，每行一个，可写成 "原文=译文" */
  glossary: string;
  /** VAD 灵敏度：low 只收清晰人声（嘈杂环境），high 连小声也收 */
  vadSensitivity: 'low' | 'medium' | 'high';

  // ── 悬浮字幕外观 ──
  overlayFontSize: number;
  overlayOpacity: number;
  overlayShowOriginal: boolean;
  /** 空闲多少秒后字幕淡出（0 = 不淡出） */
  overlayAutoHideSec: number;
  /** 屏幕共享 / 录屏时隐藏悬浮窗（macOS / Windows） */
  overlayHideInScreenShare: boolean;
}

export const DEFAULT_SETTINGS: AppSettings = {
  langA: 'English',
  langB: 'Chinese',
  // 主要场景是听会议对方 / 视频，默认抓电脑声音
  audioSource: 'system',
  audioInputDeviceId: '',
  echoCancellation: true,
  providerId: 'siliconflow',
  apiKey: '',
  baseUrl: '',
  asrModel: '',
  llmModel: '',
  glossary: '',
  vadSensitivity: 'medium',
  overlayFontSize: 22,
  overlayOpacity: 0.78,
  overlayShowOriginal: true,
  overlayAutoHideSec: 8,
  overlayHideInScreenShare: true,
};

const KEYS = Object.keys(DEFAULT_SETTINGS) as (keyof AppSettings)[];
const LS_PREFIX = 'interp_';

function decode<K extends keyof AppSettings>(key: K, raw: string): AppSettings[K] {
  const def = DEFAULT_SETTINGS[key];
  if (typeof def === 'boolean') return (raw === 'true') as AppSettings[K];
  if (typeof def === 'number') {
    const n = Number(raw);
    return (Number.isFinite(n) ? n : def) as AppSettings[K];
  }
  return raw as AppSettings[K];
}

/** 把任意来源（存储 / 事件 payload）的数据规整成完整 AppSettings */
export function normalizeSettings(partial: Partial<Record<keyof AppSettings, unknown>>): AppSettings {
  const out = { ...DEFAULT_SETTINGS };
  for (const key of KEYS) {
    const v = partial[key];
    if (v === undefined || v === null) continue;
    (out as Record<string, unknown>)[key] = typeof v === 'string' ? decode(key, v) : v;
  }
  if (out.audioSource !== 'microphone' && out.audioSource !== 'system') out.audioSource = DEFAULT_SETTINGS.audioSource;
  if (!['low', 'medium', 'high'].includes(out.vadSensitivity)) out.vadSensitivity = 'medium';
  out.overlayFontSize = Math.min(48, Math.max(12, out.overlayFontSize));
  out.overlayOpacity = Math.min(1, Math.max(0.2, out.overlayOpacity));
  return out;
}

export async function loadSettings(): Promise<AppSettings> {
  const raw: Partial<Record<keyof AppSettings, string>> = {};
  if (isTauriApp()) {
    await Promise.all(
      KEYS.map(async (key) => {
        const v = await getSetting(key);
        if (v !== null && v !== undefined) raw[key] = v;
      }),
    );
  } else {
    for (const key of KEYS) {
      try {
        const v = localStorage.getItem(LS_PREFIX + key);
        if (v !== null) raw[key] = v;
      } catch { /* 隐私模式 */ }
    }
  }
  return normalizeSettings(raw);
}

/** 只写变化的字段 */
export async function saveSettings(next: AppSettings, prev?: AppSettings): Promise<void> {
  const changed = KEYS.filter((k) => !prev || prev[k] !== next[k]);
  if (isTauriApp()) {
    await Promise.all(changed.map((k) => setSetting(k, String(next[k])).catch(() => {})));
  } else {
    for (const k of changed) {
      try { localStorage.setItem(LS_PREFIX + k, String(next[k])); } catch { /* noop */ }
    }
  }
}

/** 改了这些字段需要重启正在进行的翻译会话 */
export const SESSION_KEYS: (keyof AppSettings)[] = [
  'langA', 'langB', 'audioSource', 'audioInputDeviceId', 'echoCancellation',
  'providerId', 'apiKey', 'baseUrl', 'asrModel', 'llmModel', 'glossary', 'vadSensitivity',
];

export function needsSessionRestart(a: AppSettings, b: AppSettings): boolean {
  return SESSION_KEYS.some((k) => a[k] !== b[k]);
}
