import { describe, expect, it } from 'vitest';
import {
  completeOnboarding,
  CURRENT_ONBOARDING_VERSION,
  hasCompletedOnboarding,
} from '@/src/services/onboarding';
import { resetBrowserStorage } from './setup';

describe('onboarding state', () => {
  it('persists completion for the current onboarding version', async () => {
    resetBrowserStorage();

    await expect(hasCompletedOnboarding()).resolves.toBe(false);
    await completeOnboarding();
    await expect(hasCompletedOnboarding()).resolves.toBe(true);
    await expect(browser.storage.local.get('inkwellOnboardingVersion')).resolves.toEqual({
      inkwellOnboardingVersion: CURRENT_ONBOARDING_VERSION,
    });
  });
});
