/**
 * 解析 WAV 文件 → 单声道 Float32。
 * 不假设具体格式：从 fmt 块读采样率 / 位深 / 声道数，支持 16/24/32 位整型和 32 位浮点。
 * 流式生成的 WAV 头里 data 长度可能是 0 或 0xFFFFFFFF，这时读到文件末尾。
 */
export interface DecodedAudio {
  samples: Float32Array;
  sampleRate: number;
}

export function decodeWav(buf: ArrayBuffer): DecodedAudio {
  const view = new DataView(buf);
  const tag = (off: number) => String.fromCharCode(view.getUint8(off), view.getUint8(off + 1), view.getUint8(off + 2), view.getUint8(off + 3));
  if (buf.byteLength < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') {
    throw new Error('语音合成返回的不是 WAV 音频');
  }
  let format = 1;
  let channels = 1;
  let sampleRate = 0;
  let bits = 16;
  let off = 12;
  while (off + 8 <= buf.byteLength) {
    const id = tag(off);
    let size = view.getUint32(off + 4, true);
    const body = off + 8;
    if (id === 'fmt ') {
      format = view.getUint16(body, true);
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bits = view.getUint16(body + 14, true);
      // WAVE_FORMAT_EXTENSIBLE：真实格式在子格式 GUID 的前两字节
      if (format === 0xfffe && size >= 26) format = view.getUint16(body + 24, true);
    } else if (id === 'data') {
      if (size === 0 || size === 0xffffffff || body + size > buf.byteLength) size = buf.byteLength - body;
      if (!sampleRate) throw new Error('WAV 缺少 fmt 块');
      return { samples: toMono(view, body, size, format, bits, channels), sampleRate };
    }
    off = body + size + (size & 1);
  }
  throw new Error('WAV 缺少 data 块');
}

function toMono(view: DataView, start: number, size: number, format: number, bits: number, channels: number): Float32Array {
  const bytes = bits / 8;
  const frames = Math.floor(size / (bytes * channels));
  const out = new Float32Array(frames);
  const read = (o: number): number => {
    if (format === 3 && bits === 32) return view.getFloat32(o, true);
    if (bits === 16) return view.getInt16(o, true) / 32768;
    if (bits === 24) {
      const v = view.getUint8(o) | (view.getUint8(o + 1) << 8) | (view.getInt8(o + 2) << 16);
      return v / 8388608;
    }
    if (bits === 32) return view.getInt32(o, true) / 2147483648;
    if (bits === 8) return (view.getUint8(o) - 128) / 128;
    throw new Error(`不支持的 WAV 位深 ${bits}`);
  };
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) sum += read(start + (i * channels + c) * bytes);
    out[i] = sum / channels;
  }
  return out;
}
