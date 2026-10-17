import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ConnectionStatus, SubtitleMessage } from '../types';
import { LiveSession, LiveCallbacks } from '../services/liveSession';
import { acquireAudio, CaptureError, CaptureResult } from '../services/audioCapture';
import { findProvider, buildProviderConfig } from '../services/providers';
import { buildSystemPrompt } from '../services/prompt';
import { AppSettings, DEFAULT_SETTINGS, loadSettings, saveSettings, needsSessionRestart, normalizeSettings } from '../services/settings';
import { isTauriApp, saveTranscript } from '../services/tauri';
import * as bridge from '../services/bridge';

/**
 * 同传引擎 + 状态。
 * 桌面端只在悬浮窗里挂载（音频引擎唯一实例），控制面板用 useRemoteInterpreter 镜像；
 * 浏览器端单页直接用。
 */

/** idle=未开始；listening=在听但没人说话；speaking=检测到人声；processing=识别/翻译中 */
export type Phase = 'idle' | 'listening' | 'speaking' | 'processing';

export interface LiveLine {
  id: string;
  original: string;
  translated: string;
}

export interface InterpreterState {
  status: ConnectionStatus;
  phase: Phase;
  error: string | null;
  /** 错误建议跳到哪个设置 tab */
  errorTab: 'audio' | 'connection' | null;
  warning: string | null;
  live: LiveLine | null;
  level: number;
  sourceLabel: string;
  /** 最后一次有字幕更新的时间，用于悬浮窗自动淡出 */
  lastActivity: number;
}

export interface InterpreterApi {
  ready: boolean;
  state: InterpreterState;
  messages: SubtitleMessage[];
  settings: AppSettings;
  hasApiKey: boolean;
  start: () => void;
  stop: () => void;
  toggle: () => void;
  clear: () => void;
  dismissError: () => void;
  updateSettings: (patch: Partial<AppSettings>) => void;
}

const MAX_MESSAGES = 500;
const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform || navigator.userAgent);

export const INITIAL_STATE: InterpreterState = {
  status: ConnectionStatus.DISCONNECTED,
  phase: 'idle',
  error: null,
  errorTab: null,
  warning: null,
  live: null,
  level: 0,
  sourceLabel: '',
  lastActivity: 0,
};

const envApiKey = (): string => {
  const key = (process.env.SILICONFLOW_API_KEY || process.env.API_KEY || '').trim();
  return /^(your_|sk-x+$|test_key)/i.test(key) ? '' : key;
};

export function effectiveApiKey(s: AppSettings): string {
  return s.apiKey || envApiKey();
}

