import React, { useEffect, useRef, useState } from 'react';
import { ConnectionStatus, SubtitleMessage } from '../types';
import type { InterpreterApi } from '../hooks/useInterpreter';
import LanguageSettings, { LANGUAGES, SettingsTab } from './LanguageSettings';
import { findProvider } from '../services/providers';
import { isTauriApp } from '../services/tauri';
import { IconCopy, IconDownload, IconPip, IconPlay, IconStop, IconTrash } from './icons';

/**
 * 控制面板：字幕记录 + 设置。
 * 桌面端是一个按需打开的普通窗口（托盘 / 悬浮窗齿轮），浏览器端是主页面。
 */

interface Props {
  api: InterpreterApi;
  /** 打开悬浮字幕（桌面：显示悬浮窗；浏览器：画中画） */
  onShowOverlay?: () => void;
  overlayLabel?: string;
  overlayHint?: string;
  requestedTab?: { tab: string; nonce: number } | null;
}

const langLabel = (id: string) => LANGUAGES.find((l) => l.id === id)?.label ?? id;
const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform || navigator.userAgent);
const MOD = isMac ? '⇧⌘' : 'Ctrl+Shift+';
// 浏览器里没有全局快捷键，用空格
const START_KEY = isTauriApp() ? `${MOD}R` : '空格';

function fmtTime(ts: number) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function copyText(text: string) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
  fallbackCopy(text);
  return Promise.resolve();
}
function fallbackCopy(text: string) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); } catch { /* noop */ }
  document.body.removeChild(ta);
}

function exportTranscript(messages: SubtitleMessage[], langA: string, langB: string) {
  const lines = messages.map((m) => `[${fmtTime(m.timestamp)}]\n${m.original}\n${m.translated}`);
  const content = `AI 同声传译记录（${langA} ⇄ ${langB}）\n${new Date().toLocaleString()}\n${'='.repeat(40)}\n\n${lines.join('\n\n')}\n`;
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `同传记录-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.txt`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const MessageRow: React.FC<{ m: { original: string; translated: string; timestamp?: number }; live?: boolean }> = React.memo(({ m, live }) => {
  const [copied, setCopied] = useState(false);
  return (
    <div className={`group relative rounded-xl px-4 py-3 ${live ? 'bg-sky-500/5 ring-1 ring-sky-500/20' : 'hover:bg-white/[0.03]'}`}>
      <div className="flex items-center gap-2 text-[11px] text-gray-600 mb-1">
        <span className="font-mono tabular-nums">{m.timestamp ? fmtTime(m.timestamp) : '实时'}</span>
        {!live && (
          <button
            className="ml-auto opacity-0 group-hover:opacity-100 focus:opacity-100 flex items-center gap-1 text-gray-500 hover:text-gray-200 transition-opacity"
            onClick={() => void copyText(`${m.original}\n${m.translated}`).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); })}
          >
            <IconCopy size={12} /> {copied ? '已复制' : '复制'}
          </button>
        )}
      </div>
      {m.original && <p className="text-sm text-gray-400 leading-relaxed">{m.original}</p>}
      <p className="text-base text-gray-50 leading-relaxed font-medium mt-0.5">
        {m.translated || (live ? <span className="text-gray-500 font-normal">翻译中…</span> : '')}
      </p>
    </div>
  );
});
MessageRow.displayName = 'MessageRow';

