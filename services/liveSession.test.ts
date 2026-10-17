import { describe, it, expect, vi } from 'vitest';
import { LiveSession, LiveCallbacks } from './liveSession';
import type { Provider, ProviderConfig, TranslateRequest } from './providers';

const RATE = 16000;
const FRAME = 800;
const cfg: ProviderConfig = { apiKey: 'sk-0123456789abcdefghijkl', baseUrl: 'https://x', asrModel: 'a', llmModel: 'b' };

function fakeProvider(asr: string[], translate: (req: TranslateRequest) => Promise<void>): Provider & { calls: TranslateRequest[] } {
  const calls: TranslateRequest[] = [];
  return {
    id: 'fake', displayName: 'Fake', description: '', defaultBaseUrl: '', defaultAsrModel: 'a', defaultLlmModel: 'b', keyUrl: '',
    validateConfig: () => null,
    transcribe: vi.fn(async () => asr.shift() ?? ''),
    translate: async (req) => { calls.push(req); await translate(req); },
    calls,
  };
}

function speak(session: LiveSession, ms: number, amp: number) {
  for (let t = 0; t < ms; t += (FRAME / RATE) * 1000) {
    const f = new Float32Array(FRAME);
    for (let i = 0; i < FRAME; i++) f[i] = amp ? Math.sin(i * 0.3) * amp : (Math.random() - 0.5) * 0.002;
    session.feed(f);
  }
}

function callbacks(over: Partial<LiveCallbacks> = {}): LiveCallbacks & { done: [string, string][]; warnings: string[]; errors: string[] } {
  const done: [string, string][] = [];
  const warnings: string[] = [];
  const errors: string[] = [];
  return {
    onOpen: () => {}, onClose: () => {},
    onError: (e) => errors.push(e.message),
    onWarning: (m) => warnings.push(m),
    onTurnComplete: (_id, o, t) => done.push([o, t]),
    ...over,
    done, warnings, errors,
  };
}

const flush = () => new Promise((r) => setTimeout(r, 20));

describe('LiveSession pipeline', () => {
  it('transcribes, translates with history, and completes turns in order', async () => {
    const p = fakeProvider(['你好', '我们开始开会吧'], async (req) => req.onChunk(`T(${req.text})`));
    const s = new LiveSession({ provider: p, providerConfig: cfg, systemInstruction: 'sys' });
    const cb = callbacks();
    s.attachPcm(cb, RATE);
    for (const _ of [0, 1]) {
      speak(s, 600, 0);
      speak(s, 1200, 0.3);
      speak(s, 1000, 0);
      await flush();
    }
    expect(cb.done).toEqual([['你好', 'T(你好)'], ['我们开始开会吧', 'T(我们开始开会吧)']]);
    // 第二句带上了第一句作为上下文
    expect(p.calls[1].history).toEqual([
      { role: 'user', content: '你好' },
      { role: 'assistant', content: 'T(你好)' },
    ]);
    await s.disconnect();
  });

  it('drops hallucinated / filler ASR output without calling the LLM', async () => {
    const p = fakeProvider(['<|zh|>谢谢观看', '嗯'], async () => {});
    const s = new LiveSession({ provider: p, providerConfig: cfg, systemInstruction: 'sys' });
    let discards = 0;
    const cb = callbacks({ onDiscard: () => { discards++; } });
    s.attachPcm(cb, RATE);
    for (const _ of [0, 1]) {
      speak(s, 600, 0);
      speak(s, 1000, 0.3);
      speak(s, 1000, 0);
      await flush();
    }
    expect(p.calls).toHaveLength(0);
    expect(cb.done).toHaveLength(0);
    expect(discards).toBe(2);
  });

  it('treats [SKIP] as noise and transient network errors as warnings', async () => {
    let n = 0;
    const p = fakeProvider(['啊这个这个', '真正的内容', '第三句'], async (req) => {
      n++;
      if (n === 1) { req.onChunk('[SK'); req.onChunk('IP]'); return; }
      if (n === 2) throw new Error('LLM 失败 (HTTP 503): busy');
      req.onChunk('Third');
    });
    const s = new LiveSession({ provider: p, providerConfig: cfg, systemInstruction: 'sys' });
    const shown: string[] = [];
    const cb = callbacks({ onTranslation: (_id, t) => shown.push(t) });
    s.attachPcm(cb, RATE);
    for (const _ of [0, 1, 2]) {
      speak(s, 600, 0);
      speak(s, 1000, 0.3);
      speak(s, 1000, 0);
      await flush();
    }
    expect(shown.some((t) => t.includes('SK'))).toBe(false);
    expect(cb.warnings).toHaveLength(1);
    expect(cb.errors).toHaveLength(0);
    expect(cb.done).toEqual([['第三句', 'Third']]);
    await s.disconnect();
  });

  it('stops the session on auth errors', async () => {
    const p = fakeProvider([], async () => {});
    p.transcribe = vi.fn(async () => { throw new Error('SiliconFlow ASR 失败 (HTTP 401): bad key'); });
    const s = new LiveSession({ provider: p, providerConfig: cfg, systemInstruction: 'sys' });
    const cb = callbacks();
    s.attachPcm(cb, RATE);
    speak(s, 600, 0);
    speak(s, 1000, 0.3);
    speak(s, 1000, 0);
    await flush();
    expect(cb.errors[0]).toMatch(/API Key/);
    expect(s.isConnected).toBe(false);
  });
});
