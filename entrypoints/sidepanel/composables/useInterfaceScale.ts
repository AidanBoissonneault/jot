/** @file Persisted sidepanel appearance preferences and immediate updates. */
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import {
  DEFAULT_INTERFACE_SCALE,
  INTERFACE_SCALE_STEP,
  loadUserPreferences,
  MAX_INTERFACE_SCALE,
  MIN_INTERFACE_SCALE,
  normalizeInterfaceScale,
  loadThemePreference,
  saveUserPreferences,
  saveThemePreference,
  type ThemePreference,
} from '@/src/services/preferences';

export {
  INTERFACE_SCALE_STEP,
  MAX_INTERFACE_SCALE,
  MIN_INTERFACE_SCALE,
} from '@/src/services/preferences';

/**
 * Owns the sidepanel's persisted display scale, system theme, and root styles.
 */
export function useInterfaceScale() {
  const interfaceScale = ref(DEFAULT_INTERFACE_SCALE);
  const themePreference = ref<ThemePreference>('system');
  const systemThemeQuery = window.matchMedia('(prefers-color-scheme: dark)');
  const prefersDark = ref(systemThemeQuery.matches);
  const resolvedTheme = computed(() =>
    themePreference.value === 'system'
      ? (prefersDark.value ? 'dark' : 'light')
      : themePreference.value,
  );

  const interfaceScaleLabel = computed(() => {
    if (interfaceScale.value < 100) return 'Compact';
    if (interfaceScale.value === 100) return 'Default';
    if (interfaceScale.value <= 120) return 'Large';
    return 'Extra large';
  });

  watch(
    interfaceScale,
    (scale) => {
      document.documentElement.style.setProperty(
        '--jottathing-base-font-size',
        `${(14 * scale) / 100}px`,
      );
    },
    { immediate: true },
  );

  watch(
    resolvedTheme,
    (theme) => {
      document.documentElement.dataset.theme = theme;
    },
    { immediate: true },
  );

  function handleSystemThemeChange(event: MediaQueryListEvent) {
    prefersDark.value = event.matches;
  }
  systemThemeQuery.addEventListener('change', handleSystemThemeChange);
  onBeforeUnmount(() => systemThemeQuery.removeEventListener('change', handleSystemThemeChange));

  async function loadPreferences() {
    const [preferences, theme] = await Promise.all([loadUserPreferences(), loadThemePreference()]);
    interfaceScale.value = preferences.interfaceScale;
    themePreference.value = theme;
  }

  function previewInterfaceScale(event: Event) {
    interfaceScale.value = normalizeInterfaceScale(
      Number((event.target as HTMLInputElement).value),
    );
  }

  async function persistInterfaceScale() {
    const preferences = await saveUserPreferences({
      interfaceScale: interfaceScale.value,
    });
    interfaceScale.value = preferences.interfaceScale;
  }

  async function setThemePreference(theme: ThemePreference) {
    themePreference.value = theme;
    await saveThemePreference(theme);
  }

  return {
    interfaceScale,
    interfaceScaleLabel,
    themePreference,
    setThemePreference,
    loadPreferences,
    previewInterfaceScale,
    persistInterfaceScale,
  };
}
