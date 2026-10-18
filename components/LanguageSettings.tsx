import React, { useState, useEffect, useRef, useCallback } from 'react';
import { AudioInputDevice } from '../types';
import {
  formatMediaError,
  normalizeAudioInputDevices,
  isVirtualAudioDevice,
  isLoopbackInputDevice,
} from '../services/mediaDevices';
import { PROVIDERS, findProvider, buildProviderConfig } from '../services/providers';
import { AppSettings } from '../services/settings';
import { isTauriApp } from '../services/tauri';
import { humanizeError } from '../services/liveSession';
import { acquireAudio } from '../services/audioCapture';
import { calculateRMS } from '../services/audioUtils';

export type SettingsTab = 'connection' | 'audio' | 'language' | 'display';

interface Props {
  settings: AppSettings;
  onSave: (next: AppSettings) => void;
  /** 渲染为弹窗（默认）还是直接嵌入页面 */
  embedded?: boolean;
  isOpen?: boolean;
  onClose?: () => void;
  initialTab?: SettingsTab;
  /** 翻译进行中：输入测试会和正在跑的采集抢设备，禁用 */
  busy?: boolean;
}

export const LANGUAGES: { id: string; label: string }[] = [
  { id: 'Chinese', label: '中文' }, { id: 'English', label: 'English' }, { id: 'Japanese', label: '日本語' },
  { id: 'Korean', label: '한국어' }, { id: 'French', label: 'Français' }, { id: 'German', label: 'Deutsch' },
  { id: 'Spanish', label: 'Español' }, { id: 'Russian', label: 'Русский' }, { id: 'Portuguese', label: 'Português' },
  { id: 'Italian', label: 'Italiano' }, { id: 'Hindi', label: 'हिन्दी' }, { id: 'Arabic', label: 'العربية' },
  { id: 'Turkish', label: 'Türkçe' }, { id: 'Vietnamese', label: 'Tiếng Việt' },
];

const TABS: { id: SettingsTab; label: string }[] = [
  { id: 'connection', label: '模型服务' },
  { id: 'audio', label: '声音来源' },
  { id: 'language', label: '语言与术语' },
  { id: 'display', label: '字幕外观' },
];

const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform || navigator.userAgent);
const isWindows = typeof navigator !== 'undefined' && /Win/i.test(navigator.platform || navigator.userAgent);

const inputCls =
  'w-full rounded-lg border border-gray-700 bg-gray-950 px-3 py-2.5 text-sm text-white outline-none transition-colors focus:border-sky-500 placeholder:text-gray-600';
const labelCls = 'text-xs font-medium text-gray-400 mb-1.5 block';

