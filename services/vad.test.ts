import { describe, it, expect } from 'vitest';
import { AdaptiveVad, VadSegment } from './vad';

const RATE = 16000;
const FRAME = 640; // 40ms

function noise(amp: number): Float32Array {
  const f = new Float32Array(FRAME);
  for (let i = 0; i < FRAME; i++) f[i] = (Math.random() * 2 - 1) * amp;
  return f;
}
function tone(amp: number): Float32Array {
  const f = new Float32Array(FRAME);
  for (let i = 0; i < FRAME; i++) f[i] = Math.sin(i * 0.2) * amp;
  return f;
}
/** 像人声一样有 ~4Hz 音节起伏的信号 */
let syllableT = 0;
function speech(amp: number): Float32Array {
  syllableT += FRAME / RATE;
  const env = 0.15 + 0.85 * Math.abs(Math.sin(2 * Math.PI * 4 * syllableT));
  return tone(amp * env);
}
function run(vad: AdaptiveVad, frame: () => Float32Array, ms: number) {
  for (let t = 0; t < ms; t += (FRAME / RATE) * 1000) vad.process(frame());
}

function setup(sensitivity: 'low' | 'medium' | 'high' = 'medium') {
  const vad = new AdaptiveVad({ sampleRate: RATE, sensitivity });
  const segments: VadSegment[] = [];
  let discards = 0;
  let starts = 0;
  vad.onSegment = (s) => segments.push(s);
  vad.onDiscard = () => discards++;
  vad.onSpeechStart = () => starts++;
  return { vad, segments, get discards() { return discards; }, get starts() { return starts; } };
}

describe('AdaptiveVad', () => {
  it('emits one segment for a sentence followed by silence', () => {
    const t = setup();
    run(t.vad, () => noise(0.002), 1000);
    run(t.vad, () => speech(0.2), 1500);
    run(t.vad, () => noise(0.002), 1200);
    expect(t.segments).toHaveLength(1);
    // 包含预录：长度应 > 纯说话部分
    expect(t.segments[0].samples.length / RATE).toBeGreaterThan(1.5);
  });

  it('does not split on a short breathing pause', () => {
    const t = setup();
    run(t.vad, () => noise(0.002), 800);
    run(t.vad, () => speech(0.2), 1000);
    run(t.vad, () => noise(0.002), 400); // 正常换气
    run(t.vad, () => speech(0.2), 1000);
    run(t.vad, () => noise(0.002), 1200);
    expect(t.segments).toHaveLength(1);
  });

  it('adapts to a steady noise floor instead of treating it as speech', () => {
    const t = setup();
    // 持续的空调 / 风扇底噪（高于旧版固定阈值 0.015）
    run(t.vad, () => noise(0.03), 5000);
    expect(t.segments).toHaveLength(0);
    // 底噪之上的人声仍然能检测到
    run(t.vad, () => speech(0.35), 1500);
    run(t.vad, () => noise(0.03), 1500);
    expect(t.segments).toHaveLength(1);
  });

  it('ignores short transients like a cough or a desk knock', () => {
    const t = setup();
    run(t.vad, () => noise(0.002), 1000);
    run(t.vad, () => tone(0.4), 80);
    run(t.vad, () => noise(0.002), 1500);
    expect(t.segments).toHaveLength(0);
  });

  it('rejects a fan / air-conditioner that suddenly turns on, then still hears speech over it', () => {
    const t = setup();
    run(t.vad, () => noise(0.002), 1500); // 安静
    run(t.vad, () => noise(0.12), 5000); // 突然开风扇（稳态，比之前响得多）
    expect(t.segments).toHaveLength(0);
    expect(t.discards).toBeGreaterThanOrEqual(1);
    run(t.vad, () => speech(0.6), 2000); // 风扇声里说话
    run(t.vad, () => noise(0.12), 1500);
    expect(t.segments).toHaveLength(1);
  });

  it('does not mistake speech with shallow modulation over a loud fan for steady noise', () => {
    // 回归：风扇声里说话时音节起伏被底噪"填平"，能量起伏只有 ~3dB，之前偶尔被当成噪声丢掉
    const t = setup();
    run(t.vad, () => noise(0.002), 1500);
    let k = 0;
    const flatSpeech = () => {
      k++;
      // 参数按真实录音校准：风扇里说话的帧能量起伏约 3dB
      const env = 0.15 + 0.85 * Math.abs(Math.sin(2 * Math.PI * 3 * (k * FRAME / RATE)));
      const f = noise(0.1);
      const s = tone(0.25 * env);
      for (let i = 0; i < FRAME; i++) f[i] += s[i];
      return f;
    };
    run(t.vad, flatSpeech, 6000);
    run(t.vad, () => noise(0.002), 1500);
    expect(t.discards).toBe(0);
    expect(t.segments).toHaveLength(1);
  });

  it('cuts very long monologues so subtitles keep flowing', () => {
    const t = setup();
    run(t.vad, () => noise(0.002), 600);
    run(t.vad, () => speech(0.2), 40000);
    expect(t.segments.length).toBeGreaterThanOrEqual(2);
    for (const s of t.segments) expect(s.samples.length / RATE).toBeLessThanOrEqual(20.5);
  });

  it('low sensitivity rejects quiet speech that high sensitivity accepts', () => {
    const lo = setup('low');
    const hi = setup('high');
    for (const t of [lo, hi]) {
      run(t.vad, () => noise(0.001), 800);
      run(t.vad, () => speech(0.02), 1200);
      run(t.vad, () => noise(0.001), 1200);
    }
    expect(lo.segments).toHaveLength(0);
    expect(hi.segments).toHaveLength(1);
  });
});
