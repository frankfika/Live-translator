import { describe, it, expect, vi } from 'vitest';
import { PROVIDERS, findProvider, buildProviderConfig, defaultProviderConfig } from './registry';
import {
  SiliconFlowProvider,
  stripTrailingSlash,
  asHttpError,
  apiKeyLooksValid,
  streamChatCompletion,
} from './siliconflow';
import { DashScopeProvider, rewriteDashScopeBaseUrl } from './dashscope';
import { ZhipuProvider } from './zhipu';
import { CustomProvider } from './custom';

const REAL_KEY = 'sk-real-key-1234567890abcdef'; // 30+ chars, passes placeholder check

// ── Registry / builders ─────────────────────────────────────────────

describe('Provider registry', () => {
  it('exposes the four expected presets in order', () => {
    const ids = PROVIDERS.map((p) => p.id);
    expect(ids).toEqual(['siliconflow', 'dashscope', 'zhipu', 'custom']);
  });

  it('findProvider returns matching provider or falls back to first', () => {
    expect(findProvider('dashscope').id).toBe('dashscope');
    expect(findProvider('nope-not-real').id).toBe('siliconflow');
  });

  it('defaultProviderConfig fills in defaults', () => {
    const p = findProvider('siliconflow');
    const cfg = defaultProviderConfig(p);
    expect(cfg.baseUrl).toBe(p.defaultBaseUrl);
    expect(cfg.asrModel).toBe(p.defaultAsrModel);
    expect(cfg.llmModel).toBe(p.defaultLlmModel);
    expect(cfg.apiKey).toBe('');
  });

  it('buildProviderConfig uses overrides when given, defaults otherwise', () => {
    const p = new CustomProvider();
    const cfg = buildProviderConfig(p, {
      apiKey: 'k',
      baseUrl: 'https://example.com/v1',
      asrModel: 'whisper-1',
      llmModel: 'gpt-4o-mini',
    });
    expect(cfg).toEqual({
      apiKey: 'k',
      baseUrl: 'https://example.com/v1',
      asrModel: 'whisper-1',
      llmModel: 'gpt-4o-mini',
    });

    // 空 override 时退回 provider 默认
    const fallback = buildProviderConfig(p, { apiKey: 'k' });
    expect(fallback.baseUrl).toBe(p.defaultBaseUrl);
    expect(fallback.llmModel).toBe(p.defaultLlmModel);
  });
});

// ── Shared utilities ────────────────────────────────────────────────

describe('stripTrailingSlash', () => {
  it('strips one or more trailing slashes', () => {
    expect(stripTrailingSlash('https://a.com/')).toBe('https://a.com');
    expect(stripTrailingSlash('https://a.com///')).toBe('https://a.com');
    expect(stripTrailingSlash('https://a.com')).toBe('https://a.com');
  });
});

describe('asHttpError', () => {
  it('attaches status and body snippet to message', async () => {
    const resp = new Response('oh no', { status: 500 });
    const err = await asHttpError(resp, 'Label');
    expect(err.message).toContain('Label');
    expect(err.message).toContain('500');
    expect(err.message).toContain('oh no');
  });

  it('truncates long bodies', async () => {
    const longBody = 'x'.repeat(1000);
    const resp = new Response(longBody, { status: 400 });
    const err = await asHttpError(resp, 'X');
    expect(err.message.length).toBeLessThan(longBody.length);
    expect(err.message).toContain('…');
  });
});