export function useInterpreter(): InterpreterApi {
  const [ready, setReady] = useState(false);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [state, setState] = useState<InterpreterState>(INITIAL_STATE);
  const [messages, setMessages] = useState<SubtitleMessage[]>([]);

  const settingsRef = useRef(settings);
  const stateRef = useRef(state);
  const sessionRef = useRef<LiveSession | null>(null);
  const captureRef = useRef<CaptureResult | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const startingRef = useRef(false);
  const warnTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const messagesRef = useRef(messages);

  settingsRef.current = settings;
  stateRef.current = state;
  messagesRef.current = messages;

  const patch = useCallback((p: Partial<InterpreterState>) => {
    setState((s) => ({ ...s, ...p }));
  }, []);

  useEffect(() => {
    let alive = true;
    loadSettings().then((s) => {
      if (!alive) return;
      setSettings(s);
      setReady(true);
    });
    return () => { alive = false; };
  }, []);

  const teardown = useCallback(async () => {
    const session = sessionRef.current;
    sessionRef.current = null;
    const cap = captureRef.current;
    captureRef.current = null;
    cap?.stop();
    if (session) await session.disconnect();
  }, []);

  const stop = useCallback(async () => {
    await teardown();
    sessionIdRef.current = null;
    patch({ status: ConnectionStatus.DISCONNECTED, phase: 'idle', live: null, level: 0, sourceLabel: '', warning: null });
  }, [teardown, patch]);

  const fail = useCallback((message: string, tab: 'audio' | 'connection' | null = null) => {
    void teardown();
    patch({ status: ConnectionStatus.ERROR, phase: 'idle', error: message, errorTab: tab, live: null, level: 0, lastActivity: Date.now() });
  }, [teardown, patch]);

  const start = useCallback(async () => {
    if (startingRef.current || sessionRef.current) return;
    startingRef.current = true;
    try {
      const s = settingsRef.current;
      const provider = findProvider(s.providerId);
      const apiKey = effectiveApiKey(s);
      if (!apiKey) {
        fail(`还没有配置 ${provider.displayName} 的 API Key。`, 'connection');
        return;
      }
      const providerConfig = buildProviderConfig(provider, {
        apiKey, baseUrl: s.baseUrl, asrModel: s.asrModel, llmModel: s.llmModel,
      });
      const cfgErr = provider.validateConfig(providerConfig);
      if (cfgErr) {
        fail(`${provider.displayName}：${cfgErr}`, 'connection');
        return;
      }

      patch({ status: ConnectionStatus.CONNECTING, phase: 'idle', error: null, errorTab: null, warning: null });

      const session = new LiveSession({
        provider,
        providerConfig,
        systemInstruction: buildSystemPrompt(s.langA, s.langB, s.glossary),
        vadSensitivity: s.vadSensitivity,
      });
      sessionRef.current = session;
      sessionIdRef.current = `session-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      const isCurrent = () => sessionRef.current === session;
      let heardSomething = false;

      const callbacks: LiveCallbacks = {
        onOpen: () => {
          if (!isCurrent()) return;
          patch({ status: ConnectionStatus.CONNECTED, phase: 'listening', lastActivity: Date.now() });
          // 权限被拒时系统通常给的是"静音流"而不是报错，8 秒都没有声音就提示一下
          setTimeout(() => {
            if (!isCurrent() || heardSomething) return;
            const hint = s.audioSource === 'system'
              ? (isMac
                ? '还没收到电脑声音。请确认正在播放声音；首次使用需在「系统设置 → 隐私与安全性 → 录屏与系统录音」允许本应用。'
                : '还没收到电脑声音。请确认会议 / 视频正在播放声音。')
              : '还没收到麦克风声音。请检查输入设备和系统麦克风权限。';
            patch({ warning: hint });
            if (warnTimerRef.current) clearTimeout(warnTimerRef.current);
            warnTimerRef.current = setTimeout(() => patch({ warning: null }), 10000);
          }, 8000);
        },
        onClose: () => {},
        onError: (err) => {
          if (isCurrent()) fail(err.message || '连接错误', /Key|401|403|404|余额/.test(err.message) ? 'connection' : null);
        },
        onWarning: (msg) => {
          if (!isCurrent()) return;
          patch({ warning: msg });
          if (warnTimerRef.current) clearTimeout(warnTimerRef.current);
          warnTimerRef.current = setTimeout(() => patch({ warning: null }), 5000);
        },
        onSpeechStart: () => {
          if (isCurrent() && stateRef.current.phase !== 'processing') patch({ phase: 'speaking' });
        },
        onSegmentStart: (id) => {
          if (isCurrent()) patch({ phase: 'processing', live: { id, original: '', translated: '' } });
        },
        onTranscript: (id, text) => {
          if (isCurrent()) patch({ live: { id, original: text, translated: '' }, lastActivity: Date.now() });
        },
        onTranslation: (id, text) => {
          if (!isCurrent()) return;
          setState((st) => ({
            ...st,
            live: { id, original: st.live?.id === id ? st.live.original : '', translated: text },
            lastActivity: Date.now(),
          }));
        },
        onTurnComplete: (id, original, translated) => {
          if (!isCurrent()) return;
          const msg: SubtitleMessage = { id, original, translated, isFinal: true, timestamp: Date.now() };
          setMessages((prev) => {
            const next = [...prev, msg];
            return next.length > MAX_MESSAGES ? next.slice(-MAX_MESSAGES) : next;
          });
          setState((st) => ({ ...st, live: st.live?.id === id ? null : st.live, phase: 'listening', lastActivity: Date.now() }));
          const sid = sessionIdRef.current;
          if (isTauriApp() && sid) {
            saveTranscript(sid, original, translated, s.langA, s.langB).catch(() => {});
          }
        },
        onDiscard: (id) => {
          if (!isCurrent()) return;
          setState((st) => ({
            ...st,
            phase: 'listening',
            live: id && st.live?.id === id ? null : st.live,
          }));
        },
        onLevel: (level) => {
          if (level > 0.15) heardSomething = true;
          if (isCurrent()) setState((st) => (Math.abs(st.level - level) < 0.02 ? st : { ...st, level }));
        },
      };

      let capture: CaptureResult;
      try {
        capture = await acquireAudio({
          source: s.audioSource,
          deviceId: s.audioInputDeviceId,
          echoCancellation: s.echoCancellation,
          onPcm: (pcm) => session.feed(pcm),
          onEnded: (reason) => {
            if (isCurrent()) fail(`${reason}，已停止翻译。`, 'audio');
          },
        });
      } catch (err) {
        if (isCurrent()) {
          const tab = err instanceof CaptureError ? err.settingsTab ?? 'audio' : 'audio';
          fail(err instanceof Error ? err.message : '音频采集失败', tab);
        }
        return;
      }
      if (!isCurrent()) {
        capture.stop();
        return;
      }
      captureRef.current = capture;
      patch({ sourceLabel: capture.label });

      if (capture.kind === 'stream') {
        await session.attachStream(callbacks, capture.stream);
      } else {
        session.attachPcm(callbacks, capture.sampleRate);
      }
    } finally {
      startingRef.current = false;
    }
  }, [fail, patch]);

  const toggle = useCallback(() => {
    const st = stateRef.current.status;
    if (st === ConnectionStatus.CONNECTED || st === ConnectionStatus.CONNECTING) void stop();
    else void start();
  }, [start, stop]);

  const clear = useCallback(() => {
    setMessages([]);
    patch({ live: null });
  }, [patch]);

  const dismissError = useCallback(() => {
    patch({ error: null, errorTab: null, status: stateRef.current.status === ConnectionStatus.ERROR ? ConnectionStatus.DISCONNECTED : stateRef.current.status });
  }, [patch]);

  const applySettings = useCallback((next: AppSettings, persist: boolean) => {
    const prev = settingsRef.current;
    settingsRef.current = next;
    setSettings(next);
    if (persist) void saveSettings(next, prev);
    // 正在翻译时改了会影响会话的设置：无缝重启
    const st = stateRef.current.status;
    if ((st === ConnectionStatus.CONNECTED || st === ConnectionStatus.CONNECTING) && needsSessionRestart(prev, next)) {
      void (async () => {
        await teardown();
        await start();
      })();
    }
  }, [start, teardown]);

  const updateSettings = useCallback((p: Partial<AppSettings>) => {
    const next = normalizeSettings({ ...settingsRef.current, ...p });
    applySettings(next, true);
    void bridge.emit(bridge.EV_SETTINGS, next);
  }, [applySettings]);

  // ── 桌面端：作为状态源，向控制面板广播 ───────────────────────────
  // 电平变化太频繁，不单独触发广播
  useEffect(() => {
    if (!isTauriApp()) return;
    void bridge.emit(bridge.EV_STATE, stateRef.current);
  }, [state.status, state.phase, state.error, state.warning, state.live, state.sourceLabel]);
  useEffect(() => {
    if (!isTauriApp()) return;
    void bridge.emit(bridge.EV_MESSAGES, messages);
  }, [messages]);

  useEffect(() => {
    if (!isTauriApp()) return;
    const offCmd = bridge.listen<bridge.BridgeCommand>(bridge.EV_COMMAND, (cmd) => {
      switch (cmd.type) {
        case 'start': void start(); break;
        case 'stop': void stop(); break;
        case 'toggle': toggle(); break;
        case 'clear': clear(); break;
        case 'dismiss-error': dismissError(); break;
        case 'sync':
          void bridge.emit(bridge.EV_STATE, stateRef.current);
          void bridge.emit(bridge.EV_MESSAGES, messagesRef.current);
          break;
      }
    });
    // 面板保存了设置（已落库），这里只应用不重复写
    const offSettings = bridge.listen<AppSettings>(bridge.EV_SETTINGS, (s) => {
      const next = normalizeSettings(s);
      if (JSON.stringify(next) !== JSON.stringify(settingsRef.current)) applySettings(next, false);
    });
    const offShortcut = bridge.listen('global-shortcut-record', () => toggle());
    return () => { offCmd(); offSettings(); offShortcut(); };
  }, [start, stop, toggle, clear, dismissError, applySettings]);

  useEffect(() => () => { void teardown(); }, [teardown]);

  const hasApiKey = Boolean(effectiveApiKey(settings));

  return useMemo(() => ({
    ready, state, messages, settings, hasApiKey,
    start: () => void start(),
    stop: () => void stop(),
    toggle, clear, dismissError, updateSettings,
  }), [ready, state, messages, settings, hasApiKey, start, stop, toggle, clear, dismissError, updateSettings]);
}
