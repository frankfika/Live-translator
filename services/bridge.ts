import { isTauriApp } from './tauri';

/**
 * 跨窗口通信（Tauri 事件）。
 * 悬浮窗（label=main）里跑音频引擎，是唯一的状态源；
 * 控制面板（label=panel）通过事件镜像状态、发命令。
 */

export const EV_STATE = 'interp:state';
export const EV_MESSAGES = 'interp:messages';
export const EV_COMMAND = 'interp:command';
export const EV_SETTINGS = 'interp:settings';

export type BridgeCommand =
  | { type: 'start' }
  | { type: 'stop' }
  | { type: 'toggle' }
  | { type: 'clear' }
  | { type: 'sync' }
  | { type: 'dismiss-error' };

type Unlisten = () => void;

let eventApi: typeof import('@tauri-apps/api/event') | null = null;
const ready: Promise<void> | null = isTauriApp()
  ? import('@tauri-apps/api/event').then((m) => { eventApi = m; })
  : null;

export async function emit(event: string, payload?: unknown): Promise<void> {
  if (!ready) return;
  await ready;
  await eventApi!.emit(event, payload).catch(() => {});
}

/** 返回同步的取消函数；在 listen 完成前取消也安全 */
export function listen<T>(event: string, handler: (payload: T) => void): Unlisten {
  if (!ready) return () => {};
  let un: Unlisten | null = null;
  let cancelled = false;
  void ready.then(() =>
    eventApi!.listen<T>(event, (e) => handler(e.payload)).then((fn) => {
      if (cancelled) fn();
      else un = fn;
    }),
  );
  return () => {
    cancelled = true;
    un?.();
  };
}

export async function invokeSafe<T = void>(cmd: string, args?: Record<string, unknown>): Promise<T | undefined> {
  if (!isTauriApp()) return undefined;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    return await invoke<T>(cmd, args);
  } catch (e) {
    console.warn(`[bridge] ${cmd} failed`, e);
    return undefined;
  }
}

export async function currentWindowLabel(): Promise<string> {
  if (!isTauriApp()) return 'web';
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    return getCurrentWindow().label;
  } catch {
    return 'main';
  }
}