describe('apiKeyLooksValid', () => {
  it('rejects empty / whitespace', () => {
    expect(apiKeyLooksValid('')).toMatch(/缺少/);
    expect(apiKeyLooksValid('   ')).toMatch(/缺少/);
  });

  it('rejects known placeholder values from .env / UI defaults', () => {
    expect(apiKeyLooksValid('your_siliconflow_api_key_here')).toMatch(/占位符/);
    expect(apiKeyLooksValid('your_api_key_here')).toMatch(/占位符/);
    expect(apiKeyLooksValid('test_key_placeholder')).toMatch(/占位符/);
    // 大小写不敏感
    expect(apiKeyLooksValid('YOUR_SILICONFLOW_API_KEY_HERE')).toMatch(/占位符/);
  });

  it('rejects sk-xxxxx style placeholders', () => {
    expect(apiKeyLooksValid('sk-xxxxx')).toMatch(/占位符/);
    expect(apiKeyLooksValid('sk-xxxxxxxxxxxxx')).toMatch(/占位符/);
    expect(apiKeyLooksValid('sk-X')).toMatch(/sk-xxxx/); // 短且纯 x
  });

  it('rejects too-short keys (< 16 chars)', () => {
    expect(apiKeyLooksValid('k')).toMatch(/长度过短/);
    expect(apiKeyLooksValid('sk-1234567890')).toMatch(/长度过短/); // 13 chars
    // 15 chars is too short (boundary)
    expect(apiKeyLooksValid('123456789012345')).toMatch(/长度过短/);
    // 16 chars exactly is the minimum and should pass (sanity check)
    expect(apiKeyLooksValid('1234567890123456')).toBeNull();
  });

  it('accepts real-looking keys', () => {
    expect(apiKeyLooksValid(REAL_KEY)).toBeNull();
    expect(apiKeyLooksValid('sk-abcdefghijklmnop1234567890')).toBeNull(); // 30 chars
    expect(apiKeyLooksValid('  ' + REAL_KEY + '  ')).toBeNull(); // trim
  });
});

// ── DashScope baseUrl rewrite helper ────────────────────────────────

describe('rewriteDashScopeBaseUrl', () => {
  it('replaces /api/v1 with /compatible-mode/v1 (default)', () => {
    expect(rewriteDashScopeBaseUrl('https://dashscope.aliyuncs.com/api/v1')).toBe(
      'https://dashscope.aliyuncs.com/compatible-mode/v1',
    );
  });

  it('leaves already-compatible-mode URLs alone', () => {
    expect(rewriteDashScopeBaseUrl('https://dashscope.aliyuncs.com/compatible-mode/v1')).toBe(
      'https://dashscope.aliyuncs.com/compatible-mode/v1',
    );
  });

  it('appends /compatible-mode/v1 to bare host with no path', () => {
    expect(rewriteDashScopeBaseUrl('https://dashscope.aliyuncs.com')).toBe(
      'https://dashscope.aliyuncs.com/compatible-mode/v1',
    );
  });

  it('preserves custom proxy path prefix when rewriting', () => {
    expect(rewriteDashScopeBaseUrl('https://my-proxy.com/dashscope/api/v1')).toBe(
      'https://my-proxy.com/dashscope/compatible-mode/v1',
    );
  });

  it('strips trailing slash before processing', () => {
    expect(rewriteDashScopeBaseUrl('https://dashscope.aliyuncs.com/api/v1/')).toBe(
      'https://dashscope.aliyuncs.com/compatible-mode/v1',
    );
  });
});

// ── Provider.validateConfig ─────────────────────────────────────────

