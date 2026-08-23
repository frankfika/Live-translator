
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { AudioSource, ConnectionStatus, SubtitleMessage } from './types';
import { LiveSession, LiveCallbacks } from './services/liveSession';
import { buildMicrophoneConstraints, formatMediaError } from './services/mediaDevices';
import { findProvider, buildProviderConfig, PROVIDERS } from './services/providers';
import type { Provider } from './services/providers';
import AudioVisualizer from './components/AudioVisualizer';
import SubtitleCard from './components/SubtitleCard';
import LanguageSettings from './components/LanguageSettings';
import {
  isTauriApp,
  getSetting,
  setSetting,
  saveTranscript
} from './services/tauri';

// macOS WKWebView 不支持 getDisplayMedia → 系统音频模式必然失败
// 在 UI 上分支引导用户用虚拟声卡;这里再防一道,即使用户在设置里选了「系统音频」,
// 真正启动时也直接给错误而不是去 getDisplayMedia 撞壁
const IS_MAC = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform || navigator.userAgent);

// Tauri event API
let tauriEmit: ((event: string, payload: any) => Promise<void>) | null = null;
let tauriListen: ((event: string, handler: (event: any) => void) => Promise<() => void>) | null = null;
let tauriEventReady: Promise<void> | null = null;

if (isTauriApp()) {
  // Pre-load the Tauri event API at module init so global-shortcut listeners
  // don't race the dynamic import. Without this, the mount-time useEffect can
  // run before the import resolves and silently fail to wire up Cmd+Shift+S/R.
  tauriEventReady = import('@tauri-apps/api/event').then(({ emit, listen }) => {
    tauriEmit = emit;
    tauriListen = listen;
  });
}

/** Distinct UI phases within an active session */
type ProcessingPhase = 'idle' | 'recording' | 'processing';

const MAX_MESSAGES = 200; // Guard against unbounded memory on long sessions

// Helper: wrap a promise with a timeout
type PromiseValue<T> = T extends Promise<infer V> ? V : never;
const withTimeout = <T extends Promise<any>>(promise: T, timeoutMs: number, msg: string): Promise<PromiseValue<T>> => {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(msg)), timeoutMs)
    )
  ]) as Promise<PromiseValue<T>>;
};

const PLACEHOLDERS = new Set([
  'your_siliconflow_api_key_here',
  'your_api_key_here',
  'test_key_placeholder',
  'sk-xxxxxxxxxxxxxxxxxxxxxxxx',
  '',
]);

const getConfiguredApiKey = () => {
  const key = process.env.SILICONFLOW_API_KEY || process.env.API_KEY || process.env.DASHSCOPE_API_KEY || process.env.ZHIPU_API_KEY || '';
  return PLACEHOLDERS.has(key.trim().toLowerCase()) ? '' : key;
};