const Panel: React.FC<Props> = ({ api, onShowOverlay, overlayLabel = '悬浮字幕', overlayHint, requestedTab }) => {
  const { state, messages, settings, hasApiKey } = api;
  const [view, setView] = useState<'history' | 'settings'>(hasApiKey ? 'history' : 'settings');
  const [settingsTab, setSettingsTab] = useState<SettingsTab | undefined>(undefined);
  const listRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);

  // 设置异步加载完成后再决定首屏：没 Key 去配置，有 Key 看记录
  useEffect(() => {
    if (!api.ready) return;
    if (hasApiKey) setView('history');
    else { setView('settings'); setSettingsTab('connection'); }
  }, [api.ready]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!requestedTab) return;
    if (requestedTab.tab === 'history') { setView('history'); return; }
    setView('settings');
    setSettingsTab(requestedTab.tab as SettingsTab);
  }, [requestedTab]);

  useEffect(() => {
    const el = listRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [messages, state.live, view]);

  const running = state.status === ConnectionStatus.CONNECTED || state.status === ConnectionStatus.CONNECTING;
  const provider = findProvider(settings.providerId);

  const statusText = (() => {
    if (state.status === ConnectionStatus.ERROR) return '出错';
    if (state.status === ConnectionStatus.CONNECTING) return '启动中';
    if (!running) return '未开始';
    if (state.phase === 'processing') return '翻译中';
    if (state.phase === 'speaking') return '有人说话';
    return '聆听中';
  })();
  const dotCls = state.status === ConnectionStatus.ERROR ? 'bg-red-500' : running ? (state.phase === 'processing' ? 'bg-amber-400' : 'bg-emerald-400') : 'bg-gray-500';

  return (
    <div className="fixed inset-0 flex flex-col bg-[#0b0d12] text-gray-100">
      {/* 顶栏 */}
      <header className="flex-none flex items-center gap-4 px-5 py-3 border-b border-gray-800/80">
        <div className="flex items-center gap-2.5 min-w-0">
          <span className={`w-2 h-2 rounded-full ${dotCls}`} />
          <div className="min-w-0">
            <p className="text-sm font-semibold">AI 同声传译 <span className="ml-1 text-xs font-normal text-gray-500">{statusText}</span></p>
            <p className="text-xs text-gray-500 truncate">
              {langLabel(settings.langA)} ⇄ {langLabel(settings.langB)} · {settings.audioSource === 'system' ? '电脑声音' : '麦克风'}
              {state.sourceLabel && running ? `（${state.sourceLabel}）` : ''} · {provider.displayName}
            </p>
          </div>
        </div>
        <div className="flex-1" />
        <nav className="flex rounded-lg bg-gray-900 p-0.5 text-sm">
          {(['history', 'settings'] as const).map((v) => (
            <button key={v} onClick={() => setView(v)} className={`px-3 py-1.5 rounded-md ${view === v ? 'bg-gray-700 text-white' : 'text-gray-400 hover:text-gray-200'}`}>
              {v === 'history' ? `记录${messages.length ? ` ${messages.length}` : ''}` : '设置'}
            </button>
          ))}
        </nav>
        {onShowOverlay && (
          <button onClick={onShowOverlay} title={overlayHint} className="flex items-center gap-1.5 rounded-lg border border-gray-700 px-3 py-1.5 text-sm text-gray-200 hover:bg-gray-800">
            <IconPip size={14} /> {overlayLabel}
          </button>
        )}
        <button
          onClick={hasApiKey || running ? api.toggle : () => { setView('settings'); setSettingsTab('connection'); }}
          className={`flex items-center gap-1.5 rounded-lg px-4 py-1.5 text-sm font-semibold ${running ? 'bg-red-600 hover:bg-red-500' : 'bg-sky-600 hover:bg-sky-500'} text-white`}
        >
          {running ? <><IconStop size={12} /> 停止</> : <><IconPlay size={12} /> 开始</>}
        </button>
      </header>

      {state.error && (
        <div className="flex-none mx-5 mt-3 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 flex items-start gap-3">
          <p className="flex-1 text-sm text-red-200 whitespace-pre-line leading-relaxed">{state.error}</p>
          {state.errorTab && (
            <button className="text-xs text-red-200 underline" onClick={() => { setView('settings'); setSettingsTab(state.errorTab!); }}>去设置</button>
          )}
          <button className="text-xs text-red-200/70 hover:text-white" onClick={api.dismissError}>关闭</button>
        </div>
      )}

      {view === 'history' ? (
        <>
          <div
            ref={listRef}
            onScroll={(e) => {
              const el = e.currentTarget;
              stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
            }}
            className="flex-1 overflow-y-auto px-3 py-3"
          >
            {messages.length === 0 && !state.live ? (
              <div className="h-full flex flex-col items-center justify-center text-center px-6">
                <p className="text-lg font-semibold text-gray-200">{running ? '正在聆听…' : '准备好了'}</p>
                <p className="mt-2 text-sm text-gray-500 max-w-md leading-relaxed">
                  {running
                    ? '有人说话时，字幕会实时出现在屏幕底部的悬浮条上，这里保留完整记录。'
                    : <>点「开始」或按 <kbd className="px-1.5 py-0.5 rounded bg-gray-800 text-gray-300 text-xs">{START_KEY}</kbd>。{isTauriApp() ? '翻译会显示在屏幕底部的悬浮字幕条上，不需要一直开着这个窗口。' : '点「悬浮字幕」可以弹出一个置顶小窗，切到会议标签页也能看到字幕。'}</>}
                </p>
              </div>
            ) : (
              <div className="max-w-3xl mx-auto space-y-1">
                {messages.map((m) => <MessageRow key={m.id} m={m} />)}
                {state.live && <MessageRow m={state.live} live />}
              </div>
            )}
          </div>
          {messages.length > 0 && (
            <footer className="flex-none flex items-center gap-2 px-5 py-2.5 border-t border-gray-800/80 text-sm">
              <span className="text-xs text-gray-500">{messages.length} 条</span>
              <div className="flex-1" />
              <button className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-gray-300 hover:bg-gray-800" onClick={() => exportTranscript(messages, settings.langA, settings.langB)}>
                <IconDownload size={14} /> 导出
              </button>
              <button className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-gray-400 hover:text-red-300 hover:bg-gray-800" onClick={() => { if (confirm('清空当前记录？')) api.clear(); }}>
                <IconTrash size={14} /> 清空
              </button>
            </footer>
          )}
        </>
      ) : (
        <div className="flex-1 min-h-0 max-w-2xl w-full mx-auto">
          <LanguageSettings
            embedded
            settings={settings}
            initialTab={settingsTab}
            busy={running}
            onSave={(next) => { api.updateSettings(next); }}
          />
        </div>
      )}
    </div>
  );
};

export default Panel;
