import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isTauriApp } from './tauri';

describe('Tauri Service', () => {
  beforeEach(() => {
    // Clean up global state
    delete (global as any).__TAURI__;
  });

  describe('isTauriApp', () => {
    it('should return false in test environment', () => {
      expect(isTauriApp()).toBe(false);
    });

    it('should return true when __TAURI__ exists', () => {
      (global as any).__TAURI__ = {};
      expect(isTauriApp()).toBe(true);
    });
  });
});
