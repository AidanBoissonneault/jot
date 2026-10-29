export const DEFAULT_INTERFACE_SCALE = 100;
export const MIN_INTERFACE_SCALE = 80;
export const MAX_INTERFACE_SCALE = 150;
export const INTERFACE_SCALE_STEP = 5;

const USER_PREFERENCES_KEY = 'jottathingUserPreferences';
const THEME_PREFERENCE_KEY = 'jottathingThemePreference';

export type ThemePreference = 'system' | 'light' | 'dark';

export type UserPreferences = {
  interfaceScale: number;
};

export function normalizeThemePreference(value: unknown): ThemePreference {
  return value === 'light' || value === 'dark' || value === 'system' ? value : 'system';
}

export async function loadThemePreference(): Promise<ThemePreference> {
  const stored = await browser.storage.local.get(THEME_PREFERENCE_KEY);
  return normalizeThemePreference(stored[THEME_PREFERENCE_KEY]);
}

export async function saveThemePreference(value: ThemePreference): Promise<ThemePreference> {
  const normalized = normalizeThemePreference(value);
  await browser.storage.local.set({ [THEME_PREFERENCE_KEY]: normalized });
  return normalized;
}

export function normalizeInterfaceScale(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_INTERFACE_SCALE;
  }

  const rounded = Math.round(value / INTERFACE_SCALE_STEP) * INTERFACE_SCALE_STEP;
  return Math.min(MAX_INTERFACE_SCALE, Math.max(MIN_INTERFACE_SCALE, rounded));
}

export function normalizeUserPreferences(value: unknown): UserPreferences {
  if (!value || typeof value !== 'object') {
    return { interfaceScale: DEFAULT_INTERFACE_SCALE };
  }

  return {
    interfaceScale: normalizeInterfaceScale(
      (value as Partial<UserPreferences>).interfaceScale,
    ),
  };
}

export async function loadUserPreferences(): Promise<UserPreferences> {
  const stored = await browser.storage.local.get(USER_PREFERENCES_KEY);
  return normalizeUserPreferences(stored[USER_PREFERENCES_KEY]);
}

export async function saveUserPreferences(
  preferences: UserPreferences,
): Promise<UserPreferences> {
  const normalized = normalizeUserPreferences(preferences);
  await browser.storage.local.set({ [USER_PREFERENCES_KEY]: normalized });
  return normalized;
}
