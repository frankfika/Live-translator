import { useCallback, useEffect, useMemo, useState } from 'react';
import { SubtitleMessage } from '../types';
import { AppSettings, DEFAULT_SETTINGS, loadSettings, saveSettings, normalizeSettings } from '../services/settings';
import * as bridge from '../services/bridge';
import { InterpreterApi, InterpreterState, INITIAL_STATE, effectiveApiKey } from './useInterpreter';

/**
 * 控制面板窗口用：镜像悬浮窗里引擎的状态，命令通过事件转发。
 * 接口跟 useInterpreter 一致，Panel 组件不用关心自己在哪个窗口。
 */
export function useRemoteInterpreter(): InterpreterApi {
  const [ready, setReady] = useState(false);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [state, setState] = useState<InterpreterState>(INITIAL_STATE);
  const [messages, setMessages] = useState<SubtitleMessage[]>([]);

  useEffect(() => {
    const offState = bridge.listen<InterpreterState>(bridge.EV_STATE, setState);
    const offMsgs = bridge.listen<SubtitleMessage[]>(bridge.EV_MESSAGES, setMessages);
    const offSettings = bridge.listen<AppSettings>(bridge.EV_SETTINGS, (s) => setSettings(normalizeSettings(s)));
    void loadSettings().then((s) => { setSettings(s); setReady(true); });
    void bridge.emit(bridge.EV_COMMAND, { type: 'sync' });
    // 面板每次被重新显示时再同步一次
    const onFocus = () => void bridge.emit(bridge.EV_COMMAND, { type: 'sync' });
    window.addEventListener('focus', onFocus);
    return () => { offState(); offMsgs(); offSettings(); window.removeEventListener('focus', onFocus); };
  }, []);

  const send = useCallback((cmd: bridge.BridgeCommand) => void bridge.emit(bridge.EV_COMMAND, cmd), []);

  const updateSettings = useCallback((p: Partial<AppSettings>) => {
    setSettings((prev) => {
      const next = normalizeSettings({ ...prev, ...p });
      void saveSettings(next, prev).then(() => bridge.emit(bridge.EV_SETTINGS, next));
      return next;
    });
  }, []);

  return useMemo(() => ({
    ready, state, messages, settings,
    hasApiKey: Boolean(effectiveApiKey(settings)),
    start: () => send({ type: 'start' }),
    stop: () => send({ type: 'stop' }),
    toggle: () => send({ type: 'toggle' }),
    clear: () => send({ type: 'clear' }),
    dismissError: () => send({ type: 'dismiss-error' }),
    updateSettings,
  }), [ready, state, messages, settings, send, updateSettings]);
}
