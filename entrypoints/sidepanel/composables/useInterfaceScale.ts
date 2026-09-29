/** @file Persisted sidepanel display scale and immediate preview behavior. */
import { computed, ref, watch } from 'vue';
import {
  DEFAULT_INTERFACE_SCALE,
  INTERFACE_SCALE_STEP,
  loadUserPreferences,
  MAX_INTERFACE_SCALE,
  MIN_INTERFACE_SCALE,
  normalizeInterfaceScale,
  saveUserPreferences,
} from '@/src/services/preferences';

export {
  INTERFACE_SCALE_STEP,
  MAX_INTERFACE_SCALE,
  MIN_INTERFACE_SCALE,
} from '@/src/services/preferences';

/**
 * Owns the sidepanel's persisted display scale, slider preview, presets, and
 * root font-size update so settings UI only needs to call these operations.
 */
export function useInterfaceScale() {
  const interfaceScale = ref(DEFAULT_INTERFACE_SCALE);

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
        '--inkwell-base-font-size',
        `${(14 * scale) / 100}px`,
      );
    },
    { immediate: true },
  );

  async function loadPreferences() {
    const preferences = await loadUserPreferences();
    interfaceScale.value = preferences.interfaceScale;
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

  function setInterfaceScale(scale: number) {
    interfaceScale.value = normalizeInterfaceScale(scale);
    void persistInterfaceScale();
  }

  return {
    interfaceScale,
    interfaceScaleLabel,
    loadPreferences,
    previewInterfaceScale,
    persistInterfaceScale,
    setInterfaceScale,
  };
}
