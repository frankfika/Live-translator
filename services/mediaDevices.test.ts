import { describe, it, expect } from 'vitest';
import {
  buildMicrophoneConstraints,
  formatMediaError,
  isVirtualAudioDevice,
  normalizeAudioInputDevices,
} from './mediaDevices';

const mkDevice = (overrides: Partial<MediaDeviceInfo>): MediaDeviceInfo => ({
  deviceId: 'dev-1',
  kind: 'audioinput',
  label: '',
  groupId: 'grp-1',
  toJSON: () => ({}),
  ...overrides,
});

describe('Media Devices', () => {
  describe('formatMediaError', () => {
    it('should format NotAllowedError', () => {
      const error = new DOMException('Permission denied', 'NotAllowedError');
      const result = formatMediaError(error, 'fallback');
      expect(result).toContain('音频权限');
    });

    it('should format NotFoundError', () => {
      const error = new DOMException('Device not found', 'NotFoundError');
      const result = formatMediaError(error, 'fallback');
      expect(result).toContain('音频输入设备');
    });

    it('should format NotReadableError', () => {
      const error = new DOMException('Device in use', 'NotReadableError');
      const result = formatMediaError(error, 'fallback');
      expect(result).toContain('设备');
    });

    it('should format OverconstrainedError', () => {
      const error = new DOMException('Constraints not satisfied', 'OverconstrainedError');
      const result = formatMediaError(error, 'fallback');
      expect(result).toContain('输入设备');
    });

    it('should handle unknown errors', () => {
      const error = new Error('Unknown error');
      const result = formatMediaError(error, 'fallback');
      expect(result).toContain('Unknown error');
    });

    it('should fall back when error is not a DOMException', () => {
      const result = formatMediaError({}, 'fallback message');
      expect(result).toBe('fallback message');
    });
  });

  describe('buildMicrophoneConstraints', () => {
    it('defaults to echoCancellation/noiseSuppression/autoGainControl ON', () => {
      const c = buildMicrophoneConstraints();
      expect(c.echoCancellation).toBe(true);
      expect(c.noiseSuppression).toBe(true);
      expect(c.autoGainControl).toBe(true);
      expect(c.deviceId).toBeUndefined();
    });

    it('pins deviceId when provided', () => {
      const c = buildMicrophoneConstraints('mic-1');
      expect(c.deviceId).toEqual({ exact: 'mic-1' });
      expect(c.echoCancellation).toBe(true);
    });

    it('honors explicit opts override', () => {
      const c = buildMicrophoneConstraints('mic-1', {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      });
      expect(c.echoCancellation).toBe(false);
      expect(c.noiseSuppression).toBe(false);
      expect(c.autoGainControl).toBe(false);
      expect(c.deviceId).toEqual({ exact: 'mic-1' });
    });

    it('partial opts still defaults the unspecified fields to true', () => {
      const c = buildMicrophoneConstraints('mic-1', { echoCancellation: false });
      expect(c.echoCancellation).toBe(false);
      expect(c.noiseSuppression).toBe(true);
      expect(c.autoGainControl).toBe(true);
    });
  });

  describe('normalizeAudioInputDevices', () => {
    it('keeps default device and tags it as 系统默认输入设备', () => {
      const out = normalizeAudioInputDevices([
        mkDevice({ deviceId: 'default', label: '' }),
        mkDevice({ deviceId: 'real-mic', label: 'MacBook Pro Microphone' }),
      ]);
      expect(out[0]).toEqual({
        deviceId: 'default',
        label: '系统默认输入设备',
        isVirtual: false,
      });
      expect(out[1].deviceId).toBe('real-mic');
      expect(out[1].label).toBe('MacBook Pro Microphone');
    });

    it('keeps communications device', () => {
      const out = normalizeAudioInputDevices([
        mkDevice({ deviceId: 'default', label: '' }),
        mkDevice({ deviceId: 'communications', label: '' }),
        mkDevice({ deviceId: 'real-mic', label: 'MacBook Pro Microphone' }),
      ]);
      const ids = out.map((d) => d.deviceId);
      expect(ids).toEqual(['default', 'communications', 'real-mic']);
      expect(out[1].label).toBe('通讯设备');
    });

    it('orders default then communications then the rest', () => {
      const out = normalizeAudioInputDevices([
        mkDevice({ deviceId: 'real-mic', label: 'MacBook Pro Microphone' }),
        mkDevice({ deviceId: 'communications', label: '' }),
        mkDevice({ deviceId: 'default', label: '' }),
      ]);
      expect(out.map((d) => d.deviceId)).toEqual(['default', 'communications', 'real-mic']);
    });

    it('fills in 输入设备 N for unlabeled devices', () => {
      const out = normalizeAudioInputDevices([
        mkDevice({ deviceId: 'default', label: '' }),
        mkDevice({ deviceId: 'a', label: '' }),
        mkDevice({ deviceId: 'b', label: '' }),
      ]);
      // default 已有固定 label，所以未命名计数从 1 开始给 a/b
      expect(out[1].label).toBe('输入设备 1');
      expect(out[2].label).toBe('输入设备 2');
    });

    it('marks BlackHole as virtual', () => {
      const out = normalizeAudioInputDevices([
        mkDevice({ deviceId: 'bh-1', label: 'BlackHole 2ch' }),
      ]);
      expect(out[0].isVirtual).toBe(true);
    });

    it('marks VB-Cable as virtual', () => {
      const out = normalizeAudioInputDevices([
        mkDevice({ deviceId: 'vb', label: 'VB-Audio Virtual Cable' }),
      ]);
      expect(out[0].isVirtual).toBe(true);
    });

    it('marks Voicemeeter as virtual', () => {
      const out = normalizeAudioInputDevices([
        mkDevice({ deviceId: 'vm', label: 'VoiceMeeter Output' }),
      ]);
      expect(out[0].isVirtual).toBe(true);
    });

    it('marks 虚拟 as virtual (Chinese)', () => {
      const out = normalizeAudioInputDevices([
        mkDevice({ deviceId: 'v', label: '立体声混音 (虚拟)' }),
      ]);
      expect(out[0].isVirtual).toBe(true);
    });

    it('marks regular built-in mic as not virtual', () => {
      const out = normalizeAudioInputDevices([
        mkDevice({ deviceId: 'm', label: 'MacBook Pro Microphone' }),
      ]);
      expect(out[0].isVirtual).toBe(false);
    });

    it('dedupes duplicate deviceId entries', () => {
      const out = normalizeAudioInputDevices([
        mkDevice({ deviceId: 'dup', label: 'Same' }),
        mkDevice({ deviceId: 'dup', label: 'Same again' }),
      ]);
      expect(out).toHaveLength(1);
      expect(out[0].label).toBe('Same');
    });

    it('ignores non-audioinput devices', () => {
      const out = normalizeAudioInputDevices([
        mkDevice({ deviceId: 'cam-1', kind: 'videoinput', label: 'FaceTime HD' }),
        mkDevice({ deviceId: 'm', kind: 'audioinput', label: 'MacBook Pro Microphone' }),
      ]);
      expect(out).toHaveLength(1);
      expect(out[0].deviceId).toBe('m');
    });

    it('returns only default+communications when enumerateDevices is empty before auth', () => {
      // macOS 未授权时的典型情况
      const out = normalizeAudioInputDevices([
        mkDevice({ deviceId: 'default', label: '' }),
        mkDevice({ deviceId: 'communications', label: '' }),
      ]);
      expect(out).toHaveLength(2);
      expect(out[0].label).toBe('系统默认输入设备');
      expect(out[1].label).toBe('通讯设备');
    });
  });

  describe('isVirtualAudioDevice', () => {
    it('detects common virtual-audio driver names', () => {
      expect(isVirtualAudioDevice('BlackHole 16ch')).toBe(true);
      expect(isVirtualAudioDevice('VB-Audio Cable')).toBe(true);
      expect(isVirtualAudioDevice('VoiceMeeter Aux Input')).toBe(true);
      expect(isVirtualAudioDevice('Soundflower (2ch)')).toBe(true);
      expect(isVirtualAudioDevice('Loopback Audio')).toBe(true);
      expect(isVirtualAudioDevice('立体声混音 虚拟')).toBe(true);
    });

    it('does not flag built-in mics', () => {
      expect(isVirtualAudioDevice('MacBook Pro Microphone')).toBe(false);
      expect(isVirtualAudioDevice('USB Audio CODEC')).toBe(false);
    });

    it('handles empty label safely', () => {
      expect(isVirtualAudioDevice('')).toBe(false);
    });

    it('matches case-insensitively', () => {
      expect(isVirtualAudioDevice('BLACKHOLE 2ch')).toBe(true);
      expect(isVirtualAudioDevice('loopback')).toBe(true);
    });
  });
});