describe('Provider.validateConfig', () => {
  describe('SiliconFlow', () => {
    it('accepts real-looking key + valid models', () => {
      const p = new SiliconFlowProvider();
      expect(
        p.validateConfig({
          apiKey: REAL_KEY,
          baseUrl: 'https://api.siliconflow.cn/v1',
          asrModel: 'FunAudioLLM/SenseVoiceSmall',
          llmModel: 'Qwen/Qwen3-32B',
        }),
      ).toBeNull();
    });

    it('rejects empty apiKey', () => {
      expect(
        new SiliconFlowProvider().validateConfig({
          apiKey: '',
          baseUrl: 'x',
          asrModel: 'a',
          llmModel: 'b',
        }),
      ).toMatch(/API Key/);
    });

    it('rejects placeholder apiKey from .env / UI defaults', () => {
      expect(
        new SiliconFlowProvider().validateConfig({
          apiKey: 'your_siliconflow_api_key_here',
          baseUrl: 'x',
          asrModel: 'a',
          llmModel: 'b',
        }),
      ).toMatch(/占位符/);
    });

    it('rejects too-short apiKey', () => {
      expect(
        new SiliconFlowProvider().validateConfig({
          apiKey: 'sk-tooshort',
          baseUrl: 'x',
          asrModel: 'a',
          llmModel: 'b',
        }),
      ).toMatch(/长度过短/);
    });

    it('rejects sk-xxxx placeholder', () => {
      expect(
        new SiliconFlowProvider().validateConfig({
          apiKey: 'sk-xxxxxxxxxxxxxxxxxx',
          baseUrl: 'x',
          asrModel: 'a',
          llmModel: 'b',
        }),
      ).toMatch(/占位符|sk-xxxx/);
    });

    it('still rejects empty asrModel / llmModel', () => {
      const p = new SiliconFlowProvider();
      expect(
        p.validateConfig({ apiKey: REAL_KEY, baseUrl: 'x', asrModel: '', llmModel: 'b' }),
      ).toMatch(/ASR/);
      expect(
        p.validateConfig({ apiKey: REAL_KEY, baseUrl: 'x', asrModel: 'a', llmModel: '' }),
      ).toMatch(/翻译/);
    });
  });

  describe('DashScope', () => {
    it('accepts paraformer-v2 / qwen-plus defaults with a real key', () => {
      const p = new DashScopeProvider();
      const cfg = defaultProviderConfig(p);
      expect(p.validateConfig({ ...cfg, apiKey: 'sk-dashscope-real-key-1234567890' })).toBeNull();
    });

    it('rejects placeholder apiKey', () => {
      expect(
        new DashScopeProvider().validateConfig({
          apiKey: 'your_api_key_here',
          baseUrl: 'x',
          asrModel: 'paraformer-v2',
          llmModel: 'qwen-plus',
        }),
      ).toMatch(/占位符/);
    });
  });

  describe('Zhipu', () => {
    it('requires asrModel (defaultAsrModel is empty — no fallback)', () => {
      const p = new ZhipuProvider();
      expect(p.defaultAsrModel).toBe('');
      expect(
        p.validateConfig({ apiKey: REAL_KEY, baseUrl: 'x', asrModel: '', llmModel: 'glm-4-plus' }),
      ).toMatch(/请填写智谱 ASR 模型名/);
    });

    it('accepts glm-4-voice asrModel + glm-4-plus llmModel', () => {
      expect(
        new ZhipuProvider().validateConfig({
          apiKey: REAL_KEY,
          baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
          asrModel: 'glm-4-voice',
          llmModel: 'glm-4-plus',
        }),
      ).toBeNull();
    });

    it('rejects placeholder apiKey', () => {
      expect(
        new ZhipuProvider().validateConfig({
          apiKey: 'sk-xxxxx',
          baseUrl: 'x',
          asrModel: 'glm-4-voice',
          llmModel: 'glm-4-plus',
        }),
      ).toMatch(/占位符/);
    });
  });

  describe('Custom', () => {
    it('allows empty asrModel (validated later in transcribe)', () => {
      const p = new CustomProvider();
      expect(
        p.validateConfig({
          apiKey: REAL_KEY,
          baseUrl: 'https://x.com/v1',
          asrModel: '',
          llmModel: 'gpt-4o-mini',
        }),
      ).toBeNull();
    });

    it('rejects invalid baseUrl', () => {
      const p = new CustomProvider();
      expect(
        p.validateConfig({
          apiKey: REAL_KEY,
          baseUrl: 'not-a-url',
          asrModel: 'a',
          llmModel: 'b',
        }),
      ).toMatch(/baseUrl/);
    });

    it('rejects placeholder apiKey', () => {
      expect(
        new CustomProvider().validateConfig({
          apiKey: 'placeholder',
          baseUrl: 'https://x.com/v1',
          asrModel: 'a',
          llmModel: 'b',
        }),
      ).toMatch(/占位符/);
    });
  });
});

// ── Provider HTTP calls ─────────────────────────────────────────────

