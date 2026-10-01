import { describe, expect, it } from 'vitest';
import {
  createNotionOAuthState,
  notionOAuthGenerationFromState,
} from '@/apps/worker/src/notionAuth';

describe('signed Notion OAuth state', () => {
  it('round trips the generation and rejects state altered by the client', async () => {
    const state = await createNotionOAuthState('client-secret-test', '42');
    await expect(notionOAuthGenerationFromState('client-secret-test', state)).resolves.toBe('42');
    await expect(notionOAuthGenerationFromState('client-secret-test', state.replace('.42.', '.43.')))
      .resolves.toBeNull();
    await expect(notionOAuthGenerationFromState('different-secret', state)).resolves.toBeNull();
  });

  it('rejects invalid generations before issuing state', async () => {
    await expect(createNotionOAuthState('client-secret-test', '-1')).rejects.toThrow('Invalid OAuth generation.');
    await expect(createNotionOAuthState('client-secret-test', '9223372036854775808'))
      .rejects.toThrow('Invalid OAuth generation.');
  });
});
