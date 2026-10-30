import { describe, expect, it, vi } from 'vitest';
import { mapWithConcurrency } from '@/apps/worker/src/concurrency';

describe('mapWithConcurrency', () => {
  it('bounds active work and keeps results in input order', async () => {
    let active = 0;
    let maximumActive = 0;
    const results = await mapWithConcurrency([20, 1, 5, 2], 2, async (delay, index) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, delay));
      active -= 1;
      return index;
    });

    expect(maximumActive).toBe(2);
    expect(results).toEqual([0, 1, 2, 3]);
  });

  it('returns an empty result without calling the mapper for empty input', async () => {
    const map = vi.fn(async (value: string) => value);

    await expect(mapWithConcurrency<string, string>([], 3, map)).resolves.toEqual([]);
    expect(map).not.toHaveBeenCalled();
  });
});
