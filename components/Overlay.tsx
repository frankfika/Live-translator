import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ConnectionStatus, SubtitleMessage } from '../types';
import type { InterpreterApi, LiveLine } from '../hooks/useInterpreter';
import { IconClose, IconLock, IconMic, IconPlay, IconSettings, IconSpeaker, IconStop, IconText } from './icons';

/**
 * 悬浮字幕条。设计目标是"存在感最低"：
 * - 没人说话时自动淡出到几乎透明，只留一个小点；鼠标移上来或有新字幕立刻出现
 * - 控件只在鼠标悬停时出现
 * - 可锁定为鼠标穿透（不挡会议软件的按钮），⇧⌘L 解锁
 * - 桌面端默认在屏幕共享 / 录屏中不可见
 *
 * 同一个组件用于：桌面悬浮窗、浏览器画中画窗口、浏览器页内底部条。
 */

export interface OverlayProps {
  api: InterpreterApi;
  env: 'desktop' | 'pip' | 'inline';
  onOpenPanel: (tab?: string) => void;
  onHide?: () => void;
  clickThrough?: boolean;
  onToggleClickThrough?: () => void;
  onDragStart?: () => void;
  onResizeStart?: (dir: 'East' | 'West') => void;
  /** 内容高度变化（桌面端据此调整窗口高度，避免透明区域挡住下面的点击） */
  onHeight?: (height: number) => void;
}

const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform || navigator.userAgent);
const MOD = isMac ? '⇧⌘' : 'Ctrl+Shift+';

const LANG_SHORT: Record<string, string> = {
  English: '英', Chinese: '中', Japanese: '日', Korean: '韩', French: '法', German: '德', Spanish: '西',
  Russian: '俄', Portuguese: '葡', Italian: '意', Hindi: '印', Arabic: '阿', Turkish: '土', Vietnamese: '越',
};

