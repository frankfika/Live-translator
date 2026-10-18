import { describe, it, expect } from 'vitest';
import { decodeWav } from './wav';
import { encodeWAV } from './audioUtils';
import { buildOutgoingPrompt } from './prompt';
import { pcm16Base64 } from './speaker';

function wav(opts: { format: number; bits: number; channels: number; rate: number; frames: number[][]; dataSize?: number; extraChunk?: boolean }): ArrayBuffer {
  const bytes = opts.bits / 8;
  const dataLen = opts.frames.length * opts.channels * bytes;
  const extra = opts.extraChunk ? 8 + 4 : 0;
  const buf = new ArrayBuffer(44 + extra + dataLen);
  const v = new DataView(buf);
  const w = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); v.setUint32(4, 36 + extra + dataLen, true); w(8, 'WAVE');
  w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, opts.format, true); v.setUint16(22, opts.channels, true);
  v.setUint32(24, opts.rate, true); v.setUint32(28, opts.rate * opts.channels * bytes, true);
  v.setUint16(32, opts.channels * bytes, true); v.setUint16(34, opts.bits, true);
  let off = 36;
  if (opts.extraChunk) { w(off, 'LIST'); v.setUint32(off + 4, 4, true); w(off + 8, 'INFO'); off += 12; }
  w(off, 'data'); v.setUint32(off + 4, opts.dataSize ?? dataLen, true); off += 8;
  for (const frame of opts.frames) {
    for (const x of frame) {
      if (opts.format === 3) v.setFloat32(off, x, true);
      else v.setInt16(off, Math.round(x * 32767), true);
      off += bytes;
    }
  }
  return buf;
}

describe('decodeWav', () => {
  it('round-trips our own 16-bit encoder', async () => {
    const src = new Float32Array([0, 0.5, -0.5, 0.25]);
    const blob = encodeWAV(src, 24000);
    const out = decodeWav(await blob.arrayBuffer());
    expect(out.sampleRate).toBe(24000);
    expect(Array.from(out.samples).map((x) => Math.round(x * 100) / 100)).toEqual([0, 0.5, -0.5, 0.25]);
  });

  it('downmixes stereo and reads float32', () => {
    const out = decodeWav(wav({ format: 3, bits: 32, channels: 2, rate: 48000, frames: [[1, 0], [0.5, 0.5]] }));
    expect(out.sampleRate).toBe(48000);
    expect(Array.from(out.samples)).toEqual([0.5, 0.5]);
  });

  it('handles streaming headers (data size 0xFFFFFFFF) and extra chunks before data', () => {
    const out = decodeWav(wav({ format: 1, bits: 16, channels: 1, rate: 22050, frames: [[0.5], [-0.5]], dataSize: 0xffffffff, extraChunk: true }));
    expect(out.sampleRate).toBe(22050);
    expect(out.samples.length).toBe(2);
  });

  it('rejects non-WAV responses with a clear error', () => {
    const json = new TextEncoder().encode('{"error":"bad"}').buffer;
    expect(() => decodeWav(json)).toThrow(/不是 WAV/);
  });
});

describe('buildOutgoingPrompt', () => {
  it('translates one way, for speech output', () => {
    const p = buildOutgoingPrompt('Chinese', 'English', '张总=Mr. Zhang');
    expect(p).toContain('I speak Chinese; translate everything I say into English');
    expect(p).toContain('read aloud');
    expect(p).toContain('- 张总 → Mr. Zhang');
  });
});

describe('pcm16Base64', () => {
  it('encodes little-endian int16 and clamps', () => {
    const b64 = pcm16Base64(new Float32Array([0, 1, -1, 2]));
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const v = new DataView(bytes.buffer);
    expect([v.getInt16(0, true), v.getInt16(2, true), v.getInt16(4, true), v.getInt16(6, true)]).toEqual([0, 32767, -32768, 32767]);
  });
});
