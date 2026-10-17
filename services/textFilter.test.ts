import { describe, it, expect } from 'vitest';
import { cleanTranscript, judgeTranscript, cleanTranslation, isSkipOutput, mightBeSkipPrefix } from './textFilter';

describe('cleanTranscript', () => {
  it('strips SenseVoice tags and event emoji', () => {
    expect(cleanTranscript('<|zh|><|NEUTRAL|><|Speech|><|woitn|>今天开会讨论预算😊')).toBe('今天开会讨论预算');
    expect(cleanTranscript('🎼🎼')).toBe('');
  });

  it('strips bracketed event annotations', () => {
    expect(cleanTranscript('[音乐] 大家好 (笑声)')).toBe('大家好');
    expect(cleanTranscript('[BLANK_AUDIO]')).toBe('');
    expect(cleanTranscript('<noise>hello<noise>')).toBe('hello');
  });

  it('collapses stuck repetitions', () => {
    expect(cleanTranscript('好的好的好的好的好的好的')).toBe('好的 好的');
  });
});

describe('judgeTranscript', () => {
  it('keeps real sentences', () => {
    expect(judgeTranscript('我们下周再讨论这个方案')).toEqual({ keep: true, text: '我们下周再讨论这个方案' });
    expect(judgeTranscript('Let us move on.').keep).toBe(true);
  });

  it('drops video-ending hallucinations', () => {
    expect(judgeTranscript('谢谢观看！').keep).toBe(false);
    expect(judgeTranscript('Thank you for watching.').keep).toBe(false);
    expect(judgeTranscript('字幕由 Amara.org 社区提供').keep).toBe(false);
  });

  it('drops filler-only and single-char output', () => {
    expect(judgeTranscript('嗯。').keep).toBe(false);
    expect(judgeTranscript('Um...').keep).toBe(false);
    expect(judgeTranscript('啊').keep).toBe(false);
    expect(judgeTranscript('A').keep).toBe(false);
    expect(judgeTranscript('').keep).toBe(false);
  });

  it('keeps short but meaningful replies', () => {
    expect(judgeTranscript('好的').keep).toBe(true);
    expect(judgeTranscript('谢谢').keep).toBe(true);
    expect(judgeTranscript('No way').keep).toBe(true);
  });
});

describe('cleanTranslation', () => {
  it('removes think blocks, including unterminated ones while streaming', () => {
    expect(cleanTranslation('<think>reasoning</think>Hello')).toBe('Hello');
    expect(cleanTranslation('Hello<think>partial')).toBe('Hello');
  });

  it('removes prefixes and wrapping quotes', () => {
    expect(cleanTranslation('Translation: Good morning')).toBe('Good morning');
    expect(cleanTranslation('译文：早上好')).toBe('早上好');
    expect(cleanTranslation('“早上好”')).toBe('早上好');
  });
});

describe('skip detection', () => {
  it('recognises skip output and its streaming prefixes', () => {
    expect(isSkipOutput('[SKIP]')).toBe(true);
    expect(isSkipOutput('  [skip] ')).toBe(true);
    expect(isSkipOutput('Skip the intro')).toBe(false);
    expect(mightBeSkipPrefix('[SK')).toBe(true);
    expect(mightBeSkipPrefix('[')).toBe(true);
    expect(mightBeSkipPrefix('Hello')).toBe(false);
  });
});
