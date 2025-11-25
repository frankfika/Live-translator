export interface SubtitleMessage {
  id: string;
  original: string; // From Input Transcription
  translated: string; // From Output Transcription (Model Response)
  isFinal: boolean;
  timestamp: number;
}

export enum ConnectionStatus {
  DISCONNECTED = 'DISCONNECTED',
  CONNECTING = 'CONNECTING',
  CONNECTED = 'CONNECTED',
  ERROR = 'ERROR',
}

export interface AudioVisualizerProps {
  stream: MediaStream | null;
  isActive: boolean;
}