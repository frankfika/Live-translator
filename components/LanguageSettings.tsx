import React, { useState, useEffect, useRef, useCallback } from 'react';
import { AudioSource, AudioInputDevice } from '../types';
import {
  buildMicrophoneConstraints,
  formatMediaError,
  normalizeAudioInputDevices,
  isVirtualAudioDevice,
} from '../services/mediaDevices';
import { PROVIDERS, findProvider } from '../services/providers';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  langA: string;
  langB: string;
  onSave: (
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
  ) => void;
  audioSource: AudioSource;
  audioInputDeviceId: string;
  providerId: string;
  apiKey: string;
  baseUrl: string;
  asrModel: string;
  llmModel: string;
  echoCancellation: boolean;
}

interface AudioSourceButtonProps {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  activeClass: string;
  inactiveClass: string;
}

const AudioSourceButton: React.FC<AudioSourceButtonProps> = ({
  active,
  onClick,
  icon,
  label,
  activeClass,
  inactiveClass
}) => (
  <button
    onClick={onClick}
    className={`flex items-center justify-center gap-2 px-4 py-3 rounded-lg border transition-all ${
      active ? activeClass : inactiveClass
    }`}
  >
    {icon}
    <span className="font-medium">{label}</span>
  </button>
);

const LANGUAGES = [
  'English', 'Chinese', 'Spanish', 'French', 'German', 'Japanese',
  'Korean', 'Russian', 'Portuguese', 'Italian', 'Hindi', 'Arabic',
  'Turkish', 'Vietnamese'
];

const TABS = [
  {
    id: 'connection',
    label: '连接',
    icon: (
      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="m21 2-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0 3 3L22 7l-3-3m-3.5 3.5L19 4"/>
      </svg>
    ),
  },
  {
    id: 'audio',
    label: '音频',
    icon: (
      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/>
        <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
        <line x1="12" y1="19" x2="12" y2="22"/>
      </svg>
    ),
  },
  {
    id: 'language',
    label: '语言',
    icon: (
      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10"/>
        <path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
      </svg>
    ),
  },
] as const;

type TabId = typeof TABS[number]['id'];

const LEVEL_IDLE_TEXT = '点击"测试输入"验证当前设备是否真的有声音。';

