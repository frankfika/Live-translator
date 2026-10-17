import { describe, it, expect } from 'vitest';
import { normalizeSettings, needsSessionRestart, DEFAULT_SETTINGS } from './settings';
import { buildSystemPrompt, parseGlossary } from './prompt';

describe('normalizeSettings', () => {
  it('decodes stored strings into typed values', () => {
    const s = normalizeSettings({ echoCancellation: 'false', overlayFontSize: '30', langA: 'Japanese' });
    expect(s.echoCancellation).toBe(false);
    expect(s.overlayFontSize).toBe(30);
    expect(s.langA).toBe('Japanese');
    expect(s.langB).toBe(DEFAULT_SETTINGS.langB);
  });

  it('clamps out-of-range and rejects unknown enum values', () => {
    const s = normalizeSettings({ overlayFontSize: 200, overlayOpacity: 0, audioSource: 'bogus', vadSensitivity: 'x' });
    expect(s.overlayFontSize).toBe(48);
    expect(s.overlayOpacity).toBe(0.2);
    expect(s.audioSource).toBe(DEFAULT_SETTINGS.audioSource);
    expect(s.vadSensitivity).toBe('medium');
  });
});

describe('needsSessionRestart', () => {
  it('restarts for audio/model changes but not for appearance changes', () => {
    const a = DEFAULT_SETTINGS;
    expect(needsSessionRestart(a, { ...a, overlayFontSize: 30 })).toBe(false);
    expect(needsSessionRestart(a, { ...a, audioSource: 'microphone' })).toBe(true);
    expect(needsSessionRestart(a, { ...a, glossary: 'foo' })).toBe(true);
  });
});

describe('prompt', () => {
  it('parses glossary lines in several formats', () => {
    expect(parseGlossary('OpenCSG\n大模型=LLM\n张总 -> Mr. Zhang\n\n  K8s：Kubernetes ')).toEqual([
      { source: 'OpenCSG' },
      { source: '大模型', target: 'LLM' },
      { source: '张总', target: 'Mr. Zhang' },
      { source: 'K8s', target: 'Kubernetes' },
    ]);
  });

  it('includes language direction and glossary in the system prompt', () => {
    const p = buildSystemPrompt('English', 'Chinese', '大模型=LLM');
    expect(p).toContain('between English and Chinese');
    expect(p).toContain('- 大模型 → LLM');
    expect(p).toContain('[SKIP]');
    expect(buildSystemPrompt('English', 'Chinese', '')).not.toContain('Glossary');
  });
});