describe('Provider HTTP calls', () => {
  // ── SiliconFlow ───────────────────────────────────────────────

  it('SiliconFlowProvider.transcribe POSTs multipart to /audio/transcriptions', async () => {
    const p = new SiliconFlowProvider();
    const captured: { url?: string; init?: RequestInit } = {};
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: any, init?: RequestInit) => {
      captured.url = String(url);
      captured.init = init;
      return new Response(JSON.stringify({ text: 'hello' }), { status: 200 });
    }) as typeof fetch;

    try {
      const result = await p.transcribe({
        audio: new Blob(['x'], { type: 'audio/wav' }),
        cfg: { apiKey: REAL_KEY, baseUrl: 'https://api.siliconflow.cn/v1', asrModel: 'SenseVoice', llmModel: 'Qwen' },
      });
      expect(result).toBe('hello');
      expect(captured.url).toBe('https://api.siliconflow.cn/v1/audio/transcriptions');
      expect(captured.init?.method).toBe('POST');
      const headers = captured.init?.headers as Record<string, string>;
      expect(headers['Authorization']).toBe(`Bearer ${REAL_KEY}`);
      expect(captured.init?.body).toBeInstanceOf(FormData);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('SiliconFlowProvider.transcribe surfaces HTML 502 with truncated body', async () => {
    const p = new SiliconFlowProvider();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response('<html><body>cloudflare error page</body></html>', {
        status: 502,
        headers: { 'content-type': 'text/html' },
      })) as typeof fetch;

    try {
      await expect(
        p.transcribe({
          audio: new Blob(['x'], { type: 'audio/wav' }),
          cfg: { apiKey: REAL_KEY, baseUrl: 'https://api.siliconflow.cn/v1', asrModel: 'a', llmModel: 'b' },
        }),
      ).rejects.toThrow(/502/);
      // 第二次：assert body 截断 — 用更长的 body 验证截断（>300 字符）
      const longBody = 'cloudflare ' + 'x'.repeat(400);
      globalThis.fetch = (async () => new Response(longBody, { status: 502 })) as typeof fetch;
      await expect(
        p.transcribe({
          audio: new Blob(['x'], { type: 'audio/wav' }),
          cfg: { apiKey: REAL_KEY, baseUrl: 'https://api.siliconflow.cn/v1', asrModel: 'a', llmModel: 'b' },
        }),
      ).rejects.toThrow(/502[\s\S]*…/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('SiliconFlowProvider.translate accumulates multi-chunk SSE into onChunk callbacks', async () => {
    const p = new SiliconFlowProvider();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                'data: {"choices":[{"delta":{"content":"hello "}}]}\n\n' +
                  'data: {"choices":[{"delta":{"content":"world"}}]}\n\n' +
                  'data: [DONE]\n\n',
              ),
            );
            controller.close();
          },
        }),
        { status: 200 },
      )) as typeof fetch;

    const chunks: string[] = [];
    try {
      await p.translate({
        text: 'x',
        systemInstruction: 's',
        cfg: { apiKey: REAL_KEY, baseUrl: 'https://api.siliconflow.cn/v1', asrModel: 'a', llmModel: 'b' },
        onChunk: (c) => chunks.push(c),
      });
      expect(chunks).toEqual(['hello ', 'world']);
      expect(chunks.join('')).toBe('hello world');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('SiliconFlowProvider.translate throws on SSE error chunk', async () => {
    const p = new SiliconFlowProvider();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode('data: {"error":{"message":"rate limit exceeded"}}\n\n'),
            );
            controller.close();
          },
        }),
        { status: 200 },
      )) as typeof fetch;

    try {
      await expect(
        p.translate({
          text: 'x',
          systemInstruction: 's',
          cfg: { apiKey: REAL_KEY, baseUrl: 'https://api.siliconflow.cn/v1', asrModel: 'a', llmModel: 'b' },
          onChunk: () => {},
        }),
      ).rejects.toThrow(/rate limit/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('SiliconFlowProvider.translate surfaces HTTP errors with the response body', async () => {
    const p = new SiliconFlowProvider();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response('rate limited', { status: 429 })) as typeof fetch;
    try {
      await expect(
        p.translate({
          text: 'x',
          systemInstruction: 's',
          cfg: { apiKey: REAL_KEY, baseUrl: 'https://api.siliconflow.cn/v1', asrModel: 'a', llmModel: 'b' },
          onChunk: () => {},
        }),
      ).rejects.toThrow(/429/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // ── DashScope ─────────────────────────────────────────────────

  it('DashScopeProvider.transcribe sync mode returns output.text directly', async () => {
    const p = new DashScopeProvider();
    const originalFetch = globalThis.fetch;
    let capturedUrl = '';
    globalThis.fetch = (async (url: any) => {
      capturedUrl = String(url);
      return new Response(JSON.stringify({ output: { text: '同步结果' } }), { status: 200 });
    }) as typeof fetch;

    try {
      const result = await p.transcribe({
        audio: new Blob(['x'], { type: 'audio/wav' }),
        cfg: {
          apiKey: 'sk-dashscope-real-key-1234567890',
          baseUrl: 'https://dashscope.aliyuncs.com/api/v1',
          asrModel: 'paraformer-v2',
          llmModel: 'qwen-plus',
        },
      });
      expect(result).toBe('同步结果');
      expect(capturedUrl).toBe('https://dashscope.aliyuncs.com/api/v1/services/audio/asr/transcription');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('DashScopeProvider.transcribe async mode polls transcription_url until SUCCEEDED', async () => {
    const p = new DashScopeProvider();
    const originalFetch = globalThis.fetch;
    const urls: string[] = [];
    let callCount = 0;
    globalThis.fetch = (async (url: any) => {
      const u = String(url);
      urls.push(u);
      callCount++;
      if (callCount === 1) {
        return new Response(
          JSON.stringify({ output: { transcription_url: 'https://dashscope.aliyuncs.com/task/abc-123' } }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          output: { task_status: 'SUCCEEDED', results: [{ transcription_text: '异步结果' }] },
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    vi.useFakeTimers();
    try {
      const promise = p.transcribe({
        audio: new Blob(['x'], { type: 'audio/wav' }),
        cfg: {
          apiKey: 'sk-dashscope-real-key-1234567890',
          baseUrl: 'https://dashscope.aliyuncs.com/api/v1',
          asrModel: 'paraformer-v2',
          llmModel: 'qwen-plus',
        },
      });
      // 跳过 pollTranscription 里的 setTimeout(1500)
      await vi.advanceTimersByTimeAsync(2000);
      const result = await promise;
      expect(result).toBe('异步结果');
      expect(urls[0]).toContain('/services/audio/asr/transcription');
      expect(urls[1]).toBe('https://dashscope.aliyuncs.com/task/abc-123');
    } finally {
      vi.useRealTimers();
      globalThis.fetch = originalFetch;
    }
  });

  it('DashScopeProvider.translate rewrites default /api/v1 baseUrl to /compatible-mode/v1', async () => {
    const p = new DashScopeProvider();
    const captured: { url?: string } = {};
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: any) => {
      captured.url = String(url);
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n'));
            controller.close();
          },
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    try {
      await p.translate({
        text: 'hello',
        systemInstruction: 'sys',
        cfg: {
          apiKey: 'sk-dashscope-real-key-1234567890',
          baseUrl: 'https://dashscope.aliyuncs.com/api/v1',
          asrModel: 'paraformer-v2',
          llmModel: 'qwen-plus',
        },
        onChunk: () => {},
      });
      expect(captured.url).toBe('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('DashScopeProvider.translate preserves already-compatible-mode baseUrl', async () => {
    const p = new DashScopeProvider();
    const captured: { url?: string } = {};
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: any) => {
      captured.url = String(url);
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n'));
            controller.close();
          },
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    try {
      await p.translate({
        text: 'hello',
        systemInstruction: 'sys',
        cfg: {
          apiKey: 'sk-dashscope-real-key-1234567890',
          baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
          asrModel: 'paraformer-v2',
          llmModel: 'qwen-plus',
        },
        onChunk: () => {},
      });
      expect(captured.url).toBe('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('DashScopeProvider.translate appends /compatible-mode/v1 to bare-host baseUrl', async () => {
    const p = new DashScopeProvider();
    const captured: { url?: string } = {};
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: any) => {
      captured.url = String(url);
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n'));
            controller.close();
          },
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    try {
      await p.translate({
        text: 'hello',
        systemInstruction: 'sys',
        cfg: {
          apiKey: 'sk-dashscope-real-key-1234567890',
          baseUrl: 'https://dashscope.aliyuncs.com',
          asrModel: 'paraformer-v2',
          llmModel: 'qwen-plus',
        },
        onChunk: () => {},
      });
      expect(captured.url).toBe('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // ── Zhipu ─────────────────────────────────────────────────────

  it('ZhipuProvider.transcribe POSTs to /audio/transcriptions and returns text', async () => {
    const p = new ZhipuProvider();
    const captured: { url?: string; init?: RequestInit } = {};
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: any, init?: RequestInit) => {
      captured.url = String(url);
      captured.init = init;
      return new Response(JSON.stringify({ text: '智谱结果' }), { status: 200 });
    }) as typeof fetch;

    try {
      const result = await p.transcribe({
        audio: new Blob(['x'], { type: 'audio/wav' }),
        cfg: {
          apiKey: REAL_KEY,
          baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
          asrModel: 'glm-4-voice',
          llmModel: 'glm-4-plus',
        },
      });
      expect(result).toBe('智谱结果');
      expect(captured.url).toBe('https://open.bigmodel.cn/api/paas/v4/audio/transcriptions');
      const headers = captured.init?.headers as Record<string, string>;
      expect(headers['Authorization']).toBe(`Bearer ${REAL_KEY}`);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('ZhipuProvider.translate streams SSE onChunk to callback', async () => {
    const p = new ZhipuProvider();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode('data: {"choices":[{"delta":{"content":"你好"}}]}\n\ndata: [DONE]\n\n'),
            );
            controller.close();
          },
        }),
        { status: 200 },
      )) as typeof fetch;

    const chunks: string[] = [];
    try {
      await p.translate({
        text: 'hello',
        systemInstruction: 'sys',
        cfg: {
          apiKey: REAL_KEY,
          baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
          asrModel: 'glm-4-voice',
          llmModel: 'glm-4-plus',
        },
        onChunk: (c) => chunks.push(c),
      });
      expect(chunks).toEqual(['你好']);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // ── Custom ────────────────────────────────────────────────────

  it('CustomProvider.transcribe POSTs to /audio/transcriptions and returns text', async () => {
    const p = new CustomProvider();
    const captured: { url?: string } = {};
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: any) => {
      captured.url = String(url);
      return new Response(JSON.stringify({ text: 'custom asr result' }), { status: 200 });
    }) as typeof fetch;

    try {
      const result = await p.transcribe({
        audio: new Blob(['x'], { type: 'audio/wav' }),
        cfg: {
          apiKey: REAL_KEY,
          baseUrl: 'https://api.openai.com/v1',
          asrModel: 'whisper-1',
          llmModel: 'gpt-4o-mini',
        },
      });
      expect(result).toBe('custom asr result');
      expect(captured.url).toBe('https://api.openai.com/v1/audio/transcriptions');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('CustomProvider.transcribe throws with hint when asrModel is empty', async () => {
    const p = new CustomProvider();
    const originalFetch = globalThis.fetch;
    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return new Response('{}', { status: 200 });
    }) as typeof fetch;

    try {
      await expect(
        p.transcribe({
          audio: new Blob(['x'], { type: 'audio/wav' }),
          cfg: {
            apiKey: REAL_KEY,
            baseUrl: 'https://api.openai.com/v1',
            asrModel: '',
            llmModel: 'gpt-4o-mini',
          },
        }),
      ).rejects.toThrow(/Custom provider 未配置 ASR/);
      expect(fetchCalled).toBe(false); // 不应真的去 fetch
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('CustomProvider.translate streams SSE onChunk to callback', async () => {
    const p = new CustomProvider();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode('data: {"choices":[{"delta":{"content":"translated"}}]}\n\ndata: [DONE]\n\n'),
            );
            controller.close();
          },
        }),
        { status: 200 },
      )) as typeof fetch;

    const chunks: string[] = [];
    try {
      await p.translate({
        text: 'hi',
        systemInstruction: 'sys',
        cfg: {
          apiKey: REAL_KEY,
          baseUrl: 'https://api.openai.com/v1',
          asrModel: 'whisper-1',
          llmModel: 'gpt-4o-mini',
        },
        onChunk: (c) => chunks.push(c),
      });
      expect(chunks).toEqual(['translated']);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // ── streamChatCompletion (shared) ─────────────────────────────

  it('streamChatCompletion console.warns on bad JSON but does not throw', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            // 一行非法 JSON + 一行正常 JSON + [DONE]
            controller.enqueue(
              new TextEncoder().encode(
                'data: not-valid-json\n\n' +
                  'data: {"choices":[{"delta":{"content":"survived"}}]}\n\n' +
                  'data: [DONE]\n\n',
              ),
            );
            controller.close();
          },
        }),
        { status: 200 },
      )) as typeof fetch;

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const chunks: string[] = [];
    try {
      await streamChatCompletion({
        url: 'https://example.com/v1/chat/completions',
        apiKey: 'k',
        model: 'm',
        systemInstruction: 's',
        userText: 'u',
        onChunk: (c) => chunks.push(c),
      });
      expect(chunks).toEqual(['survived']); // 坏 JSON 行没污染正常流
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0]?.[0]).toMatch(/JSON parse error/);
    } finally {
      warnSpy.mockRestore();
      globalThis.fetch = originalFetch;
    }
  });
});
