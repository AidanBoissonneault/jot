import { describe, expect, test } from 'vitest';
import { safeNotionErrorMetadata } from '@/apps/worker/src/workerUtils';

describe('safeNotionErrorMetadata', () => {
  test('includes the failed Notion operation without exposing quoted user content or IDs', () => {
    const error = Object.assign(new Error('Invalid value "private note text" for block 123e4567-e89b-42d3-a456-426614174000'), {
      code: 'validation_error',
      endpoint: '/blocks/123e4567-e89b-42d3-a456-426614174000/children',
      isNotionApiError: true,
      method: 'PATCH',
      status: 400,
    });

    expect(safeNotionErrorMetadata(error)).toEqual({
      type: 'Error',
      status: 400,
      code: 'validation_error',
      endpoint: '/blocks/:id/children',
      method: 'PATCH',
      detail: 'Invalid value [redacted] for block :id',
    });
  });
});