const LanguageSettings: React.FC<Props> = ({
  isOpen,
  onClose,
  langA,
  langB,
  onSave,
  audioSource,
  audioInputDeviceId,
  providerId,
  apiKey,
  baseUrl,
  asrModel,
  llmModel,
  echoCancellation,
}) => {
  // macOS WKWebView 不支持 getDisplayMedia,系统音频模式必然失败。
  // 在 UI 上按平台分支引导:mac → 虚拟声卡;Windows → 保留屏幕共享说明
  const isMac = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform || navigator.userAgent);
  const [activeTab, setActiveTab] = useState<TabId>('connection');
  const [showApiKey, setShowApiKey] = useState(false);
  const [selected, setSelected] = useState<string[]>([langA, langB]);
  const [localAudioSource, setLocalAudioSource] = useState<AudioSource>(audioSource);
  const [localAudioInputDeviceId, setLocalAudioInputDeviceId] = useState(audioInputDeviceId);
  const [localProviderId, setLocalProviderId] = useState(providerId || 'siliconflow');
  const [localApiKey, setLocalApiKey] = useState(apiKey);
  const [localBaseUrl, setLocalBaseUrl] = useState(baseUrl);
  const [localAsrModel, setLocalAsrModel] = useState(asrModel);
  const [localLlmModel, setLocalLlmModel] = useState(llmModel);
  // 麦克风模式下本地编辑的回声消除/降噪/自动增益开关,默认开
  // 会议场景建议开启(防回声);采集高质量语音给 ASR 时可关闭
  const [localEchoCancellation, setLocalEchoCancellation] = useState<boolean>(echoCancellation);
  const [audioInputs, setAudioInputs] = useState<AudioInputDevice[]>([]);
  const [isLoadingInputs, setIsLoadingInputs] = useState(false);
  const [deviceError, setDeviceError] = useState<string | null>(null);
  const [isTestingInput, setIsTestingInput] = useState(false);
  const [inputLevel, setInputLevel] = useState(0);

  const modalRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const previewStreamRef = useRef<MediaStream | null>(null);
  const previewAudioContextRef = useRef<AudioContext | null>(null);
  const previewAnimationRef = useRef<number | null>(null);

  const currentProvider = findProvider(localProviderId);

  const stopInputPreview = useCallback(async () => {
    if (previewAnimationRef.current) {
      cancelAnimationFrame(previewAnimationRef.current);
      previewAnimationRef.current = null;
    }
    if (previewStreamRef.current) {
      previewStreamRef.current.getTracks().forEach((track) => track.stop());
      previewStreamRef.current = null;
    }
    if (previewAudioContextRef.current) {
      try { await previewAudioContextRef.current.close(); } catch { /* noop */ }
      previewAudioContextRef.current = null;
    }
    setIsTestingInput(false);
    setInputLevel(0);
  }, []);

  const refreshAudioInputs = useCallback(async () => {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) {
      setDeviceError('当前浏览器不支持音频设备枚举，请换用最新版 Chrome。');
      setAudioInputs([]);
      return;
    }
    setIsLoadingInputs(true);
    setDeviceError(null);
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const nextInputs = normalizeAudioInputDevices(devices);
      setAudioInputs(nextInputs);
      setLocalAudioInputDeviceId((current) => {
        if (!current) return '';
        return nextInputs.some((device) => device.deviceId === current) ? current : '';
      });
    } catch (err) {
      setAudioInputs([]);
      setDeviceError(formatMediaError(err, '读取音频设备列表失败。'));
    } finally {
      setIsLoadingInputs(false);
    }
  }, []);

  const handleStartInputTest = useCallback(async () => {
    await stopInputPreview();
    setDeviceError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: buildMicrophoneConstraints(localAudioInputDeviceId, {
          echoCancellation: localEchoCancellation,
          noiseSuppression: localEchoCancellation,
          autoGainControl: localEchoCancellation,
        }),
      });
      previewStreamRef.current = stream;
      const audioContext = new AudioContext();
      previewAudioContextRef.current = audioContext;
      await audioContext.resume();
      const source = audioContext.createMediaStreamSource(stream);
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      const data = new Uint8Array(analyser.fftSize);
      setIsTestingInput(true);
      const tick = () => {
        analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) {
          const normalized = (data[i] - 128) / 128;
          sum += normalized * normalized;
        }
        const rms = Math.sqrt(sum / data.length);
        const nextLevel = Math.min(1, rms * 6);
        setInputLevel((previous) => previous * 0.55 + nextLevel * 0.45);
        previewAnimationRef.current = requestAnimationFrame(tick);
      };
      tick();
      await refreshAudioInputs();
    } catch (err) {
      await stopInputPreview();
      setDeviceError(formatMediaError(err, '无法启动输入测试。'));
    }
  }, [localAudioInputDeviceId, localEchoCancellation, refreshAudioInputs, stopInputPreview]);

  useEffect(() => {
    if (isOpen) {
      setSelected([langA, langB]);
      setLocalAudioSource(audioSource);
      setLocalAudioInputDeviceId(audioInputDeviceId);
      setLocalProviderId(providerId || 'siliconflow');
      setLocalApiKey(apiKey);
      setLocalBaseUrl(baseUrl);
      setLocalAsrModel(asrModel);
      setLocalLlmModel(llmModel);
      setLocalEchoCancellation(echoCancellation);
      void refreshAudioInputs();

      // 检查 URL hash 是否指定了初始 tab（来自 App 的 "立即配置" 按钮）
      const hash = window.location.hash;
      const match = hash.match(/tab=(connection|audio|language)/);
      if (match) {
        setActiveTab(match[1] as TabId);
        window.history.replaceState(null, '', window.location.pathname + window.location.search);
      }
    } else {
      void stopInputPreview();
      setShowApiKey(false);
    }
  }, [isOpen, langA, langB, audioSource, audioInputDeviceId, providerId, apiKey, baseUrl, asrModel, llmModel, echoCancellation, refreshAudioInputs, stopInputPreview]);

  useEffect(() => {
    if (!isOpen || typeof navigator === 'undefined' || !navigator.mediaDevices?.addEventListener) return;
    const handleDeviceChange = () => { void refreshAudioInputs(); };
    navigator.mediaDevices.addEventListener('devicechange', handleDeviceChange);
    return () => navigator.mediaDevices.removeEventListener('devicechange', handleDeviceChange);
  }, [isOpen, refreshAudioInputs]);

  useEffect(() => {
    if (localAudioSource !== 'microphone') void stopInputPreview();
  }, [localAudioSource, stopInputPreview]);

  useEffect(() => () => { void stopInputPreview(); }, [stopInputPreview]);

  useEffect(() => {
    if (!isOpen) return;
    previousFocusRef.current = document.activeElement as HTMLElement;
    const focusTimer = setTimeout(() => { modalRef.current?.focus(); }, 50);
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onClose(); return; }
      if (e.key === 'Tab' && modalRef.current) {
        const focusable = modalRef.current.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        );
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey) {
          if (document.activeElement === first) { e.preventDefault(); last.focus(); }
        } else if (document.activeElement === last) {
          e.preventDefault(); first.focus();
        }
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      clearTimeout(focusTimer);
      previousFocusRef.current?.focus();
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const handleToggle = (lang: string) => {
    if (selected.includes(lang)) {
      setSelected(selected.filter((item) => item !== lang));
      return;
    }
    if (selected.length < 2) {
      setSelected([...selected, lang]);
      return;
    }
    setSelected([selected[0], lang]);
  };

  const handleSave = () => {
    if (selected.length !== 2) return;
    onSave(
      selected[0],
      selected[1],
      localAudioSource,
      localAudioInputDeviceId,
      localProviderId,
      localApiKey.trim(),
      localBaseUrl.trim(),
      localAsrModel.trim(),
      localLlmModel.trim(),
      localEchoCancellation,
    );
    onClose();
  };

  const isReady = selected.length === 2;
  const hasDetectedInputs = audioInputs.length > 0;
  const isDefaultDeviceSelected = localAudioInputDeviceId === '';
  const levelWidth = `${Math.max(6, Math.round(inputLevel * 100))}%`;

  // 改用 provider.validateConfig 真校验 — 之前只看长度 > 10,
  // `'1234567890abc'` 12 字符都过审 → 绿条假承诺 → 启动 401
  const apiKeyValidation = currentProvider.validateConfig({
    apiKey: localApiKey,
    baseUrl: localBaseUrl || currentProvider.defaultBaseUrl,
    asrModel: localAsrModel || currentProvider.defaultAsrModel,
    llmModel: localLlmModel || currentProvider.defaultLlmModel,
  });
  const hasApiKey = !apiKeyValidation; // null = 通过

  // 切 provider 总是重置 baseUrl / asrModel / llmModel 到新 provider 默认
  // 之前只在空才填,如果用户在 SiliconFlow 改成 Qwen2.5-7B 再切到 DashScope,
  // 字段留着 "Qwen2.5-7B", DashScope 启动时报模型不存在
  const handleProviderChange = (nextId: string) => {
    setLocalProviderId(nextId);
    const next = findProvider(nextId);
    setLocalBaseUrl(next.defaultBaseUrl);
    setLocalAsrModel(next.defaultAsrModel);
    setLocalLlmModel(next.defaultLlmModel);
  };

  // ── Tab content renderers ──────────────────────────────────────────────

  const renderConnectionTab = () => (
    <div className="space-y-5">
      <div>
        <label htmlFor="provider-select" className="text-sm font-medium text-gray-300 mb-2 block">
          服务商
        </label>
        <select
          id="provider-select"
          value={localProviderId}
          onChange={(e) => handleProviderChange(e.target.value)}
          className="w-full rounded-xl border border-gray-700 bg-gray-950 px-3 py-3 text-sm text-white outline-none transition-colors focus:border-blue-500"
        >
          {PROVIDERS.map((p) => (
            <option key={p.id} value={p.id}>{p.displayName}</option>
          ))}
        </select>
        <p className="mt-2 text-[11px] text-gray-400 leading-relaxed">
          {currentProvider.description}
        </p>
      </div>

      <div>
        <label htmlFor="api-key-input" className="text-sm font-medium text-gray-300 mb-2 block">
          API Key
        </label>
        <div className="relative">
          <input
            id="api-key-input"
            type={showApiKey ? 'text' : 'password'}
            value={localApiKey}
            onChange={(e) => setLocalApiKey(e.target.value)}
            placeholder="sk-xxxxxxxxxxxxxxxxxxxxxxxx"
            autoComplete="off"
            spellCheck={false}
            className="w-full rounded-xl border border-gray-700 bg-gray-950 px-3 py-3 pr-20 text-sm text-white outline-none transition-colors focus:border-blue-500 placeholder:text-gray-600 font-mono"
          />
          <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
            {localApiKey && (
              <button
                type="button"
                onClick={() => setShowApiKey((s) => !s)}
                aria-label={showApiKey ? '隐藏 API Key' : '显示 API Key'}
                className="p-1.5 rounded-md text-gray-500 hover:text-gray-200 hover:bg-gray-800 transition-colors"
                title={showApiKey ? '隐藏' : '显示'}
              >
                {showApiKey ? (
                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><line x1="2" y1="2" x2="22" y2="22"/></svg>
                ) : (
                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>
                )}
              </button>
            )}
            {localApiKey && (
              <button
                type="button"
                onClick={() => setLocalApiKey('')}
                aria-label="清空 API Key"
                className="p-1.5 rounded-md text-gray-500 hover:text-red-300 hover:bg-gray-800 transition-colors"
                title="清空"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
            )}
          </div>
        </div>
        <p className="mt-2 text-[11px] text-gray-400 leading-relaxed">
          {currentProvider.keyUrl ? (
            <>
              获取地址：
              <a href={currentProvider.keyUrl} target="_blank" rel="noopener" className="text-blue-400 hover:text-blue-300 underline underline-offset-2">
                {currentProvider.keyUrl.replace(/^https?:\/\//, '')}
              </a>
            </>
          ) : (
            '请在所选服务商的官方控制台申请 API Key。'
          )}
        </p>
      </div>

      {hasApiKey ? (
        <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 flex items-center gap-2.5 fade-up">
          <div className="w-7 h-7 rounded-full bg-emerald-500/20 flex items-center justify-center flex-none">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-emerald-300"><polyline points="20 6 9 17 4 12"/></svg>
          </div>
          <span className="text-sm text-emerald-200 font-medium">配置已就绪，可以开始翻译</span>
        </div>
      ) : (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 flex items-start gap-2.5">
          <div className="w-7 h-7 rounded-full bg-amber-500/20 flex items-center justify-center flex-none mt-0.5">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-amber-300"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
          </div>
          <div className="flex-1">
            <p className="text-sm text-amber-200 font-medium">配置不完整</p>
            <p className="text-[11px] text-amber-200/70 mt-0.5">{apiKeyValidation}</p>
          </div>
        </div>
      )}

      <div className="rounded-xl border border-gray-700/50 bg-gray-800/30 p-4 space-y-3">
        <h3 className="text-xs uppercase tracking-wider font-bold text-gray-500">模型配置</h3>

        <div className="space-y-3">
          <div>
            <label htmlFor="base-url-input" className="text-[11px] uppercase tracking-wider font-bold text-gray-500 mb-1.5 block">
              API 地址（baseUrl）
            </label>
            <input
              id="base-url-input"
              type="text"
              value={localBaseUrl}
              onChange={(e) => setLocalBaseUrl(e.target.value)}
              placeholder={currentProvider.defaultBaseUrl}
              autoComplete="off"
              spellCheck={false}
              className="w-full rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-xs text-white outline-none transition-colors focus:border-blue-500 placeholder:text-gray-600 font-mono"
            />
            {currentProvider.customHint && (
              <p className="mt-1.5 text-[10px] text-gray-500 leading-relaxed">{currentProvider.customHint}</p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-2.5">
            <div>
              <label htmlFor="asr-model-input" className="text-[11px] uppercase tracking-wider font-bold text-gray-500 mb-1.5 block">
                语音识别 (ASR)
              </label>
              <input
                id="asr-model-input"
                type="text"
                value={localAsrModel}
                onChange={(e) => setLocalAsrModel(e.target.value)}
                placeholder={currentProvider.defaultAsrModel}
                autoComplete="off"
                spellCheck={false}
                className="w-full rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-xs text-white outline-none transition-colors focus:border-blue-500 placeholder:text-gray-600 font-mono"
              />
            </div>
            <div>
              <label htmlFor="llm-model-input" className="text-[11px] uppercase tracking-wider font-bold text-gray-500 mb-1.5 block">
                翻译 (LLM)
              </label>
              <input
                id="llm-model-input"
                type="text"
                value={localLlmModel}
                onChange={(e) => setLocalLlmModel(e.target.value)}
                placeholder={currentProvider.defaultLlmModel}
                autoComplete="off"
                spellCheck={false}
                className="w-full rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-xs text-white outline-none transition-colors focus:border-blue-500 placeholder:text-gray-600 font-mono"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2.5 text-[10px] pt-1">
            <div className="rounded-md bg-gray-950/50 px-2.5 py-1.5 border border-gray-800/50">
              <span className="text-gray-500">当前 ASR: </span>
              <span className="text-gray-200 font-mono">{localAsrModel.trim() || currentProvider.defaultAsrModel}</span>
            </div>
            <div className="rounded-md bg-gray-950/50 px-2.5 py-1.5 border border-gray-800/50">
              <span className="text-gray-500">当前 LLM: </span>
              <span className="text-gray-200 font-mono">{localLlmModel.trim() || currentProvider.defaultLlmModel}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );

  const renderAudioTab = () => {
    // 系统音频模式(macOS 分支): 是否检测到虚拟声卡,有的话给出使用引导,没有的话给出安装引导
    const virtualDevice = audioInputs.find((d) => d.isVirtual || isVirtualAudioDevice(d.label));
    const virtualDeviceLabel = virtualDevice?.label || 'BlackHole 2ch';

    return (
    <div className="space-y-5">
      <div>
        <label className="text-sm font-medium text-gray-300 mb-3 block">音频输入源</label>
        <div className="grid grid-cols-2 gap-3">
          <AudioSourceButton
            active={localAudioSource === 'microphone'}
            onClick={() => setLocalAudioSource('microphone')}
            icon={<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="22"/></svg>}
            label="麦克风 / 虚拟声卡"
            activeClass="bg-blue-600 border-blue-500 text-white shadow-lg shadow-blue-900/20"
            inactiveClass="bg-gray-800 border-gray-700 text-gray-400 hover:bg-gray-700 hover:text-gray-200"
          />
          <AudioSourceButton
            active={localAudioSource === 'system'}
            onClick={() => setLocalAudioSource('system')}
            icon={<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect width="20" height="14" x="2" y="3" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>}
            label="系统音频"
            activeClass="bg-purple-600 border-purple-500 text-white shadow-lg shadow-purple-900/20"
            inactiveClass="bg-gray-800 border-gray-700 text-gray-400 hover:bg-gray-700 hover:text-gray-200"
          />
        </div>
      </div>

      {localAudioSource === 'microphone' ? (
        <div className="rounded-xl border border-blue-500/20 bg-blue-500/5 p-4 space-y-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-sm font-medium text-blue-100">像腾讯会议一样先选设备，再开录</p>
              <p className="mt-1 text-xs leading-relaxed text-blue-100/70">
                这里可以选具体输入设备，包括 Mac 内建麦克风、耳机麦克风，或 BlackHole 这类虚拟声卡。
              </p>
            </div>
            <button
              type="button"
              onClick={() => void refreshAudioInputs()}
              className="shrink-0 rounded-lg border border-blue-400/30 px-3 py-2 text-xs font-medium text-blue-200 hover:bg-blue-500/10 transition-colors disabled:opacity-50"
              disabled={isLoadingInputs}
            >
              {isLoadingInputs ? '刷新中...' : '刷新列表'}
            </button>
          </div>

          <div className="space-y-2">
            <label htmlFor="audio-input-device" className="text-xs font-medium text-gray-300">输入设备</label>
            <select
              id="audio-input-device"
              value={localAudioInputDeviceId}
              onChange={(e) => setLocalAudioInputDeviceId(e.target.value)}
              className="w-full rounded-xl border border-gray-700 bg-gray-950 px-3 py-3 text-sm text-white outline-none transition-colors focus:border-blue-500"
            >
              <option value="">系统默认输入设备</option>
              {audioInputs.map((device) => (
                // 虚拟声卡(BlackHole / VB-Cable / Loopback) 加 "(虚拟声卡)" 后缀,
                // 让用户一眼看出这个设备可以用来收会议软件输出
                <option key={device.deviceId} value={device.deviceId}>
                  {(device.isVirtual || isVirtualAudioDevice(device.label)) ? `${device.label} (虚拟声卡)` : device.label}
                </option>
              ))}
            </select>
            <p className="text-[11px] leading-relaxed text-gray-400">
              {hasDetectedInputs
                ? isDefaultDeviceSelected
                  ? '当前会跟随系统默认输入设备。'
                  : '已锁定到你选择的这个设备，开始翻译时会直接用它录音。'
                : '如果列表为空，先点"测试输入"授权浏览器麦克风，再回来刷新列表。'}
            </p>
          </div>

          {/* 回声消除 / 降噪 / 自动增益 — 会议场景建议开启,采集高质量语音给 ASR 时可关闭 */}
          <div className="rounded-xl border border-gray-700/60 bg-gray-950/60 p-3 flex items-start justify-between gap-3">
            <div className="flex-1 min-w-0">
              <label htmlFor="echo-cancellation-toggle" className="text-sm font-medium text-white cursor-pointer">
                回声消除 / 降噪 / 自动增益
              </label>
              <p className="mt-1 text-[11px] text-gray-400 leading-relaxed">
                会议场景建议开启,防止麦克风拾取扬声器回声;若在 ASR 训练/录音棚场景采集纯净语音,可关闭以保留原始频谱。
              </p>
            </div>
            <button
              id="echo-cancellation-toggle"
              type="button"
              role="switch"
              aria-checked={localEchoCancellation}
              onClick={() => setLocalEchoCancellation((v) => !v)}
              className={`shrink-0 relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                localEchoCancellation ? 'bg-blue-600' : 'bg-gray-700'
              }`}
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                  localEchoCancellation ? 'translate-x-6' : 'translate-x-1'
                }`}
              />
            </button>
          </div>

          <div className="rounded-xl border border-gray-700/60 bg-gray-950/60 p-3 space-y-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-medium text-white">输入测试</p>
                <p className="mt-1 text-[11px] text-gray-400">
                  {isTestingInput ? '说话或播放会议声音，确认下面电平条会动。' : LEVEL_IDLE_TEXT}
                </p>
              </div>
              <button
                type="button"
                onClick={() => void (isTestingInput ? stopInputPreview() : handleStartInputTest())}
                className={`shrink-0 rounded-lg px-3 py-2 text-xs font-semibold transition-all ${
                  isTestingInput
                    ? 'bg-red-600 text-white hover:bg-red-500'
                    : 'bg-emerald-600 text-white hover:bg-emerald-500'
                }`}
              >
                {isTestingInput ? '停止测试' : '测试输入'}
              </button>
            </div>
            <div className="h-2 rounded-full bg-gray-800 overflow-hidden">
              <div
                className="h-full rounded-full bg-gradient-to-r from-emerald-500 to-emerald-300 transition-all duration-100"
                style={{ width: levelWidth }}
                aria-label="输入电平"
              />
            </div>
            {deviceError && (
              <p className="text-[11px] text-red-300 whitespace-pre-line">{deviceError}</p>
            )}
          </div>
        </div>
      ) : (
        // 系统音频模式:按平台分支引导
        // macOS WKWebView 不支持 getDisplayMedia,直接告诉用户装 BlackHole
        // Windows / Linux 走原来的屏幕共享 + 共享系统音频路径
        <div className="rounded-xl border border-purple-500/20 bg-purple-500/5 p-4 space-y-3">
          <p className="text-sm font-medium text-purple-100">系统音频:抓会议软件声音</p>
          {isMac ? (
            virtualDevice ? (
              // 检测到虚拟声卡:给出 ①②③ 三步使用引导
              <div className="rounded-lg border border-purple-400/30 bg-purple-500/10 p-3 space-y-2 text-[12px] leading-relaxed text-purple-100/90">
                <p className="text-purple-100 font-medium">已检测到虚拟声卡 <span className="font-mono">{virtualDeviceLabel}</span>,请按下列步骤配置:</p>
                <ol className="list-decimal pl-5 space-y-1.5 text-purple-100/80">
                  <li>在会议软件(Zoom / 腾讯会议 / 飞书)的「音频设置」里,把<span className="font-semibold">扬声器/输出</span>选为 <span className="font-mono">{virtualDeviceLabel}</span>;</li>
                  <li>在本应用上方「输入设备」里也选 <span className="font-mono">{virtualDeviceLabel}</span>,然后切回「麦克风 / 虚拟声卡」模式;</li>
                  <li>点击主界面的「开始」,本应用就会翻译会议软件里播放的远端声音。</li>
                </ol>
                <p className="text-[11px] text-purple-100/60 pt-1">系统设置路径:系统设置 → 声音 → 输出 → 选 {virtualDeviceLabel}。建议同时把 Mac 自己的扬声器也设到虚拟声卡,避免本地外放让麦克风拾取到回声。</p>
              </div>
            ) : (
              // 未检测到虚拟声卡:给出安装引导
              <div className="rounded-lg border border-amber-400/30 bg-amber-500/10 p-3 space-y-2 text-[12px] leading-relaxed text-amber-100/90">
                <p className="text-amber-100 font-medium">macOS 上本应用无法直接抓取系统音频</p>
                <p className="text-amber-100/80">
                  WKWebView 不支持 <code className="px-1 py-0.5 rounded bg-amber-500/15 font-mono text-[11px]">getDisplayMedia</code>,屏幕共享拿不到音频轨。需要借助虚拟声卡把会议软件的声音「路由」到本应用。
                </p>
                <p className="text-amber-100/80">推荐安装 <span className="font-semibold">BlackHole</span>(免费开源):</p>
                <button
                  type="button"
                  onClick={() => window.open('https://existential.audio/blackhole/', '_blank', 'noopener,noreferrer')}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-amber-500 hover:bg-amber-400 text-gray-950 font-semibold px-3 py-1.5 text-xs transition-colors"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                  打开下载页(existential.audio)
                </button>
                <p className="text-[11px] text-amber-100/70 leading-relaxed pt-1">
                  安装完 BlackHole 后:① 系统设置 → 声音 → 输出 → 选 BlackHole;② 打开「音频 MIDI 设置」创建多输出设备(同时输出到 BlackHole 和 Mac 扬声器,这样你能听到);③ 会议软件音频输出也切到 BlackHole;④ 回到本应用切到「麦克风 / 虚拟声卡」并选 BlackHole 作为输入。
                </p>
              </div>
            )
          ) : (
            // Windows / Linux:保留原有屏幕共享说明
            <div className="space-y-2 text-[12px] text-purple-100/80 leading-relaxed">
              <p>点击「开始翻译」后会弹出共享窗口,请勾选「共享系统音频」(Chrome / Edge 支持)。</p>
              <p>如果会议软件本身没有带音频的标签页可以共享,推荐改用 Voicemeeter 这类虚拟声卡 + 「麦克风 / 虚拟声卡」模式,体验更稳。</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
  };

  const renderLanguageTab = () => (
    <div className="space-y-4">
      <p className="text-sm text-gray-300">选择两种翻译语言。每次说出口的话会自动识别方向。</p>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
        {LANGUAGES.map((lang) => {
          const isSelected = selected.includes(lang);
          const isFirstSlot = selected.length === 0 || selected[0] === lang;
          return (
            <button
              key={lang}
              type="button"
              onClick={() => handleToggle(lang)}
              className={`px-3 py-2.5 rounded-lg border text-sm font-medium transition-all ${
                isSelected
                  ? isFirstSlot
                    ? 'bg-blue-600/20 border-blue-500 text-blue-100'
                    : 'bg-emerald-600/20 border-emerald-500 text-emerald-100'
                  : 'bg-gray-800 border-gray-700 text-gray-400 hover:bg-gray-700 hover:text-gray-200'
              }`}
            >
              {lang}
            </button>
          );
        })}
      </div>
    </div>
  );

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-gray-950/70 backdrop-blur-md p-4 animate-in fade-in duration-150">
      <div
        ref={modalRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        className="bg-gray-900 border border-gray-700/60 rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] flex flex-col fade-up"
      >
        <header className="flex-none flex items-center justify-between p-5 border-b border-gray-800">
          <h2 id="settings-title" className="text-lg font-bold text-white">会话设置</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="p-1.5 rounded-md text-gray-500 hover:text-white hover:bg-gray-800 transition-colors"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </header>

        <nav className="flex-none flex border-b border-gray-800" role="tablist">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={activeTab === tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex-1 flex items-center justify-center gap-1.5 py-3 text-xs font-medium transition-colors ${
                activeTab === tab.id
                  ? 'text-blue-300 border-b-2 border-blue-500'
                  : 'text-gray-500 hover:text-gray-300'
              }`}
            >
              {tab.icon}
              {tab.label}
            </button>
          ))}
        </nav>

        <div className="flex-1 overflow-y-auto p-5">
          {activeTab === 'connection' && renderConnectionTab()}
          {activeTab === 'audio' && renderAudioTab()}
          {activeTab === 'language' && renderLanguageTab()}
        </div>

        <footer className="flex-none flex items-center justify-end gap-2 p-4 border-t border-gray-800">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-lg text-sm text-gray-300 hover:text-white hover:bg-gray-800 transition-colors"
          >
            取消
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={!isReady}
            className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold disabled:opacity-50 transition-colors"
          >
            保存
          </button>
        </footer>
      </div>
    </div>
  );
};

export default LanguageSettings;
