export interface SubtitleMessage {
  id: string;
  original: string; // From Input Transcription
  translated: string; // From Output Transcription (Model Response)
  isFinal: boolean;
  timestamp: number;
  /** in = 对方说的（翻译给我看）；out = 我说的（翻译成语音发出去） */
  direction?: 'in' | 'out';
}

export type AudioSource = 'microphone' | 'system';

export interface AudioInputDevice {
  deviceId: string;
  label: string;
  /**
   * 是否为虚拟声卡(BlackHole / VB-Cable / Loopback 等)。
   * 由 services/mediaDevices.ts 中的 normalizeAudioInputDevices 根据设备 label 标记。
   * 用户开第三方会议时,需要把会议软件输出设到虚拟声卡,本应用输入也选同一个虚拟声卡。
   */
  isVirtual?: boolean;
}

export enum ConnectionStatus {
  DISCONNECTED = 'DISCONNECTED',
  CONNECTING = 'CONNECTING',
  CONNECTED = 'CONNECTED',
  ERROR = 'ERROR',
}
