import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useInterpreter } from './hooks/useInterpreter';
import { useRemoteInterpreter } from './hooks/useRemoteInterpreter';
import Overlay from './components/Overlay';
import Panel from './components/Panel';
import { isTauriApp } from './services/tauri';
import * as bridge from './services/bridge';

/**
 * 三种运行形态：
 * - 桌面端 main 窗口：透明置顶的悬浮字幕条，同时承载音频引擎
 * - 桌面端 panel 窗口：设置 + 完整记录，按需打开
 * - 浏览器：控制页 + 画中画（Document Picture-in-Picture）悬浮字幕，切到会议标签页也能看到
 */
const App: React.FC = () => {
  const [label, setLabel] = useState<string | null>(isTauriApp() ? null : 'web');
  useEffect(() => {
    if (isTauriApp()) void bridge.currentWindowLabel().then(setLabel);
  }, []);

  if (label === null) return null;
  if (label === 'panel') return <DesktopPanel />;
  if (label === 'web') return <WebApp />;
  return <DesktopOverlay />;
};

// ─────────────────────────────────────────────────────────────────────

async function currentWindow() {
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  return getCurrentWindow();
}

const DesktopOverlay: React.FC = () => {
  const api = useInterpreter();
  const [clickThrough, setClickThrough] = useState(false);
  const lastHeight = useRef(0);

  useEffect(() => {
    document.documentElement.classList.add('overlay-mode');
    void bridge.invokeSafe<boolean>('get_click_through').then((v) => setClickThrough(!!v));
    return bridge.listen<boolean>('click-through-changed', setClickThrough);
  }, []);

  useEffect(() => {
    if (!api.ready) return;
    void bridge.invokeSafe('set_hide_in_screen_share', { enabled: api.settings.overlayHideInScreenShare });
  }, [api.ready, api.settings.overlayHideInScreenShare]);

  const onHeight = useCallback((h: number) => {
    const height = h + 8; // 外层 padding
    if (Math.abs(height - lastHeight.current) < 2) return;
    lastHeight.current = height;
    void bridge.invokeSafe('resize_overlay', { height });
  }, []);

  if (!api.ready) return null;

  return (
    <div className="p-1">
      <Overlay
        api={api}
        env="desktop"
        clickThrough={clickThrough}
        onToggleClickThrough={() => void bridge.invokeSafe('set_click_through', { enabled: !clickThrough })}
        onOpenPanel={(tab) => void bridge.invokeSafe('open_panel', { tab: tab ?? null })}
        onHide={() => void bridge.invokeSafe('hide_overlay')}
        onDragStart={() => void currentWindow().then((w) => w.startDragging())}
        onResizeStart={(dir) => void currentWindow().then((w) => w.startResizeDragging(dir))}
        onHeight={onHeight}
      />
    </div>
  );
};

const DesktopPanel: React.FC = () => {
  const api = useRemoteInterpreter();
  const [requestedTab, setRequestedTab] = useState<{ tab: string; nonce: number } | null>(null);

  useEffect(() => bridge.listen<string>('panel-tab', (tab) => setRequestedTab({ tab, nonce: Date.now() })), []);

  return (
    <Panel
      api={api}
      requestedTab={requestedTab}
      onShowOverlay={() => void bridge.invokeSafe('show_overlay')}
      overlayLabel="显示字幕条"
    />
  );
};

// ─────────────────────────────────────────────────────────────────────

interface DocumentPip {
  requestWindow: (opts: { width: number; height: number }) => Promise<Window>;
  window: Window | null;
}
const getDocumentPip = (): DocumentPip | undefined => (window as unknown as { documentPictureInPicture?: DocumentPip }).documentPictureInPicture;

/** 把当前页面的样式复制进画中画窗口（开发模式是 <style>，生产是 <link>） */
function copyStyles(target: Document) {
  document.querySelectorAll('style, link[rel="stylesheet"]').forEach((node) => {
    target.head.appendChild(node.cloneNode(true));
  });
  target.documentElement.classList.add('pip-mode');
}

const WebApp: React.FC = () => {
  const api = useInterpreter();
  const [pipWin, setPipWin] = useState<Window | null>(null);
  const [inlineOverlay, setInlineOverlay] = useState(false);
  const pipSupported = !!getDocumentPip();

  const openOverlay = useCallback(async () => {
    const dpip = getDocumentPip();
    if (!dpip) { setInlineOverlay((v) => !v); return; }
    if (pipWin) { pipWin.close(); return; }
    try {
      const w = await dpip.requestWindow({ width: 760, height: 150 });
      copyStyles(w.document);
      w.document.title = 'AI 同传字幕';
      w.addEventListener('pagehide', () => setPipWin(null));
      setPipWin(w);
    } catch (e) {
      console.warn('PiP failed', e);
      setInlineOverlay(true);
    }
  }, [pipWin]);

  // 空格开始/停止
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (e.target as HTMLElement).isContentEditable) return;
      if (e.code === 'Space') { e.preventDefault(); api.toggle(); }
    };
    document.addEventListener('keydown', h);
    return () => document.removeEventListener('keydown', h);
  }, [api.toggle]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <Panel
        api={api}
        onShowOverlay={() => void openOverlay()}
        overlayLabel={pipWin ? '关闭悬浮字幕' : '悬浮字幕'}
        overlayHint={pipSupported ? '弹出一个始终置顶的小窗口，切到会议标签页或其他软件时也能看到字幕' : '当前浏览器不支持画中画，将在页面底部显示字幕条'}
      />
      {pipWin && createPortal(
        <div className="p-1 min-h-full flex flex-col justify-end">
          <Overlay api={api} env="pip" onOpenPanel={() => window.focus()} onHide={() => pipWin.close()} />
        </div>,
        pipWin.document.body,
      )}
      {!pipWin && inlineOverlay && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 w-[min(860px,calc(100vw-32px))] z-50">
          <Overlay api={api} env="inline" onOpenPanel={() => {}} onHide={() => setInlineOverlay(false)} />
        </div>
      )}
    </>
  );
};

export default App;
