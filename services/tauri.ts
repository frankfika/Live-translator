import { invoke } from '@tauri-apps/api/core';

// ============ 设置管理 ============

export async function getSetting(key: string): Promise<string | null> {
  try {
    return await invoke('get_setting', { key });
  } catch (error) {
    console.error('Failed to get setting:', error);
    return null;
  }
}

export async function setSetting(key: string, value: string): Promise<void> {
  try {
    await invoke('set_setting', { key, value });
  } catch (error) {
    console.error('Failed to set setting:', error);
    throw error;
  }
}

export async function getAllSettings(): Promise<Record<string, string>> {
  try {
    const settings = await invoke<Array<[string, string]>>('get_all_settings');
    return Object.fromEntries(settings);
  } catch (error) {
    console.error('Failed to get all settings:', error);
    return {};
  }
}

// ============ 转录记录管理 ============

export interface TranscriptRecord {
  id?: number;
  sessionId: string;
  original: string;
  translated: string;
  sourceLang: string;
  targetLang: string;
  timestamp: number;
  createdAt?: number;
}

export async function saveTranscript(
  sessionId: string,
  original: string,
  translated: string,
  sourceLang: string,
  targetLang: string
): Promise<number> {
  try {
    return await invoke('save_transcript', {
      sessionId,
      original,
      translated,
      sourceLang,
      targetLang,
    });
  } catch (error) {
    console.error('Failed to save transcript:', error);
    throw error;
  }
}

export async function getSessionTranscripts(sessionId: string): Promise<TranscriptRecord[]> {
  try {
    return await invoke('get_session_transcripts', { sessionId });
  } catch (error) {
    console.error('Failed to get session transcripts:', error);
    return [];
  }
}

export async function exportSession(sessionId: string): Promise<string> {
  try {
    return await invoke('export_session', { sessionId });
  } catch (error) {
    console.error('Failed to export session:', error);
    throw error;
  }
}

// ============ 环境检测 ============

export function isTauriApp(): boolean {
  return '__TAURI__' in window;
}
