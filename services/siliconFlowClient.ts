import { createAudioData } from './audioUtils';

export interface LiveClientCallbacks {
  onOpen: () => void;
  onClose: () => void;
  onError: (error: Error) => void;
  onInputTranscription: (text: string) => void;
  onOutputTranscription: (text: string) => void;
  onTurnComplete: () => void;
  onAudioData: (visualizerData: Float32Array) => void;
}

export interface LiveClientConfig {
  systemInstruction: string;
}

function float32ToInt16(float32: Float32Array) {
  const l = float32.length;
  const int16 = new Int16Array(l);
  for (let i = 0; i < l; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return int16;
}

function pcm16ToWavBase64(pcm: Int16Array, sampleRate = 16000) {
  const numChannels = 1;
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataLength = pcm.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataLength);
  const view = new DataView(buffer);

  function writeString(view: DataView, offset: number, str: string) {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  }

  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataLength, true);
  writeString(view, 8, 'WAVE');
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 8 * bytesPerSample, true);
  writeString(view, 36, 'data');
  view.setUint32(40, dataLength, true);

  let offset = 44;
  for (let i = 0; i < pcm.length; i++, offset += 2) {
    view.setInt16(offset, pcm[i], true);
  }

  const uint8 = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < uint8.length; i++) binary += String.fromCharCode(uint8[i]);
  const base64 = btoa(binary);
  return `data:audio/wav;base64,${base64}`;
}

export class SiliconFlowClient {
  private apiKey: string;
  private inputAudioContext: AudioContext | null = null;
  private mediaStream: MediaStream | null = null;
  private processor: ScriptProcessorNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private isConnected = false;
  private turnBuffer: Float32Array[] = [];
  private silenceMs = 300;
  private sampleRate = 16000;
  private lastVoiceTime = 0;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async connect(config: LiveClientConfig, callbacks: LiveClientCallbacks) {
    if (this.isConnected) return;
    try {
      this.inputAudioContext = new (window.AudioContext || (window as any).webkitAudioContext)({
        sampleRate: this.sampleRate,
      });
      this.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });

      this.source = this.inputAudioContext.createMediaStreamSource(this.mediaStream);
      this.processor = this.inputAudioContext.createScriptProcessor(4096, 1, 1);

      this.processor.onaudioprocess = (e) => {
        if (!this.isConnected) return;
        const input = e.inputBuffer.getChannelData(0);
        this.turnBuffer.push(new Float32Array(input));

        let sum = 0;
        for (let i = 0; i < input.length; i++) sum += input[i] * input[i];
        const rms = Math.sqrt(sum / input.length);
        const now = performance.now();
        if (rms > 0.01) this.lastVoiceTime = now;

        callbacks.onAudioData(input);

        if (now - this.lastVoiceTime > this.silenceMs && this.getBufferedMs() > 400) {
          this.finalizeTurn(config, callbacks);
        }
      };

      this.source.connect(this.processor);
      this.processor.connect(this.inputAudioContext.destination);
      this.isConnected = true;
      callbacks.onOpen();
    } catch (err) {
      callbacks.onError(err as Error);
    }
  }

  private getBufferedMs() {
    const samples = this.turnBuffer.reduce((acc, arr) => acc + arr.length, 0);
    return (samples / this.sampleRate) * 1000;
  }

  private async finalizeTurn(config: LiveClientConfig, callbacks: LiveClientCallbacks) {
    const merged = this.mergeBuffers(this.turnBuffer);
    this.turnBuffer = [];
    const int16 = float32ToInt16(merged);
    const wav = pcm16ToWavBase64(int16, this.sampleRate);
    const b64 = wav.split(',')[1];

    try {
      const body = {
        model: 'Qwen/Qwen3-Omni-30B-A3B-Instruct',
        system: `${config.systemInstruction}\n输出严格的JSON：{"transcript":"","translation":""}`,
        messages: [
          { role: 'user', content: [ { type: 'input_audio', input_audio: { data: b64, format: 'wav' } } ] }
        ],
        max_tokens: 1024,
        stream: false
      };

      const resp = await fetch('https://api.siliconflow.cn/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`
        },
        body: JSON.stringify(body)
      });

      if (!resp.ok) {
        let errText = '';
        try { errText = await resp.text(); } catch {}
        throw new Error(`HTTP ${resp.status}${errText ? `: ${errText}` : ''}`);
      }
      const data = await resp.json();
      const blocks = data?.output?.content || data?.content || [];
      const content = Array.isArray(blocks)
        ? blocks.filter((b: any) => b?.type === 'text').map((b: any) => b.text).join('\n')
        : (typeof data?.output?.text === 'string' ? data.output.text : '');
      let raw = content || '';
      const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
      if (fenceMatch) raw = fenceMatch[1];
      raw = raw.trim();
      let transcript = '';
      let translation = '';
      try {
        const obj = JSON.parse(raw);
        transcript = typeof obj.transcript === 'string' ? obj.transcript : '';
        translation = typeof obj.translation === 'string' ? obj.translation : '';
      } catch {
        const m1 = raw.match(/"?transcript"?\s*[:：]\s*"([\s\S]*?)"/i);
        const m2 = raw.match(/"?translation"?\s*[:：]\s*"([\s\S]*?)"/i);
        transcript = m1?.[1] || '';
        translation = m2?.[1] || '';
      }

      if (transcript) callbacks.onInputTranscription(transcript);
      if (translation) callbacks.onOutputTranscription(translation);
      callbacks.onTurnComplete();
    } catch (e) {
      callbacks.onError(e as Error);
    }
  }

  private mergeBuffers(chunks: Float32Array[]) {
    const total = chunks.reduce((acc, arr) => acc + arr.length, 0);
    const result = new Float32Array(total);
    let offset = 0;
    for (const arr of chunks) {
      result.set(arr, offset);
      offset += arr.length;
    }
    return result;
  }

  getStream() {
    return this.mediaStream;
  }

  async disconnect() {
    this.isConnected = false;
    if (this.source) { this.source.disconnect(); this.source = null; }
    if (this.processor) { this.processor.disconnect(); this.processor = null; }
    if (this.mediaStream) { this.mediaStream.getTracks().forEach(t => t.stop()); this.mediaStream = null; }
    if (this.inputAudioContext) { await this.inputAudioContext.close(); this.inputAudioContext = null; }
  }
}
