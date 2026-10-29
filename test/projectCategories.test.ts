import { describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { ref } from 'vue';
import { useProjectCategories } from '@/entrypoints/sidepanel/composables/useProjectCategories';
import { resetBrowserStorage } from './setup';

describe('project category colors', () => {
  it('uses deterministic colors instead of importing the old palette', async () => {
    resetBrowserStorage({ inkwellCategoryColors: { test: '#405a78' } });
    setActivePinia(createPinia());
    const categories = useProjectCategories(
      ref<'project' | 'page' | 'category' | null>(null),
      async () => undefined,
    );

    await categories.loadCategoryColors();

    expect(categories.colorForCategory('test')).toBe('#824e5d');
  });
});