const Toggle: React.FC<{ checked: boolean; onChange: (v: boolean) => void; id?: string }> = ({ checked, onChange, id }) => (
  <button
    id={id}
    type="button"
    role="switch"
    aria-checked={checked}
    onClick={() => onChange(!checked)}
    className={`shrink-0 relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${checked ? 'bg-sky-600' : 'bg-gray-700'}`}
  >
    <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${checked ? 'translate-x-6' : 'translate-x-1'}`} />
  </button>
);

const Row: React.FC<{ title: string; desc?: React.ReactNode; children: React.ReactNode }> = ({ title, desc, children }) => (
  <div className="flex items-start justify-between gap-4 py-3">
    <div className="min-w-0">
      <p className="text-sm text-gray-100">{title}</p>
      {desc && <p className="mt-0.5 text-xs text-gray-500 leading-relaxed">{desc}</p>}
    </div>
    <div className="shrink-0">{children}</div>
  </div>
);

const LanguageSettings: React.FC<Props> = ({ settings, onSave, embedded, isOpen = true, onClose, initialTab, busy }) => {
  const [tab, setTab] = useState<SettingsTab>(initialTab ?? 'connection');
  const [draft, setDraft] = useState<AppSettings>(settings);
  const [showKey, setShowKey] = useState(false);
  const [inputs, setInputs] = useState<AudioInputDevice[]>([]);
  const [deviceError, setDeviceError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [level, setLevel] = useState(0);
  const [apiTest, setApiTest] = useState<{ state: 'idle' | 'running' | 'ok' | 'fail'; msg?: string }>({ state: 'idle' });

  const previewRef = useRef<{ stop: () => void } | null>(null);
  const dirty = JSON.stringify(draft) !== JSON.stringify(settings);
  // 用户是否动过表单：没动过就始终跟随外部设置（异步加载完成、悬浮窗里切了音源等）
  const editedRef = useRef(false);

  useEffect(() => { if (initialTab) setTab(initialTab); }, [initialTab]);
  useEffect(() => {
    if (!editedRef.current || !isOpen) {
      editedRef.current = false;
      setDraft(settings);
    }
  }, [settings, isOpen]);

  const set = <K extends keyof AppSettings>(k: K, v: AppSettings[K]) => {
    editedRef.current = true;
    setDraft((d) => ({ ...d, [k]: v }));
  };

  const stopPreview = useCallback(() => {
    previewRef.current?.stop();
    previewRef.current = null;
    setTesting(false);
    setLevel(0);
  }, []);

  const refreshInputs = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    try {
      setInputs(normalizeAudioInputDevices(await navigator.mediaDevices.enumerateDevices()));
    } catch (err) {
      setDeviceError(formatMediaError(err, '读取音频设备列表失败。'));
    }
  }, []);

  useEffect(() => {
    if (!isOpen) { stopPreview(); return; }
    void refreshInputs();
    const md = navigator.mediaDevices;
    if (!md?.addEventListener) return;
    const h = () => void refreshInputs();
    md.addEventListener('devicechange', h);
    return () => md.removeEventListener('devicechange', h);
  }, [isOpen, refreshInputs, stopPreview]);

  useEffect(() => () => stopPreview(), [stopPreview]);
  // 换了声音来源 / 开始翻译时停掉测试
  useEffect(() => { stopPreview(); }, [draft.audioSource, busy, stopPreview]);

  // 输入测试走和正式翻译完全相同的采集路径（含 Linux 原生录音、电脑声音），测到的就是实际会用的
  const startPreview = async () => {
    stopPreview();
    setDeviceError(null);
    const toLevel = (rms: number) => {
      const db = 20 * Math.log10(Math.max(rms, 1e-6));
      setLevel((p) => p * 0.6 + Math.min(1, Math.max(0, (db + 60) / 60)) * 0.4);
    };
    try {
      const cap = await acquireAudio({
        source: draft.audioSource,
        deviceId: draft.audioInputDeviceId,
        echoCancellation: draft.echoCancellation,
        onPcm: (pcm) => toLevel(calculateRMS(pcm)),
        onEnded: () => stopPreview(),
      });
      if (cap.kind === 'pcm') {
        previewRef.current = { stop: cap.stop };
      } else {
        const ctx = new AudioContext();
        await ctx.resume().catch(() => {});
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 1024;
        ctx.createMediaStreamSource(cap.stream).connect(analyser);
        const data = new Float32Array(analyser.fftSize);
        let raf = 0;
        const tick = () => {
          analyser.getFloatTimeDomainData(data);
          toLevel(calculateRMS(data));
          raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
        previewRef.current = {
          stop: () => {
            cancelAnimationFrame(raf);
            cap.stop();
            void ctx.close().catch(() => {});
          },
        };
      }
      setTesting(true);
      void refreshInputs();
    } catch (err) {
      stopPreview();
      setDeviceError(formatMediaError(err, '无法启动输入测试。'));
    }
  };

  const provider = findProvider(draft.providerId);
  const providerCfg = buildProviderConfig(provider, {
    apiKey: draft.apiKey, baseUrl: draft.baseUrl, asrModel: draft.asrModel, llmModel: draft.llmModel,
  });
  const cfgError = provider.validateConfig(providerCfg);

  const runApiTest = async () => {
    if (cfgError) { setApiTest({ state: 'fail', msg: cfgError }); return; }
    setApiTest({ state: 'running' });
    let out = '';
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    try {
      await provider.translate({
        text: '你好，很高兴见到你。',
        systemInstruction: 'Translate the user text into English. Output only the translation.',
        cfg: providerCfg,
        signal: ctrl.signal,
        onChunk: (c) => { out += c; },
      });
      setApiTest({ state: 'ok', msg: out.replace(/<think>[\s\S]*?<\/think>/g, '').trim().slice(0, 60) || '连接成功' });
    } catch (err) {
      const e = err as Error;
      setApiTest({ state: 'fail', msg: e.name === 'AbortError' ? '请求超时' : humanizeError(e.message) });
    } finally {
      clearTimeout(timer);
    }
  };

  const handleProviderChange = (id: string) => {
    editedRef.current = true;
    const next = findProvider(id);
    setDraft((d) => ({ ...d, providerId: id, baseUrl: next.defaultBaseUrl, asrModel: next.defaultAsrModel, llmModel: next.defaultLlmModel }));
    setApiTest({ state: 'idle' });
  };

  const save = () => {
    editedRef.current = false;
    onSave({ ...draft, apiKey: draft.apiKey.trim(), baseUrl: draft.baseUrl.trim(), asrModel: draft.asrModel.trim(), llmModel: draft.llmModel.trim() });
    if (!embedded) onClose?.();
  };

  // Esc 关闭弹窗
  useEffect(() => {
    if (embedded || !isOpen) return;
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose?.(); };
    document.addEventListener('keydown', h);
    return () => document.removeEventListener('keydown', h);
  }, [embedded, isOpen, onClose]);

  if (!isOpen) return null;

  // ── 各 tab ──────────────────────────────────────────────

  const connectionTab = (
    <div className="space-y-5">
      <div>
        <label htmlFor="provider-select" className={labelCls}>服务商</label>
        <select id="provider-select" value={draft.providerId} onChange={(e) => handleProviderChange(e.target.value)} className={inputCls}>
          {PROVIDERS.map((p) => <option key={p.id} value={p.id}>{p.displayName}</option>)}
        </select>
        <p className="mt-1.5 text-xs text-gray-500">{provider.description}</p>
      </div>

      <div>
        <label htmlFor="api-key-input" className={labelCls}>API Key</label>
        <div className="relative">
          <input
            id="api-key-input"
            type={showKey ? 'text' : 'password'}
            value={draft.apiKey}
            onChange={(e) => { set('apiKey', e.target.value); setApiTest({ state: 'idle' }); }}
            placeholder="sk-..."
            autoComplete="off"
            spellCheck={false}
            className={`${inputCls} pr-16 font-mono`}
          />
          {draft.apiKey && (
            <button type="button" onClick={() => setShowKey((s) => !s)} className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-gray-500 hover:text-gray-200 px-2 py-1">
              {showKey ? '隐藏' : '显示'}
            </button>
          )}
        </div>
        {provider.keyUrl && (
          <p className="mt-1.5 text-xs text-gray-500">
            获取：<a href={provider.keyUrl} target="_blank" rel="noopener" className="text-sky-400 hover:text-sky-300 underline underline-offset-2">{provider.keyUrl.replace(/^https?:\/\//, '')}</a>
          </p>
        )}
      </div>

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => void runApiTest()}
          disabled={apiTest.state === 'running'}
          className="rounded-lg border border-gray-700 px-3 py-2 text-xs font-medium text-gray-200 hover:bg-gray-800 disabled:opacity-50"
        >
          {apiTest.state === 'running' ? '测试中…' : '测试连接'}
        </button>
        <span className={`text-xs ${apiTest.state === 'ok' ? 'text-emerald-400' : apiTest.state === 'fail' ? 'text-red-400' : 'text-gray-500'}`}>
          {apiTest.state === 'ok' && `✓ 可用（${apiTest.msg}）`}
          {apiTest.state === 'fail' && `✕ ${apiTest.msg}`}
          {apiTest.state === 'idle' && (cfgError ? cfgError : '保存前建议测一下')}
        </span>
      </div>

      <details className="rounded-lg border border-gray-800 bg-gray-900/40 p-3 [&_summary]:cursor-pointer">
        <summary className="text-xs text-gray-400">高级：API 地址与模型</summary>
        <div className="mt-3 space-y-3">
          <div>
            <label htmlFor="base-url-input" className={labelCls}>API 地址</label>
            <input id="base-url-input" value={draft.baseUrl} onChange={(e) => set('baseUrl', e.target.value)} placeholder={provider.defaultBaseUrl} spellCheck={false} className={`${inputCls} font-mono text-xs`} />
            {provider.customHint && <p className="mt-1 text-[11px] text-gray-500">{provider.customHint}</p>}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="asr-model-input" className={labelCls}>语音识别模型</label>
              <input id="asr-model-input" value={draft.asrModel} onChange={(e) => set('asrModel', e.target.value)} placeholder={provider.defaultAsrModel || '必填'} spellCheck={false} className={`${inputCls} font-mono text-xs`} />
            </div>
            <div>
              <label htmlFor="llm-model-input" className={labelCls}>翻译模型</label>
              <input id="llm-model-input" value={draft.llmModel} onChange={(e) => set('llmModel', e.target.value)} placeholder={provider.defaultLlmModel} spellCheck={false} className={`${inputCls} font-mono text-xs`} />
            </div>
          </div>
        </div>
      </details>
    </div>
  );

  const loopbackDevice = inputs.find((d) => d.isVirtual || isVirtualAudioDevice(d.label) || isLoopbackInputDevice(d.label));
  const selectedDevice = inputs.find((d) => d.deviceId === draft.audioInputDeviceId);
  const selectedIsRaw = !!selectedDevice && (selectedDevice.isVirtual || isLoopbackInputDevice(selectedDevice.label));

  const systemHelp = isTauriApp() ? (
    isWindows ? (
      <p>直接录制电脑正在播放的声音（腾讯会议、Zoom、Teams、飞书、浏览器、视频都可以），无需安装任何驱动。</p>
    ) : isMac ? (
      <>
        <p>macOS 14.6 及以上：直接录制电脑声音，首次使用会请求「录屏与系统录音」权限，允许即可。</p>
        <p className="text-gray-500">更早的 macOS：安装免费的 <a className="text-sky-400 underline" href="https://existential.audio/blackhole/" target="_blank" rel="noopener">BlackHole</a>，把会议软件的扬声器设为 BlackHole（或在「音频 MIDI 设置」建多输出设备，这样自己也能听到），本应用会自动识别。{loopbackDevice && <span className="text-emerald-400"> 已检测到：{loopbackDevice.label}</span>}</p>
      </>
    ) : (
      <p>Linux：通过 PulseAudio / PipeWire 直接录制默认扬声器的声音（需要系统里有 parec 或 pw-record 命令，绝大多数桌面发行版自带）。</p>
    )
  ) : (
    <>
      <p>点「开始」后浏览器会弹出共享窗口：</p>
      <ul className="list-disc pl-5 space-y-1">
        <li>网页会议（Google Meet、腾讯会议网页版、Zoom 网页版…）：选<b>「Chrome 标签页」</b>→ 选会议所在标签页 → 打开<b>「同时分享标签页音频」</b>。</li>
        <li>桌面会议软件：选<b>「整个屏幕」</b>→ 打开<b>「同时分享系统音频」</b>（仅 Windows / ChromeOS 的 Chrome、Edge 支持）。</li>
        <li>macOS 上的桌面会议软件请使用桌面版。</li>
      </ul>
    </>
  );

  const audioTab = (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3">
        {([
          ['system', '电脑声音', '会议对方 / 视频 / 网页'],
          ['microphone', '麦克风', '自己说话 / 现场'],
        ] as const).map(([id, title, sub]) => (
          <button
            key={id}
            type="button"
            onClick={() => set('audioSource', id)}
            className={`rounded-xl border p-3 text-left transition-colors ${draft.audioSource === id ? 'border-sky-500 bg-sky-500/10' : 'border-gray-700 bg-gray-900 hover:border-gray-600'}`}
          >
            <p className="text-sm font-semibold text-white">{title}</p>
            <p className="text-xs text-gray-500 mt-0.5">{sub}</p>
          </button>
        ))}
      </div>

      {draft.audioSource === 'system' ? (
        <div className="rounded-xl border border-gray-800 bg-gray-900/50 p-4 text-xs text-gray-300 leading-relaxed space-y-2">{systemHelp}</div>
      ) : (
        <div className="space-y-4">
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label htmlFor="audio-input-device" className="text-xs font-medium text-gray-400">输入设备</label>
              <button type="button" onClick={() => void refreshInputs()} className="text-xs text-gray-500 hover:text-gray-200">刷新</button>
            </div>
            <select id="audio-input-device" value={draft.audioInputDeviceId} onChange={(e) => set('audioInputDeviceId', e.target.value)} className={inputCls}>
              <option value="">跟随系统默认</option>
              {inputs.filter((d) => d.deviceId !== 'default').map((d) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label}{(d.isVirtual || isLoopbackInputDevice(d.label)) ? '（电脑声音）' : ''}
                </option>
              ))}
            </select>
          </div>

          <div className="rounded-xl border border-gray-800 bg-gray-900/50 px-4 divide-y divide-gray-800">
            <Row
              title="回声消除 / 降噪"
              desc={selectedIsRaw ? '当前是回环/虚拟声卡设备，已自动关闭（否则会把对方的声音当回声消掉）。' : '外放 + 麦克风时建议开启；戴耳机可以关闭以获得更清晰的识别。'}
            >
              <Toggle checked={draft.echoCancellation && !selectedIsRaw} onChange={(v) => set('echoCancellation', v)} />
            </Row>
          </div>
        </div>
      )}

      <div className="rounded-xl border border-gray-800 bg-gray-900/50 px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-sm text-gray-100">{draft.audioSource === 'system' ? '测试电脑声音' : '测试麦克风'}</p>
            <p className="mt-0.5 text-xs text-gray-500">
              {busy
                ? '翻译进行中，看字幕条左侧的圆点跳动即可判断有没有收到声音'
                : draft.audioSource === 'system' ? '播放一段视频或会议声音，下面的条应该跟着动' : '说几句话，下面的条应该跟着动'}
            </p>
          </div>
          <button
            type="button"
            disabled={busy && !testing}
            onClick={() => (testing ? stopPreview() : void startPreview())}
            className={`rounded-lg px-3 py-1.5 text-xs font-semibold ${testing ? 'bg-red-600 hover:bg-red-500' : 'bg-gray-700 hover:bg-gray-600'} text-white disabled:opacity-40`}
          >
            {testing ? '停止' : '测试'}
          </button>
        </div>
        <div className="mt-2 h-1.5 rounded-full bg-gray-800 overflow-hidden">
          <div className="h-full rounded-full bg-emerald-400 transition-[width] duration-75" style={{ width: `${Math.round(level * 100)}%` }} />
        </div>
        {deviceError && <p className="mt-2 text-xs text-red-400 whitespace-pre-line">{deviceError}</p>}
      </div>

      <div>
        <p className={labelCls}>环境噪音</p>
        <div className="grid grid-cols-3 gap-2">
          {([
            ['low', '嘈杂', '只收清晰人声'],
            ['medium', '一般', '推荐'],
            ['high', '安静', '小声也能收到'],
          ] as const).map(([id, t, d]) => (
            <button
              key={id}
              type="button"
              onClick={() => set('vadSensitivity', id)}
              className={`rounded-lg border px-3 py-2 text-left ${draft.vadSensitivity === id ? 'border-sky-500 bg-sky-500/10' : 'border-gray-700 hover:border-gray-600'}`}
            >
              <p className="text-sm text-white">{t}</p>
              <p className="text-[11px] text-gray-500">{d}</p>
            </button>
          ))}
        </div>
        <p className="mt-1.5 text-[11px] text-gray-500">噪音（键盘、空调、咳嗽）被误翻译时选「嘈杂」；小声说话收不到时选「安静」。</p>
      </div>
    </div>
  );

  const languageTab = (
    <div className="space-y-5">
      <div className="grid grid-cols-[1fr_auto_1fr] items-end gap-3">
        <div>
          <label htmlFor="lang-a" className={labelCls}>语言 A</label>
          <select id="lang-a" value={draft.langA} onChange={(e) => set('langA', e.target.value)} className={inputCls}>
            {LANGUAGES.map((l) => <option key={l.id} value={l.id} disabled={l.id === draft.langB}>{l.label}</option>)}
          </select>
        </div>
        <button type="button" title="交换" onClick={() => { editedRef.current = true; setDraft((d) => ({ ...d, langA: d.langB, langB: d.langA })); }} className="mb-1 rounded-lg px-2 py-2 text-gray-400 hover:text-white hover:bg-gray-800">⇄</button>
        <div>
          <label htmlFor="lang-b" className={labelCls}>语言 B</label>
          <select id="lang-b" value={draft.langB} onChange={(e) => set('langB', e.target.value)} className={inputCls}>
            {LANGUAGES.map((l) => <option key={l.id} value={l.id} disabled={l.id === draft.langA}>{l.label}</option>)}
          </select>
        </div>
      </div>
      <p className="text-xs text-gray-500 -mt-2">自动识别说的是哪种语言并翻译成另一种。其他语言统一翻译成语言 B。</p>

      <div>
        <label htmlFor="glossary" className={labelCls}>术语表 / 热词（可选）</label>
        <textarea
          id="glossary"
          rows={6}
          value={draft.glossary}
          onChange={(e) => set('glossary', e.target.value)}
          placeholder={'每行一个，例如：\nOpenCSG\n大模型=LLM\n张总=Mr. Zhang\nKubernetes'}
          className={`${inputCls} font-mono text-xs leading-relaxed`}
        />
        <p className="mt-1.5 text-[11px] text-gray-500">人名、公司名、产品名、行业术语写在这里，翻译会固定用这个译法，并帮助纠正识别错字。</p>
      </div>
    </div>
  );

  const displayTab = (
    <div className="rounded-xl border border-gray-800 bg-gray-900/50 px-4 divide-y divide-gray-800">
      <Row title="字号" desc={`${draft.overlayFontSize}px`}>
        <input type="range" min={14} max={40} step={1} value={draft.overlayFontSize} onChange={(e) => set('overlayFontSize', Number(e.target.value))} className="w-40 accent-sky-500" />
      </Row>
      <Row title="背景不透明度" desc={`${Math.round(draft.overlayOpacity * 100)}%`}>
        <input type="range" min={0.2} max={1} step={0.02} value={draft.overlayOpacity} onChange={(e) => set('overlayOpacity', Number(e.target.value))} className="w-40 accent-sky-500" />
      </Row>
      <Row title="显示原文" desc="译文上方显示识别出的原文（小字）">
        <Toggle checked={draft.overlayShowOriginal} onChange={(v) => set('overlayShowOriginal', v)} />
      </Row>
      <Row title="没人说话时自动淡出" desc={draft.overlayAutoHideSec > 0 ? `${draft.overlayAutoHideSec} 秒后淡出，只留一个小圆点；鼠标移上去或有新字幕时自动出现` : '始终显示'}>
        <select value={draft.overlayAutoHideSec} onChange={(e) => set('overlayAutoHideSec', Number(e.target.value))} className="rounded-lg border border-gray-700 bg-gray-950 px-2 py-1.5 text-sm text-white">
          <option value={0}>不淡出</option>
          <option value={4}>4 秒</option>
          <option value={8}>8 秒</option>
          <option value={15}>15 秒</option>
          <option value={30}>30 秒</option>
        </select>
      </Row>
      {isTauriApp() && (
        <Row title="共享屏幕 / 录屏时隐藏" desc="开启后，你在会议里共享屏幕时，对方看不到字幕窗（macOS / Windows 10 2004+）">
          <Toggle checked={draft.overlayHideInScreenShare} onChange={(v) => set('overlayHideInScreenShare', v)} />
        </Row>
      )}
    </div>
  );

  const content = (
    <>
      <nav className="flex-none flex gap-1 border-b border-gray-800 px-3" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={`px-3 py-2.5 text-sm transition-colors border-b-2 -mb-px ${tab === t.id ? 'text-white border-sky-500' : 'text-gray-500 border-transparent hover:text-gray-300'}`}
          >
            {t.label}
          </button>
        ))}
      </nav>
      <div className="flex-1 overflow-y-auto p-5">
        {tab === 'connection' && connectionTab}
        {tab === 'audio' && audioTab}
        {tab === 'language' && languageTab}
        {tab === 'display' && displayTab}
      </div>
      <footer className="flex-none flex items-center justify-end gap-2 px-5 py-3 border-t border-gray-800">
        {dirty && <span className="mr-auto text-xs text-amber-300/80">有未保存的修改</span>}
        {embedded ? (
          dirty && <button type="button" onClick={() => { editedRef.current = false; setDraft(settings); }} className="px-4 py-2 rounded-lg text-sm text-gray-300 hover:bg-gray-800">还原</button>
        ) : (
          <button type="button" onClick={onClose} className="px-4 py-2 rounded-lg text-sm text-gray-300 hover:bg-gray-800">取消</button>
        )}
        <button
          type="button"
          onClick={save}
          disabled={!dirty || draft.langA === draft.langB}
          className="px-5 py-2 rounded-lg bg-sky-600 hover:bg-sky-500 text-white text-sm font-semibold disabled:opacity-40"
        >
          保存
        </button>
      </footer>
    </>
  );

  if (embedded) return <div className="flex flex-col h-full min-h-0">{content}</div>;

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose?.(); }}>
      <div role="dialog" aria-modal="true" aria-label="设置" className="bg-gray-900 border border-gray-700/60 rounded-2xl shadow-2xl w-full max-w-xl max-h-[90vh] flex flex-col">
        {content}
      </div>
    </div>
  );
};

export default LanguageSettings;