const App: React.FC = () => {
  const [status, setStatus] = useState<ConnectionStatus>(ConnectionStatus.DISCONNECTED);
  const [messages, setMessages] = useState<SubtitleMessage[]>([]);
  const [currentOriginal, setCurrentOriginal] = useState('');
  const [currentTranslated, setCurrentTranslated] = useState('');
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [phase, setPhase] = useState<ProcessingPhase>('idle');

  const [langA, setLangA] = useState('English');
  const [langB, setLangB] = useState('Chinese');
  const [audioSource, setAudioSource] = useState<AudioSource>('microphone');
  const [audioInputDeviceId, setAudioInputDeviceId] = useState('');
  // 回声消除/降噪/自动增益总开关 — 默认开,会议场景防回声
  // 单一变量同时控制三项,UI 上是一个开关,简单一致
  const [echoCancellation, setEchoCancellation] = useState(true);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isUpdatingLanguage, setIsUpdatingLanguage] = useState(false);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [providerId, setProviderId] = useState('siliconflow');
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [asrModel, setAsrModel] = useState('');
  const [llmModel, setLlmModel] = useState('');

  const currentOriginalRef = useRef('');
  const currentTranslatedRef = useRef('');
  const liveClientRef = useRef<LiveSession | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const activeStreamSourceRef = useRef<AudioSource | null>(null);
  const activeDeviceIdRef = useRef<string>('');
  const bottomRef = useRef<HTMLDivElement>(null);
  // Track scroll position so we only auto-scroll when user is near the bottom
  const mainRef = useRef<HTMLDivElement>(null);
  // status ref → 键盘 listener / 全局快捷键回调用,避免闭包陷阱
  // 之前 listener 用 useState.status 闭包,HMR / 多次 mount 会拿旧值
  const statusRef = useRef<ConnectionStatus>(ConnectionStatus.DISCONNECTED);
  // 错误条: 持久化定时器 ID,hover 时暂停,leave 时重启,关闭时清掉
  const errorDismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 错误条: 用户手动点了 keep-open 之后不再自动消失
  const errorPinnedRef = useRef(false);

  // Auto-scroll only when user is near the bottom (within 150px)
  useEffect(() => {
    const el = mainRef.current;
    if (!el) return;
    const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 150;
    if (isNearBottom && bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
  }, [messages, currentOriginal, currentTranslated]);

  // Load settings from Tauri or localStorage on mount
  useEffect(() => {
    const loadSettings = async () => {
      if (isTauriApp()) {
        // Wait for the dynamic import of the Tauri event API so global-shortcut
        // listeners don't race the import and silently no-op.
        if (tauriEventReady) await tauriEventReady;

        // Load from Tauri store
        const savedLangA = await getSetting('langA');
        const savedLangB = await getSetting('langB');
        const savedAudioSource = await getSetting('audioSource');
        const savedDeviceId = await getSetting('audioInputDeviceId');
        const savedApiKey = await getSetting('apiKey');
        const savedProviderId = await getSetting('providerId');
        const savedBaseUrl = await getSetting('baseUrl');
        const savedAsrModel = await getSetting('asrModel');
        const savedLlmModel = await getSetting('llmModel');
        const savedEchoCancellation = await getSetting('echoCancellation');

        if (savedLangA) setLangA(savedLangA);
        if (savedLangB) setLangB(savedLangB);
        if (savedAudioSource) setAudioSource(savedAudioSource as AudioSource);
        if (savedDeviceId) setAudioInputDeviceId(savedDeviceId);
        if (savedApiKey !== null) setApiKey(savedApiKey);
        if (savedProviderId) setProviderId(savedProviderId);
        if (savedBaseUrl) setBaseUrl(savedBaseUrl);
        if (savedAsrModel) setAsrModel(savedAsrModel);
        if (savedLlmModel) setLlmModel(savedLlmModel);
        if (savedEchoCancellation !== null) setEchoCancellation(savedEchoCancellation === 'true');

        // 监听全局快捷键事件
        if (tauriListen) {
          // 读 statusRef 而不是闭包里的 status,避免 mount 时 capture stale 值
          // (Vite HMR / 多次 mount 会让旧 listener 拿旧 DISCONNECTED,导致
          // 录音中按 R 误判走 start,产生两个并发 session)
          const unlistenPromise = tauriListen('global-shortcut-record', () => {
            const currentStatus = statusRef.current;
            if (currentStatus === ConnectionStatus.CONNECTED) {
              void handleStop();
            } else if (currentStatus === ConnectionStatus.DISCONNECTED || currentStatus === ConnectionStatus.ERROR) {
              void handleStart();
            }
          });
          // keep the unlisten alive — 之前被丢弃, HMR 后会重复注册导致 R 按一次触发 N 次
          unlistenPromise.catch(() => { /* Tauri not available in web mode */ });
        }
      } else {
        // Fallback to localStorage for web version
        const savedLangA = localStorage.getItem('interp_langA');
        const savedLangB = localStorage.getItem('interp_langB');
        const savedAudioSource = localStorage.getItem('interp_audioSource');
        const savedDeviceId = localStorage.getItem('interp_audioInputDeviceId');
        const savedApiKey = localStorage.getItem('interp_apiKey');
        const savedProviderId = localStorage.getItem('interp_providerId');
        const savedBaseUrl = localStorage.getItem('interp_baseUrl');
        const savedAsrModel = localStorage.getItem('interp_asrModel');
        const savedLlmModel = localStorage.getItem('interp_llmModel');
        const savedEchoCancellation = localStorage.getItem('interp_echoCancellation');

        if (savedLangA) setLangA(savedLangA);
        if (savedLangB) setLangB(savedLangB);
        if (savedAudioSource) setAudioSource(savedAudioSource as AudioSource);
        if (savedDeviceId) setAudioInputDeviceId(savedDeviceId);
        if (savedApiKey !== null) setApiKey(savedApiKey);
        if (savedProviderId) setProviderId(savedProviderId);
        if (savedBaseUrl) setBaseUrl(savedBaseUrl);
        if (savedAsrModel) setAsrModel(savedAsrModel);
        if (savedLlmModel) setLlmModel(savedLlmModel);
        if (savedEchoCancellation !== null) setEchoCancellation(savedEchoCancellation === 'true');
      }
    };

    loadSettings();
  }, []);

  // Persist settings to Tauri or localStorage
  useEffect(() => {
    if (isTauriApp()) {
      setSetting('langA', langA);
    } else {
      localStorage.setItem('interp_langA', langA);
    }
  }, [langA]);

  useEffect(() => {
    if (isTauriApp()) {
      setSetting('langB', langB);
    } else {
      localStorage.setItem('interp_langB', langB);
    }
  }, [langB]);

  useEffect(() => {
    if (isTauriApp()) {
      setSetting('audioSource', audioSource);
    } else {
      localStorage.setItem('interp_audioSource', audioSource);
    }
  }, [audioSource]);

  useEffect(() => {
    if (isTauriApp()) {
      setSetting('audioInputDeviceId', audioInputDeviceId);
    } else {
      localStorage.setItem('interp_audioInputDeviceId', audioInputDeviceId);
    }
  }, [audioInputDeviceId]);

  useEffect(() => {
    if (isTauriApp()) {
      setSetting('echoCancellation', String(echoCancellation));
    } else {
      localStorage.setItem('interp_echoCancellation', String(echoCancellation));
    }
  }, [echoCancellation]);

  useEffect(() => {
    if (isTauriApp()) {
      setSetting('providerId', providerId);
    } else {
      localStorage.setItem('interp_providerId', providerId);
    }
  }, [providerId]);

  useEffect(() => {
    if (isTauriApp()) {
      setSetting('baseUrl', baseUrl);
    } else {
      localStorage.setItem('interp_baseUrl', baseUrl);
    }
  }, [baseUrl]);

  useEffect(() => {
    if (isTauriApp()) {
      setSetting('asrModel', asrModel);
    } else {
      localStorage.setItem('interp_asrModel', asrModel);
    }
  }, [asrModel]);

  useEffect(() => {
    if (isTauriApp()) {
      setSetting('llmModel', llmModel);
    } else {
      localStorage.setItem('interp_llmModel', llmModel);
    }
  }, [llmModel]);

  // Sync status state → statusRef, 给 listener / 全局快捷键用最新值
  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  // 错误条: 25s 自动消失(比之前 10s 长), hover 暂停, 留 keep-open 按钮
  // 之前 10s 太短,401 / 断网这种持续类错误用户根本没时间读完
  useEffect(() => {
    if (!errorMessage) {
      errorPinnedRef.current = false;
      if (errorDismissTimerRef.current) {
        clearTimeout(errorDismissTimerRef.current);
        errorDismissTimerRef.current = null;
      }
      return;
    }
    if (errorPinnedRef.current) return; // 用户 keep-open 后不自动消失

    errorDismissTimerRef.current = setTimeout(() => {
      setErrorMessage(null);
      errorDismissTimerRef.current = null;
    }, 25000);

    return () => {
      if (errorDismissTimerRef.current) {
        clearTimeout(errorDismissTimerRef.current);
        errorDismissTimerRef.current = null;
      }
    };
  }, [errorMessage]);

  // 错误条 hover 暂停自动消失
  const pauseErrorAutoDismiss = () => {
    if (errorDismissTimerRef.current) {
      clearTimeout(errorDismissTimerRef.current);
      errorDismissTimerRef.current = null;
    }
  };
  const resumeErrorAutoDismiss = () => {
    if (!errorMessage || errorPinnedRef.current) return;
    errorDismissTimerRef.current = setTimeout(() => {
      setErrorMessage(null);
      errorDismissTimerRef.current = null;
    }, 25000);
  };
  const pinError = () => {
    errorPinnedRef.current = true;
    pauseErrorAutoDismiss();
  };
  const unpinError = () => {
    errorPinnedRef.current = false;
    resumeErrorAutoDismiss();
  };

  // Sync current subtitle to subtitle window
  useEffect(() => {
    if (isTauriApp() && tauriEmit) {
      const subtitleText = currentTranslated || currentOriginal || '';
      tauriEmit('subtitle-update', subtitleText);
    }
  }, [currentOriginal, currentTranslated]);

  // Global keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't trigger when typing in inputs
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      // Settings modal 打开时, Space / S / E 都不要从背后触发
      // (之前 modal 焦点在 DIV 上按 S 触发重新开 modal,按 E 触发空文件导出)
      if (isSettingsOpen && e.key !== 'Escape') return;

      if (e.code === 'Space') {
        e.preventDefault();
        if (status === ConnectionStatus.CONNECTED) {
          void handleStop();
        } else if (status === ConnectionStatus.DISCONNECTED || status === ConnectionStatus.ERROR) {
          void handleStart();
        }
      } else if (e.key === 's' || e.key === 'S') {
        if (!e.ctrlKey && !e.metaKey) {
          setIsSettingsOpen(true);
        }
      } else if (e.key === 'e' || e.key === 'E') {
        if (!e.ctrlKey && !e.metaKey) {
          handleExportTranscript();
        }
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [status, isSettingsOpen]);

  const resetBuffers = useCallback(() => {
    currentOriginalRef.current = '';
    currentTranslatedRef.current = '';
    setCurrentOriginal('');
    setCurrentTranslated('');
  }, []);

  const hasApiKey = Boolean(apiKey || getConfiguredApiKey());

  const startLiveSession = async (
    activeLangA: string,
    activeLangB: string,
    activeAudioSource: AudioSource,
    activeAudioInputDeviceId: string,
    activeProviderId: string,
    activeApiKey: string,
    activeBaseUrl: string,
    activeAsrModel: string,
    activeLlmModel: string,
    activeEchoCancellation: boolean,
  ) => {
    setErrorMessage(null);
    const provider = findProvider(activeProviderId);
    const effectiveApiKey = activeApiKey || getConfiguredApiKey();
    if (!effectiveApiKey) {
        setErrorMessage(`未检测到可用 API Key。\n请在设置面板中配置 ${provider.displayName} 的 API Key。\n获取地址: ${provider.keyUrl || '请查看 provider 文档'}`);
        setStatus(ConnectionStatus.ERROR);
        return;
    }

    setStatus(ConnectionStatus.CONNECTING);
    setPhase('idle');

    const providerConfig = buildProviderConfig(provider, {
      apiKey: effectiveApiKey,
      baseUrl: activeBaseUrl,
      asrModel: activeAsrModel,
      llmModel: activeLlmModel,
    });

    const client = new LiveSession(provider, providerConfig);
    liveClientRef.current = client;

    let mediaStream: MediaStream | undefined;

    if (
      mediaStreamRef.current &&
      mediaStreamRef.current.active &&
      activeStreamSourceRef.current === activeAudioSource &&
      (activeAudioSource === 'system' || activeDeviceIdRef.current === activeAudioInputDeviceId)
    ) {
        mediaStream = mediaStreamRef.current;
    } else {
        if (mediaStreamRef.current) {
            mediaStreamRef.current.getTracks().forEach(t => t.stop());
            mediaStreamRef.current = null;
        }

        if (activeAudioSource === 'system') {
            // macOS WKWebView 不支持 getDisplayMedia — 直接给友好错误,
            // 让用户去设置里按引导装 BlackHole,而不是去撞屏幕共享弹窗的壁
            if (IS_MAC) {
              setStatus(ConnectionStatus.ERROR);
              setErrorMessage(
                'macOS 不支持直接抓取系统音频,请到「设置 → 音频」按引导使用虚拟声卡(BlackHole)。\n' +
                '简要步骤:① 安装 BlackHole;② 「系统设置 → 声音」输出选 BlackHole;③ 会议软件音频输出也切到 BlackHole;④ 回到本应用切到「麦克风 / 虚拟声卡」并选 BlackHole 作为输入。'
              );
              return;
            }
            try {
                mediaStream = await withTimeout(
                    navigator.mediaDevices.getDisplayMedia({
                        video: true,
                        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
                    }),
                    15000,
                    '系统音频获取超时。请在15秒内完成屏幕共享选择。'
                );

                if (mediaStream.getAudioTracks().length === 0) {
                    mediaStream.getTracks().forEach(t => t.stop());
                    throw new Error("未检测到音频轨道。\n请在弹窗中勾选「共享系统音频」。");
                }

                mediaStream.getVideoTracks().forEach(track => track.stop());
                mediaStream.getAudioTracks()[0].onended = () => handleStop();

            } catch (err) {
                setStatus(ConnectionStatus.ERROR);
                setErrorMessage(err instanceof Error ? err.message : "系统音频捕获失败");
                return;
            }
        } else {
            try {
                // 单一开关同时控制 echoCancellation / noiseSuppression / autoGainControl,
                // 简单一致 — UI 上是一个「回声消除 / 降噪 / 自动增益」开关
                mediaStream = await withTimeout(
                    navigator.mediaDevices.getUserMedia({
                      audio: buildMicrophoneConstraints(activeAudioInputDeviceId, {
                        echoCancellation: activeEchoCancellation,
                        noiseSuppression: activeEchoCancellation,
                        autoGainControl: activeEchoCancellation,
                      }),
                    }),
                    10000,
                    '麦克风权限获取超时。请在10秒内允许权限或检查浏览器设置。'
                );

                // 监听 track ended: 用户在系统里改了默认输入、或拔了外接麦
                // 时这个会触发。如果用户在录音中拔麦，给出明确提示而不是静默
                // 黑屏继续"录"静音。
                mediaStream.getAudioTracks().forEach((track) => {
                  track.onended = () => {
                    if (liveClientRef.current) {
                      setErrorMessage('音频设备断开连接（可能已被拔出或被其他应用抢占）。已自动停止翻译。');
                      void handleStop();
                    }
                  };
                });
            } catch (err) {
                setStatus(ConnectionStatus.ERROR);
                setErrorMessage(formatMediaError(err, '麦克风访问失败'));
                return;
            }
        }

        mediaStreamRef.current = mediaStream;
        activeStreamSourceRef.current = activeAudioSource;
        activeDeviceIdRef.current = activeAudioSource === 'microphone' ? activeAudioInputDeviceId : '';
    }

    const systemInstruction = `
You are a senior conference simultaneous interpreter with 20 years of experience. Your task is to provide real-time, natural-sounding oral interpretation between ${activeLangA} and ${activeLangB}.

## Core Rules
1. Direction: If input is ${activeLangA} → output ${activeLangB}; if input is ${activeLangB} → output ${activeLangA}.
2. Output ONLY the translated text. No explanations, no quotes, no prefixes like "Translation:" or "译文:".
3. If input is meaningless noise, coughing, or filler words → output exactly: [SKIP]

## Translation Quality Standards
- **Oral fluency**: Produce natural spoken language, not written text. Use colloquial expressions where appropriate.
- **Ellipsis recovery**: Spoken language often drops subjects or objects. Infer and restore them from context.
  Example: "叫什么名字？" → "What's your name?" (restore dropped subject)
- **Tone preservation**: Maintain the speaker's emotion, urgency, politeness level, and emphasis.
- **Proper nouns**: Keep names, brands, and places in their standard translated form. Do not transliterate unless it's the accepted convention.
- **Numbers & dates**: Convert formats accurately (e.g., Chinese "三万" → "30,000"; US dates MM/DD → localized format).
- **Idioms & slang**: Use equivalent expressions in the target language, NOT literal word-for-word translation.
  Example: "画蛇添足" → "to gild the lily" (NOT "draw a snake and add feet")
- **Culture-specific terms**: Localize concepts that don't exist in the target culture.
  Example: "红包" → "red envelope / cash gift" depending on context

## Examples (English ↔ Chinese)
Input: Hello, how are you doing today?
Output: 你好，今天过得怎么样？

Input: 这个方案成本有点高，能不能再优化一下？
Output: This proposal is a bit costly. Is there any room for optimization?

Input: Let's wrap this up and move on to the next item.
Output: 咱们先结束这个话题，进入下一项议程。

Input: 说白了，他就是想拖延时间。
Output: To put it bluntly, he's just trying to buy time.

Now translate the user's spoken input. Output ONLY the interpretation.
    `.trim();

    const callbacks: LiveCallbacks = {
        onOpen: () => {
          if (liveClientRef.current === client) {
            setStatus(ConnectionStatus.CONNECTED);
            setStream(client.getStream());
            setIsUpdatingLanguage(false);
            setPhase('idle');
          }
        },
        onClose: () => {
          if (liveClientRef.current === client) {
            setStatus(ConnectionStatus.DISCONNECTED);
            setStream(null);
            setPhase('idle');
            resetBuffers();
          }
        },
        onError: (err) => {
          if (liveClientRef.current === client) {
            console.error(err);
            setStatus(ConnectionStatus.ERROR);
            setErrorMessage(err.message || "连接错误，请检查网络或 API Key。");
            setStream(null);
            setPhase('idle');
            resetBuffers();
            setIsUpdatingLanguage(false);
          }
        },
        // VAD detected speech — show recording indicator immediately
        onVADSpeechStart: () => {
          if (liveClientRef.current === client) setPhase('recording');
        },
        // VAD detected silence end — switch to processing indicator
        onVADSpeechEnd: () => {
          if (liveClientRef.current === client) setPhase('processing');
        },
        onInputTranscription: (text) => {
           if (liveClientRef.current === client) {
              currentOriginalRef.current = text;
              setCurrentOriginal(text);
           }
        },
        onOutputTranscription: (text) => {
           if (liveClientRef.current === client) {
              currentTranslatedRef.current += text;
              setCurrentTranslated(currentTranslatedRef.current);
           }
        },
        onTurnComplete: () => {
           if (liveClientRef.current === client) {
              setPhase('idle');
              const originalText = currentOriginalRef.current;
              const translatedText = currentTranslatedRef.current.trim();

              if (translatedText === '[SKIP]' || translatedText === '') {
                resetBuffers();
                return;
              }

              const cleanOriginal = originalText.trim();
              if (cleanOriginal || translatedText) {
                const newMessage = {
                  id: Date.now().toString(),
                  original: cleanOriginal,
                  translated: translatedText,
                  isFinal: true,
                  timestamp: Date.now()
                };

                setMessages(prev => {
                  const next = [...prev, newMessage];
                  // Keep last MAX_MESSAGES to avoid memory growth
                  return next.length > MAX_MESSAGES ? next.slice(-MAX_MESSAGES) : next;
                });

                // Save to database if in Tauri app and session is active
                if (isTauriApp() && currentSessionId) {
                  saveTranscript(
                    currentSessionId,
                    cleanOriginal,
                    translatedText,
                    activeLangA,
                    activeLangB
                  ).catch(err => {
                    console.error('Failed to save transcript:', err);
                  });
                }
              }
              resetBuffers();
           }
        },
        onAudioData: () => {}
    };

    await client.connect(callbacks, mediaStream);
  };

  const handleStart = () => {
    // Generate new session ID when starting
    const sessionId = `session-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    setCurrentSessionId(sessionId);
    startLiveSession(langA, langB, audioSource, audioInputDeviceId, providerId, apiKey, baseUrl, asrModel, llmModel, echoCancellation);
  };

  const handleSettingsUpdate = async (
    newLangA: string,
    newLangB: string,
    newAudioSource: AudioSource,
    newAudioInputDeviceId: string,
    newProviderId: string,
    newApiKey: string,
    newBaseUrl: string,
    newAsrModel: string,
    newLlmModel: string,
    newEchoCancellation: boolean,
  ) => {
    const providerChanged = newProviderId !== providerId;
    if (
      newLangA === langA &&
      newLangB === langB &&
      newAudioSource === audioSource &&
      newAudioInputDeviceId === audioInputDeviceId &&
      !providerChanged &&
      newApiKey === apiKey &&
      newBaseUrl === baseUrl &&
      newAsrModel === asrModel &&
      newLlmModel === llmModel &&
      newEchoCancellation === echoCancellation
    ) return;

    setApiKey(newApiKey);

    setLangA(newLangA);
    setLangB(newLangB);
    setAudioSource(newAudioSource);
    setAudioInputDeviceId(newAudioInputDeviceId);
    setProviderId(newProviderId);
    setApiKey(newApiKey);
    setBaseUrl(newBaseUrl);
    setAsrModel(newAsrModel);
    setLlmModel(newLlmModel);
    setEchoCancellation(newEchoCancellation);
    // ⚠️ 不要在这里 setMessages([]) + resetBuffers()
    // 之前切个目标语言就清空整段对话, 用户积累的上下文瞬间没掉
    // 现在只清错误条 — 历史消息保留, 用户想清时点 "清空记录" 按钮

    setErrorMessage(null);

    // Persist API key + provider config + audio tuning
    if (isTauriApp()) {
      setSetting('apiKey', newApiKey);
      setSetting('providerId', newProviderId);
      setSetting('baseUrl', newBaseUrl);
      setSetting('asrModel', newAsrModel);
      setSetting('llmModel', newLlmModel);
      setSetting('echoCancellation', String(newEchoCancellation));
    } else {
      localStorage.setItem('interp_apiKey', newApiKey);
      localStorage.setItem('interp_providerId', newProviderId);
      localStorage.setItem('interp_baseUrl', newBaseUrl);
      localStorage.setItem('interp_asrModel', newAsrModel);
      localStorage.setItem('interp_llmModel', newLlmModel);
      localStorage.setItem('interp_echoCancellation', String(newEchoCancellation));
    }

    if (status === ConnectionStatus.CONNECTED || status === ConnectionStatus.CONNECTING) {
      setIsUpdatingLanguage(true);
      setPhase('idle');

      const oldClient = liveClientRef.current;
      liveClientRef.current = null;

      if (oldClient) {
         try { await oldClient.disconnect(); } catch (e) { console.error(e); }
      }

      // 之前的 500ms sleep 没必要 — disconnect 已经 await 完成
      // 直接 start 新 session
      await startLiveSession(newLangA, newLangB, newAudioSource, newAudioInputDeviceId, newProviderId, newApiKey, newBaseUrl, newAsrModel, newLlmModel, newEchoCancellation);
    }
  };

  // 快速切换目标语言(从 LLM 检出语言点 "切换 →") — 只换 langB,保留历史消息
  // 之前走 handleSettingsUpdate 会 setMessages([]) + 整段历史被擦掉
  const handleQuickSwitch = async (detectedLang: string) => {
    if (detectedLang === langB) return; // 已经是这个语言,no-op
    setLangB(detectedLang);
    setErrorMessage(null);
    if (isTauriApp()) {
      void setSetting('langB', detectedLang);
    } else {
      localStorage.setItem('interp_langB', detectedLang);
    }
    // 录音中需要重启 session 因为 systemInstruction 依赖 langA/langB 方向
    if (status === ConnectionStatus.CONNECTED || status === ConnectionStatus.CONNECTING) {
      setIsUpdatingLanguage(true);
      setPhase('idle');
      const oldClient = liveClientRef.current;
      liveClientRef.current = null;
      if (oldClient) {
        try { await oldClient.disconnect(); } catch (e) { console.error(e); }
      }
      await startLiveSession(langA, detectedLang, audioSource, audioInputDeviceId, providerId, apiKey, baseUrl, asrModel, llmModel, echoCancellation);
    }
  };

  const handleStop = async () => {
    if (liveClientRef.current) {
      await liveClientRef.current.disconnect();
      liveClientRef.current = null;
    }
    if (mediaStreamRef.current) {
        mediaStreamRef.current.getTracks().forEach(t => t.stop());
        mediaStreamRef.current = null;
    }
    activeStreamSourceRef.current = null;
    activeDeviceIdRef.current = '';
    setStatus(ConnectionStatus.DISCONNECTED);
    setPhase('idle');
    setCurrentSessionId(null); // Clear session ID
    resetBuffers();
    setErrorMessage(null); // 之前 handleStop 不清 errorMessage,导致停止后错误条叠加显示
  };

  // 用户主动点 "清空记录" — 真清, 同时停掉正在跑的 live session
  // 之前只 setMessages([]) 但 liveClient 还在跑, 后台继续录音 + 调模型
  const handleReset = () => {
    if (liveClientRef.current) {
      void liveClientRef.current.disconnect();
      liveClientRef.current = null;
    }
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach(t => t.stop());
      mediaStreamRef.current = null;
    }
    activeStreamSourceRef.current = null;
    activeDeviceIdRef.current = '';
    setStatus(ConnectionStatus.DISCONNECTED);
    setMessages([]);
    resetBuffers();
    setErrorMessage(null);
    setPhase('idle');
    setCurrentSessionId(null);
  };

  const handleExportTranscript = () => {
    if (messages.length === 0) return;

    const lines = messages.map(msg => {
      const time = new Date(msg.timestamp).toLocaleTimeString();
      const parts = [`[${time}]`];
      if (msg.original) parts.push(`原文: ${msg.original}`);
      if (msg.translated) parts.push(`译文: ${msg.translated}`);
      return parts.join('\n');
    });

    const content = `AI 同声传译记录 (${langA} / ${langB})\n日期: ${new Date().toLocaleString()}\n${'='.repeat(50)}\n\n${lines.join('\n\n')}`;
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `transcript-${new Date().toISOString().slice(0, 10)}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // ── Status indicator helpers ─────────────────────────────────────────────
  const statusInfo = (() => {
    if (status === ConnectionStatus.CONNECTED) {
      if (phase === 'recording') return { dot: 'bg-blue-400', ring: 'ring-blue-400/30', label: '录音中', color: 'text-blue-300', showRipple: true };
      if (phase === 'processing') return { dot: 'bg-yellow-400', ring: 'ring-yellow-400/30', label: '翻译中', color: 'text-yellow-300', showRipple: false, pulse: true };
      return { dot: 'bg-emerald-500', ring: 'ring-emerald-500/30', label: '已就绪', color: 'text-emerald-300', softPulse: true };
    }
    if (status === ConnectionStatus.CONNECTING) return { dot: 'bg-yellow-500', ring: 'ring-yellow-500/30', label: '连接中', color: 'text-yellow-300', pulse: true };
    if (status === ConnectionStatus.ERROR) return { dot: 'bg-red-500', ring: 'ring-red-500/30', label: '错误', color: 'text-red-300' };
    return { dot: 'bg-gray-500', ring: 'ring-gray-700', label: '未连接', color: 'text-gray-400' };
  })();

  // 打开设置面板并跳到指定 tab（通过 URL hash 通信）
  const openSettingsToConnection = useCallback(() => {
    window.location.hash = '#tab=connection';
    setIsSettingsOpen(true);
  }, []);
  const openSettingsToAudio = useCallback(() => {
    window.location.hash = '#tab=audio';
    setIsSettingsOpen(true);
  }, []);

  return (
    <div className="fixed inset-0 flex flex-col bg-gray-950 text-white overflow-hidden">
      {/* 背景渐变光晕 - 增加视觉深度 */}
      <div className="pointer-events-none absolute inset-0 z-0">
        <div className="absolute -top-32 -left-32 h-96 w-96 rounded-full bg-blue-600/10 blur-3xl" />
        <div className="absolute -bottom-32 -right-32 h-96 w-96 rounded-full bg-purple-600/10 blur-3xl" />
      </div>

      {/* ============ Header ============ */}
      <header className="relative flex-none z-50 px-3 md:px-5 py-3 md:py-3.5 flex justify-between items-center glass-panel border-b border-gray-800/80 shadow-xl">
        <div className="flex items-center gap-2.5 md:gap-3 min-w-0">
            {/* 状态指示 - 增强可见性 */}
            <div className="relative flex items-center justify-center w-6 h-6 flex-none">
              <div className={`absolute inset-0 rounded-full ring-2 ${statusInfo.ring}`} />
              <div className={`w-2.5 h-2.5 rounded-full transition-all duration-300 ${statusInfo.dot} ${statusInfo.pulse ? 'animate-pulse' : ''} ${statusInfo.softPulse ? 'soft-pulse' : ''}`} />
              {statusInfo.showRipple && (
                <div className={`absolute w-2.5 h-2.5 rounded-full ${statusInfo.dot} pulse-ring`} />
              )}
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h1 className="text-sm md:text-lg font-bold shimmer-text tracking-tight">
                    AI 同声传译
                </h1>
                <span className={`text-[10px] md:text-xs font-semibold px-1.5 py-0.5 rounded-md bg-gray-900/60 border border-gray-700/50 ${statusInfo.color}`}>
                  {statusInfo.label}
                </span>
              </div>
              <p className="text-[10px] md:text-xs text-gray-500 font-medium tracking-tight truncate">
                {langA} ⇄ {langB}
              </p>
            </div>
        </div>

        <div className="flex items-center gap-0.5 md:gap-1.5 flex-none">
             {messages.length > 0 && (
               <button onClick={handleExportTranscript} aria-label="导出会议记录" title="导出会议记录 (E)" className="focus-ring p-2 rounded-lg text-gray-400 hover:text-white hover:bg-gray-800 active:scale-90 transition-all">
                  <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
               </button>
             )}
             <button onClick={() => setIsSettingsOpen(true)} aria-label="会话设置" title="会话设置 (S)" className="focus-ring p-2 rounded-lg text-gray-400 hover:text-white hover:bg-gray-800 active:scale-90 transition-all">
                <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.09a2 2 0 0 1-1-1.74v-.47a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.39a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"></path><circle cx="12" cy="12" r="3"></circle></svg>
             </button>
             {messages.length > 0 && (
               <button onClick={handleReset} aria-label="清空记录" title="清空记录" className="focus-ring p-2 rounded-lg text-gray-400 hover:text-white hover:bg-gray-800 active:scale-90 transition-all">
                  <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>
               </button>
             )}
             <div className="h-5 w-px bg-gray-700 mx-1 hidden md:block"></div>
             {/* 主行动按钮 - 根据状态变样式 */}
             {status === ConnectionStatus.CONNECTED ? (
                 <button onClick={handleStop} aria-label="停止翻译" title="停止 (空格)" className="focus-ring ml-1 px-3 md:px-5 py-1.5 md:py-2 rounded-full bg-red-600 hover:bg-red-700 text-white text-xs md:text-sm font-bold transition-all shadow-lg shadow-red-900/30 active:scale-95 flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-sm bg-white" />
                    停止
                 </button>
             ) : !hasApiKey ? (
                 <button onClick={openSettingsToConnection} aria-label="配置 API Key" title="先去配置 API Key" className="focus-ring ml-1 px-3 md:px-4 py-1.5 md:py-2 rounded-full bg-amber-500/90 hover:bg-amber-500 text-gray-950 text-xs md:text-sm font-bold transition-all shadow-lg shadow-amber-900/20 active:scale-95 flex items-center gap-1.5">
                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
                    <span className="hidden sm:inline">配置 Key</span>
                    <span className="sm:hidden">配置</span>
                 </button>
             ) : (
                 <button onClick={handleStart} disabled={status === ConnectionStatus.CONNECTING} aria-label="开始翻译" title="开始 (空格)" className="focus-ring ml-1 px-3 md:px-5 py-1.5 md:py-2 rounded-full bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white text-xs md:text-sm font-bold transition-all shadow-lg shadow-blue-900/30 active:scale-95 disabled:opacity-50 flex items-center gap-1.5">
                    {status === ConnectionStatus.CONNECTING ? (
                      <>
                        <svg className="animate-spin h-3.5 w-3.5" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"/></svg>
                        连接中
                      </>
                    ) : (
                      <>
                        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 4 20 12 6 20 6 4"/></svg>
                        开始
                      </>
                    )}
                 </button>
             )}
        </div>
      </header>

      {/* ============ Main Content ============ */}
      <main ref={mainRef} className="relative flex-1 overflow-y-auto overscroll-contain px-4 md:px-8 pt-6 pb-40 flex flex-col scroll-smooth z-10">
        {errorMessage && (
            <div
              className="w-full max-w-4xl mx-auto mb-6 animate-in slide-in-from-top-4 fade-in duration-300"
              onMouseEnter={pauseErrorAutoDismiss}
              onMouseLeave={resumeErrorAutoDismiss}
            >
                <div className="bg-red-950/60 backdrop-blur border border-red-500/40 rounded-2xl p-4 flex items-start gap-3 shadow-2xl shadow-red-900/20">
                    <div className="flex-none w-10 h-10 rounded-full bg-red-500/20 flex items-center justify-center">
                      <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.2"><path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                    </div>
                    <div className="flex-1 min-w-0">
                        <p className="text-red-100 font-semibold text-sm mb-1">出错了</p>
                        <p className="text-red-200/90 text-sm whitespace-pre-line leading-relaxed">{errorMessage}</p>
                        <div className="mt-3 flex items-center gap-3 flex-wrap">
                          <button
                            onClick={() => { setErrorMessage(null); void handleStart(); }}
                            className="text-xs px-3 py-1.5 rounded-lg bg-red-500/20 hover:bg-red-500/30 text-red-100 font-medium transition-colors"
                          >
                            重试
                          </button>
                          <button
                            onClick={openSettingsToConnection}
                            className="text-xs text-red-200/70 hover:text-white underline underline-offset-2 transition-colors"
                          >
                            打开设置
                          </button>
                          {errorPinnedRef.current ? (
                            <button
                              onClick={unpinError}
                              title="取消常驻,继续自动消失"
                              className="text-xs text-red-200/70 hover:text-white transition-colors flex items-center gap-1"
                            >
                              <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor"><path d="M5 4a2 2 0 012-2h6a2 2 0 012 2v14l-5-2.5L5 18V4z"/></svg>
                              已常驻
                            </button>
                          ) : (
                            <button
                              onClick={pinError}
                              title="保持显示,不自动消失"
                              className="text-xs text-red-200/70 hover:text-white transition-colors flex items-center gap-1"
                            >
                              <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M5 4a2 2 0 012-2h6a2 2 0 012 2v14l-5-2.5L5 18V4z"/></svg>
                              常驻
                            </button>
                          )}
                        </div>
                    </div>
                    <button onClick={() => setErrorMessage(null)} aria-label="关闭" className="text-red-300/70 hover:text-red-100 flex-none p-1 rounded hover:bg-red-500/20 transition-colors"><svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" /></svg></button>
                </div>
            </div>
        )}

        <div className="w-full max-w-4xl mx-auto flex-1 flex flex-col justify-end">
            {messages.length === 0 && !currentOriginal && !currentTranslated && !errorMessage && (
                <div className="flex-1 flex flex-col items-center justify-center text-center p-6 fade-up">
                    {/* Hero 视觉 - 用 SVG 替代 emoji */}
                    <div className="relative mb-6">
                      <div className="absolute inset-0 -m-6 rounded-full bg-gradient-to-br from-blue-500/15 to-purple-500/15 blur-2xl breath-glow" />
                      <div className="relative w-24 h-24 md:w-28 md:h-28 rounded-3xl bg-gradient-to-br from-gray-800 to-gray-900 border border-gray-700/60 shadow-2xl flex items-center justify-center">
                        <svg xmlns="http://www.w3.org/2000/svg" className="w-12 h-12 md:w-14 md:h-14 text-blue-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/>
                          <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
                          <line x1="12" y1="19" x2="12" y2="22"/>
                          <line x1="8" y1="22" x2="16" y2="22"/>
                        </svg>
                      </div>
                    </div>

                    <h2 className="text-2xl md:text-3xl font-bold text-white tracking-tight mb-2">
                      实时同声传译
                    </h2>
                    <p className="text-sm md:text-base text-gray-400 max-w-md leading-relaxed mb-1">
                      自动识别语音 · 流式翻译 · 双向语种自适应
                    </p>
                    <p className="text-xs text-gray-600 mb-8">
                      Powered by {findProvider(providerId).displayName} · {langA} ⇄ {langB}
                    </p>

                    {/* 引导步骤 - 3 步上手 */}
                    {!hasApiKey ? (
                      <div className="w-full max-w-md rounded-2xl border border-amber-500/30 bg-gradient-to-br from-amber-500/10 to-orange-500/5 p-5 text-left shadow-xl backdrop-blur-sm">
                        <div className="flex items-start gap-3 mb-3">
                          <div className="flex-none w-8 h-8 rounded-full bg-amber-500/20 flex items-center justify-center">
                            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-amber-300"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
                          </div>
                          <div className="flex-1">
                            <p className="text-sm font-semibold text-amber-100">还差一步就能开始</p>
                            <p className="text-xs text-amber-100/70 mt-1 leading-relaxed">
                              需要配置 {findProvider(providerId).displayName} 的 API Key 才能调用翻译模型
                            </p>
                          </div>
                        </div>
                        <button
                          onClick={openSettingsToConnection}
                          className="w-full mt-2 py-2.5 rounded-xl bg-amber-500 hover:bg-amber-400 text-gray-950 font-bold text-sm transition-all active:scale-[0.98] shadow-lg shadow-amber-900/20 flex items-center justify-center gap-2"
                        >
                          立即配置 API Key
                          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>
                        </button>
                        {findProvider(providerId).keyUrl && (
                          <a
                            href={findProvider(providerId).keyUrl}
                            target="_blank"
                            rel="noopener"
                            className="block mt-2 text-center text-[11px] text-amber-100/60 hover:text-amber-100 underline underline-offset-2 transition-colors"
                          >
                            没有 Key？前往 {findProvider(providerId).keyUrl?.replace(/^https?:\/\//, '')} 免费获取
                          </a>
                        )}
                      </div>
                    ) : (
                      <div className="w-full max-w-md rounded-2xl border border-gray-800 bg-gray-900/50 backdrop-blur-sm p-5 shadow-xl">
                        <p className="text-xs uppercase tracking-wider text-gray-500 font-semibold mb-3 text-center">3 步开始翻译</p>
                        <div className="space-y-2.5 text-sm">
                          <button onClick={openSettingsToAudio} className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-gray-800/60 transition-colors text-left group">
                            <span className="flex-none w-6 h-6 rounded-full bg-blue-500/15 text-blue-400 text-xs font-bold flex items-center justify-center">1</span>
                            <span className="flex-1 text-gray-300 group-hover:text-white transition-colors">选择音频输入设备</span>
                            <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4 text-gray-600 group-hover:text-gray-400 transition-colors" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m9 18 6-6-6-6"/></svg>
                          </button>
                          <button onClick={() => setIsSettingsOpen(true)} className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-gray-800/60 transition-colors text-left group">
                            <span className="flex-none w-6 h-6 rounded-full bg-blue-500/15 text-blue-400 text-xs font-bold flex items-center justify-center">2</span>
                            <span className="flex-1 text-gray-300 group-hover:text-white transition-colors">确认翻译语言对</span>
                            <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4 text-gray-600 group-hover:text-gray-400 transition-colors" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m9 18 6-6-6-6"/></svg>
                          </button>
                          <button onClick={handleStart} className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg bg-gradient-to-r from-blue-600/20 to-indigo-600/20 hover:from-blue-600/30 hover:to-indigo-600/30 transition-colors text-left group">
                            <span className="flex-none w-6 h-6 rounded-full bg-blue-500 text-white text-xs font-bold flex items-center justify-center">3</span>
                            <span className="flex-1 text-white font-medium">开始翻译</span>
                            <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4 text-blue-300" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 4 20 12 6 20 6 4"/></svg>
                          </button>
                        </div>
                      </div>
                    )}

                    <div className="mt-6 flex items-center gap-1.5 text-[10px] text-gray-600">
                      <kbd className="px-1.5 py-0.5 rounded border border-gray-800 bg-gray-900/50 font-mono">空格</kbd>
                      <span>开始/停止</span>
                      <span className="mx-1.5">·</span>
                      <kbd className="px-1.5 py-0.5 rounded border border-gray-800 bg-gray-900/50 font-mono">S</kbd>
                      <span>设置</span>
                      <span className="mx-1.5">·</span>
                      <kbd className="px-1.5 py-0.5 rounded border border-gray-800 bg-gray-900/50 font-mono">E</kbd>
                      <span>导出</span>
                    </div>
                </div>
            )}
            <div className="space-y-6">
                {messages.map((msg) => (
                    <SubtitleCard
                        key={msg.id}
                        message={msg}
                        isRecent={false}
                        onSwitchLanguage={handleQuickSwitch}
                    />
                ))}
                {(currentOriginal || currentTranslated) && (
                    <SubtitleCard
                        message={{ id: 'current', original: currentOriginal, translated: currentTranslated, isFinal: false, timestamp: Date.now() }}
                        isRecent={true}
                        onSwitchLanguage={handleQuickSwitch}
                    />
                )}
            </div>
            <div ref={bottomRef} className="h-4" />
        </div>
      </main>

      {/* ============ 底部音频可视化 ============ */}
      <div className="absolute bottom-0 left-0 right-0 h-28 pointer-events-none flex flex-col justify-end bg-gradient-to-t from-gray-950 via-gray-950/95 to-transparent z-40">
          <div className="w-full max-w-4xl mx-auto px-4 pb-6">
             <AudioVisualizer stream={stream} isActive={status === ConnectionStatus.CONNECTED} />
          </div>
      </div>

      {/* ============ 连接中弹层 - 改为更轻量的居中卡片 ============ */}
      {status === ConnectionStatus.CONNECTING && (
          <div className="fixed inset-0 z-[100] flex flex-col items-center justify-center bg-gray-950/70 backdrop-blur-md cursor-wait animate-in fade-in duration-150">
            <div className="bg-gray-900/95 border border-gray-700/60 px-6 py-7 rounded-2xl shadow-2xl flex flex-col items-center gap-5 max-w-xs w-full mx-4 fade-up">
                <div className="relative">
                    <div className="w-12 h-12 rounded-full border-2 border-gray-800"></div>
                    <div className="absolute top-0 left-0 w-12 h-12 rounded-full border-2 border-blue-500 border-t-transparent animate-spin"></div>
                </div>
                <div className="text-center space-y-1">
                    <h3 className="text-base font-semibold text-white">
                       {isUpdatingLanguage ? '切换语言中' : '正在连接'}
                    </h3>
                    <p className="text-xs text-gray-400">
                      {isUpdatingLanguage ? '重启翻译会话…' : '初始化音频通道'}
                    </p>
                    {!isUpdatingLanguage && <p className="text-[11px] text-gray-500 mt-2">如有提示，请允许麦克风权限</p>}
                </div>
            </div>
          </div>
      )}

      <LanguageSettings
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        langA={langA}
        langB={langB}
        onSave={handleSettingsUpdate}
        audioSource={audioSource}
        audioInputDeviceId={audioInputDeviceId}
        providerId={providerId}
        apiKey={apiKey}
        baseUrl={baseUrl}
        asrModel={asrModel}
        llmModel={llmModel}
        echoCancellation={echoCancellation}
      />
    </div>
  );
};

export default App;
