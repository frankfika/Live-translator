import { GoogleGenAI, LiveServerMessage, Modality } from '@google/genai';
import { createAudioData, decodeAudio, decodeAudioData } from './audioUtils';

export interface LiveClientCallbacks {
  onOpen: () => void;
  onClose: () => void;
  onError: (error: Error) => void;
  onInputTranscription: (text: string) => void;
  onOutputTranscription: (text: string) => void;
  onTurnComplete: () => void;
  onAudioData: (visualizerData: Float32Array) => void; // For visualization
}

export interface LiveClientConfig {
  systemInstruction: string;
}

export class LiveClient {
  private ai: GoogleGenAI;
  private inputAudioContext: AudioContext | null = null;
  private outputAudioContext: AudioContext | null = null;
  private mediaStream: MediaStream | null = null;
  private processor: ScriptProcessorNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private sessionPromise: Promise<any> | null = null;
  private isConnected = false;
  private outputNode: GainNode | null = null;
  private nextStartTime = 0;

  constructor(apiKey: string) {
    this.ai = new GoogleGenAI({ apiKey });
  }

  async connect(config: LiveClientConfig, callbacks: LiveClientCallbacks) {
    if (this.isConnected) return;

    try {
      this.inputAudioContext = new (window.AudioContext || (window as any).webkitAudioContext)({
        sampleRate: 16000, // Gemini expects 16kHz input
      });
      
      this.outputAudioContext = new (window.AudioContext || (window as any).webkitAudioContext)({
        sampleRate: 24000, // Gemini sends 24kHz output
      });
      this.outputNode = this.outputAudioContext.createGain();
      // Optional: Reduce volume of the AI voice if we primarily want subtitles
      // this.outputNode.gain.value = 0.5; 
      this.outputNode.connect(this.outputAudioContext.destination);

      this.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      
      // Start the session
      this.sessionPromise = this.ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-09-2025',
        config: {
          responseModalities: [Modality.AUDIO],
          systemInstruction: config.systemInstruction,
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } },
          },
          // Fix: Pass empty objects to enable transcription, do not pass model names here
          inputAudioTranscription: {},
          outputAudioTranscription: {},
        },
        callbacks: {
          onopen: () => {
            this.isConnected = true;
            this.setupAudioProcessing();
            callbacks.onOpen();
          },
          onmessage: async (message: LiveServerMessage) => {
            // Handle Output Transcription (Translation)
            if (message.serverContent?.outputTranscription) {
              const text = message.serverContent.outputTranscription.text;
              if (text) {
                  callbacks.onOutputTranscription(text);
              }
            }
            
            // Handle Input Transcription (Original)
            if (message.serverContent?.inputTranscription) {
              const text = message.serverContent.inputTranscription.text;
              if (text) {
                  callbacks.onInputTranscription(text);
              }
            }

            // Handle turn completion to finalize text
            if (message.serverContent?.turnComplete) {
               callbacks.onTurnComplete();
            }

            // Handle Audio Output (The spoken translation)
            // We play this so the other person can hear the translation
            const base64Audio = message.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
            if (base64Audio && this.outputAudioContext && this.outputNode) {
               this.nextStartTime = Math.max(this.nextStartTime, this.outputAudioContext.currentTime);
               
               const audioBuffer = await decodeAudioData(
                 decodeAudio(base64Audio),
                 this.outputAudioContext,
                 24000,
                 1
               );
               
               const source = this.outputAudioContext.createBufferSource();
               source.buffer = audioBuffer;
               source.connect(this.outputNode);
               source.start(this.nextStartTime);
               this.nextStartTime += audioBuffer.duration;
            }
          },
          onclose: () => {
            this.isConnected = false;
            callbacks.onClose();
          },
          onerror: (e) => {
            this.isConnected = false;
            callbacks.onError(new Error("Connection error"));
            console.error(e);
          },
        },
      });

    } catch (err) {
      callbacks.onError(err as Error);
    }
  }

  private setupAudioProcessing() {
    if (!this.inputAudioContext || !this.mediaStream) return;

    this.source = this.inputAudioContext.createMediaStreamSource(this.mediaStream);
    this.processor = this.inputAudioContext.createScriptProcessor(4096, 1, 1);

    this.processor.onaudioprocess = (e) => {
      if (!this.isConnected || !this.sessionPromise) return;

      const inputData = e.inputBuffer.getChannelData(0);
      
      // Send for API
      const pcmData = createAudioData(inputData);
      this.sessionPromise.then((session) => {
        session.sendRealtimeInput({ media: pcmData });
      });
    };

    this.source.connect(this.processor);
    this.processor.connect(this.inputAudioContext.destination);
  }

  getStream() {
    return this.mediaStream;
  }

  async disconnect() {
    this.isConnected = false;
    
    if (this.source) {
      this.source.disconnect();
      this.source = null;
    }
    if (this.processor) {
      this.processor.disconnect();
      this.processor = null;
    }
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach(track => track.stop());
      this.mediaStream = null;
    }
    if (this.inputAudioContext) {
      await this.inputAudioContext.close();
      this.inputAudioContext = null;
    }
    if (this.outputAudioContext) {
      await this.outputAudioContext.close();
      this.outputAudioContext = null;
    }
    
    // We can't explicitly close the session object in the current SDK version 
    // easily without the object returned from connect, but closing the websocket 
    // happens when we drop references or browser unloads. 
    // However, logic above stops sending data.
  }
}