const Overlay: React.FC<OverlayProps> = ({
  api, env, onOpenPanel, onHide, clickThrough, onToggleClickThrough, onDragStart, onResizeStart, onHeight,
}) => {
  const { state, messages, settings, hasApiKey } = api;
  const [hover, setHover] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const rootRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLDivElement>(null);

  // 锁定后鼠标事件不再进来，mouseleave 也收不到，手动复位 hover
  useEffect(() => { if (clickThrough) setHover(false); }, [clickThrough]);

  const running = state.status === ConnectionStatus.CONNECTED || state.status === ConnectionStatus.CONNECTING;
  const hideAfter = settings.overlayAutoHideSec * 1000;

  // 自动淡出计时
  useEffect(() => {
    if (!running || hideAfter <= 0) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running, hideAfter]);

  const idle = running && hideAfter > 0 && !state.live && !state.error && !state.warning && now - state.lastActivity > hideAfter;
  const faded = idle && !hover;

  // 窗口高度跟随内容
  useLayoutEffect(() => {
    if (!onHeight || !rootRef.current) return;
    const el = rootRef.current;
    const ro = new ResizeObserver(() => onHeight(Math.ceil(el.getBoundingClientRect().height)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [onHeight]);

  // 新字幕时滚到底（长句超过 3 行时）
  useEffect(() => {
    const el = textRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [state.live, messages.length]);

  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0 || !onDragStart) return;
    if ((e.target as HTMLElement).closest('button, a, input, [data-no-drag]')) return;
    onDragStart();
  };

  const fs = settings.overlayFontSize;
  const bg = `rgba(12, 14, 20, ${faded ? 0 : settings.overlayOpacity})`;

  // 要显示的行：正在翻译的一句 + 上一句（淡一点）
  const blocks: { key: string; line: LiveLine | SubtitleMessage; current: boolean }[] = [];
  if (state.live) {
    const prev = messages[messages.length - 1];
    if (prev) blocks.push({ key: prev.id, line: prev, current: false });
    blocks.push({ key: state.live.id, line: state.live, current: true });
  } else {
    messages.slice(-2).forEach((m, i, arr) => blocks.push({ key: m.id, line: m, current: i === arr.length - 1 }));
  }

  const dot = (() => {
    if (state.status === ConnectionStatus.ERROR) return 'bg-red-500';
    if (state.status === ConnectionStatus.CONNECTING) return 'bg-amber-400 animate-pulse';
    if (!running) return 'bg-gray-500';
    if (state.phase === 'processing') return 'bg-amber-400';
    if (state.phase === 'speaking') return 'bg-sky-400';
    return 'bg-emerald-400';
  })();

  const pair = `${LANG_SHORT[settings.langA] ?? settings.langA} ⇄ ${LANG_SHORT[settings.langB] ?? settings.langB}`;

  const btn = 'ov-btn flex items-center justify-center w-7 h-7 rounded-md text-white/70 hover:text-white hover:bg-white/15 transition-colors';

  const toolbar = (
    <div
      className={`absolute top-1.5 right-1.5 flex items-center gap-0.5 rounded-lg px-1 py-0.5 transition-opacity duration-150 ${hover ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
      style={{ background: 'rgba(30,32,40,0.92)' }}
    >
      <button className={btn} title={running ? `停止 (${MOD}R)` : `开始 (${MOD}R)`} onClick={api.toggle}>
        {running ? <IconStop size={13} /> : <IconPlay size={13} />}
      </button>
      <button
        className={btn}
        title={settings.audioSource === 'system' ? '当前：电脑声音（会议 / 视频）· 点击切到麦克风' : '当前：麦克风 · 点击切到电脑声音（会议 / 视频）'}
        onClick={() => api.updateSettings({ audioSource: settings.audioSource === 'system' ? 'microphone' : 'system' })}
      >
        {settings.audioSource === 'system' ? <IconSpeaker size={14} /> : <IconMic size={14} />}
      </button>
      <button
        className={`${btn} ${settings.overlayShowOriginal ? '' : 'opacity-50'}`}
        title={settings.overlayShowOriginal ? '隐藏原文' : '显示原文'}
        onClick={() => api.updateSettings({ overlayShowOriginal: !settings.overlayShowOriginal })}
      >
        <IconText size={14} />
      </button>
      <button className={`${btn} text-[11px] font-bold`} title="字号减小" onClick={() => api.updateSettings({ overlayFontSize: fs - 2 })}>A-</button>
      <button className={`${btn} text-[13px] font-bold`} title="字号增大" onClick={() => api.updateSettings({ overlayFontSize: fs + 2 })}>A+</button>
      {onToggleClickThrough && (
        <button className={btn} title={`锁定：鼠标穿透，不挡下面的窗口（${MOD}L 解锁）`} onClick={onToggleClickThrough}>
          <IconLock size={13} />
        </button>
      )}
      <button className={btn} title="设置与记录" onClick={() => onOpenPanel()}>
        <IconSettings size={14} />
      </button>
      {onHide && (
        <button className={btn} title={`隐藏（${MOD}S 再次显示）`} onClick={onHide}>
          <IconClose size={14} />
        </button>
      )}
    </div>
  );

  let body: React.ReactNode;
  if (state.error) {
    body = (
      <div className="flex items-start gap-3 pr-2">
        <div className="flex-1 min-w-0 text-[13px] leading-relaxed text-red-200 whitespace-pre-line">{state.error}</div>
        <div className="flex flex-none gap-1.5 pt-0.5">
          <button className="ov-chip bg-white/10 hover:bg-white/20" onClick={() => { api.dismissError(); api.start(); }}>重试</button>
          <button className="ov-chip bg-white/10 hover:bg-white/20" onClick={() => onOpenPanel(state.errorTab ?? undefined)}>设置</button>
          <button className="ov-chip text-white/60 hover:text-white" onClick={api.dismissError}>✕</button>
        </div>
      </div>
    );
  } else if (!running) {
    body = (
      <div className="flex items-center gap-2 -mr-2 min-h-[28px]">
        <span className="text-[13px] text-white/60 truncate">AI 同传 · {pair}</span>
        <span className="flex-1" />
        {hasApiKey ? (
          <button className="ov-chip bg-sky-500/90 hover:bg-sky-400 text-white flex items-center gap-1.5" onClick={api.start}>
            <IconPlay size={11} /> 开始 <span className="text-white/70 font-normal">{MOD}R</span>
          </button>
        ) : (
          <button className="ov-chip bg-amber-400 hover:bg-amber-300 text-gray-900" onClick={() => onOpenPanel('connection')}>
            先配置 API Key →
          </button>
        )}
        <button className={btn} title="设置与记录" onClick={() => onOpenPanel()}><IconSettings size={14} /></button>
        {onHide && <button className={btn} title={`隐藏（${MOD}S 再次显示）`} onClick={onHide}><IconClose size={14} /></button>}
      </div>
    );
  } else if (blocks.length === 0) {
    body = (
      <div className="text-[13px] text-white/50 min-h-[28px] flex items-center">
        {state.status === ConnectionStatus.CONNECTING ? '正在启动…' : `正在聆听${state.sourceLabel ? ` · ${state.sourceLabel}` : ''}`}
      </div>
    );
  } else {
    body = (
      <div ref={textRef} className="ov-scroll overflow-y-auto pr-1" style={{ maxHeight: fs * 1.45 * 4 + fs * 0.62 * 1.4 * 2 + 16 }}>
        {blocks.map(({ key, line, current }) => {
          const translated = line.translated;
          const original = line.original;
          return (
            <div key={key} className={`transition-opacity duration-300 ${current ? '' : 'opacity-45'} ${current ? '' : 'mb-1'}`}>
              {settings.overlayShowOriginal && original && (
                <div className="text-white/55 leading-snug" style={{ fontSize: Math.round(fs * (current ? 0.64 : 0.58)) }}>
                  {original}
                </div>
              )}
              <div
                className="font-semibold leading-snug text-white"
                style={{ fontSize: current ? fs : Math.round(fs * 0.78), textShadow: '0 1px 2px rgba(0,0,0,0.6)' }}
              >
                {translated || (current ? <span className="text-white/40 font-normal ov-dots">翻译中</span> : '')}
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <div
      ref={rootRef}
      className={`ov-root select-none ${env === 'inline' ? '' : 'w-full'}`}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <div
        className="relative rounded-2xl transition-[background-color,box-shadow,opacity] duration-500"
        style={{
          background: bg,
          backdropFilter: faded ? 'none' : 'blur(14px)',
          WebkitBackdropFilter: faded ? 'none' : 'blur(14px)',
          boxShadow: faded ? 'none' : '0 6px 24px rgba(0,0,0,0.28)',
          cursor: onDragStart ? 'grab' : undefined,
        }}
        onMouseDown={handleMouseDown}
      >
        {/* 状态点 + 电平 */}
        <div className={`absolute left-3 flex items-center justify-center w-3 h-3 ${faded ? 'top-[3px] opacity-60' : 'top-1/2 -translate-y-1/2'}`} title={state.sourceLabel || undefined}>
          <span
            className={`block rounded-full ${dot}`}
            style={{ width: 7, height: 7, transform: `scale(${running ? 1 + state.level * 0.9 : 1})`, transition: 'transform 80ms linear' }}
          />
        </div>

        {/* 淡出时整体收成一条细线：透明区域也会拦截点击，收起来才不挡会议软件底部的按钮 */}
        {faded ? (
          <div className="h-[18px]" />
        ) : (
          <div className="pl-8 pr-4 py-2.5">
            {body}
            {state.warning && !state.error && (
              <div className="mt-1 text-[11px] text-amber-200/90">{state.warning}</div>
            )}
          </div>
        )}

        {!faded && running && !state.error && toolbar}

        {/* 左右边缘拖动改宽度（桌面端） */}
        {onResizeStart && (
          <>
            <div data-no-drag className="absolute left-0 top-0 bottom-0 w-1.5 cursor-ew-resize" onMouseDown={(e) => { e.stopPropagation(); onResizeStart('West'); }} />
            <div data-no-drag className="absolute right-0 top-0 bottom-0 w-1.5 cursor-ew-resize" onMouseDown={(e) => { e.stopPropagation(); onResizeStart('East'); }} />
          </>
        )}
      </div>
    </div>
  );
};

export default Overlay;
