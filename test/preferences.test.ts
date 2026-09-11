import { describe, expect, it } from 'vitest';
import {
  DEFAULT_INTERFACE_SCALE,
  loadUserPreferences,
  normalizeInterfaceScale,
  normalizeUserPreferences,
  saveUserPreferences,
} from '@/src/services/preferences';
import { resetBrowserStorage } from './setup';

describe('user preferences', () => {
  it('normalizes interface scale to a safe five-percent step', () => {
    expect(normalizeInterfaceScale(113)).toBe(115);
    expect(normalizeInterfaceScale(40)).toBe(80);
    expect(normalizeInterfaceScale(200)).toBe(150);
    expect(normalizeInterfaceScale('120')).toBe(DEFAULT_INTERFACE_SCALE);
  });

  it('uses defaults for missing or invalid stored settings', () => {
    expect(normalizeUserPreferences(undefined)).toEqual({
      interfaceScale: DEFAULT_INTERFACE_SCALE,
    });
    expect(normalizeUserPreferences({ interfaceScale: Number.NaN })).toEqual({
      interfaceScale: DEFAULT_INTERFACE_SCALE,
    });
  });

  it('persists the interface scale in extension storage', async () => {
    resetBrowserStorage();

    await expect(loadUserPreferences()).resolves.toEqual({ interfaceScale: 100 });
    await saveUserPreferences({ interfaceScale: 123 });
    await expect(loadUserPreferences()).resolves.toEqual({ interfaceScale: 125 });
  });
});
