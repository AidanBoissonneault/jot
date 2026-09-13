const ONBOARDING_STORAGE_KEY = 'inkwellOnboardingVersion';

export const CURRENT_ONBOARDING_VERSION = 1;

export async function hasCompletedOnboarding(): Promise<boolean> {
  const stored = await browser.storage.local.get(ONBOARDING_STORAGE_KEY);
  return stored[ONBOARDING_STORAGE_KEY] === CURRENT_ONBOARDING_VERSION;
}

export async function completeOnboarding(): Promise<void> {
  await browser.storage.local.set({
    [ONBOARDING_STORAGE_KEY]: CURRENT_ONBOARDING_VERSION,
  });
}
