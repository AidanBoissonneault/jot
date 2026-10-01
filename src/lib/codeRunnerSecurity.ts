export const MAX_CODE_RUN_LENGTH = 256 * 1024;
export const MAX_CODE_OUTPUT_MESSAGES = 100;
export const MAX_CODE_OUTPUT_LENGTH = 16 * 1024;

export type CodeRunnerRequest = {
  type: 'inkwell.codeRunner.run';
  token: string;
  language: 'javascript' | 'html';
  code: string;
};

/** Rejects malformed or oversized messages before they reach the code runner. */
export function isCodeRunnerRequest(value: unknown): value is CodeRunnerRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return candidate.type === 'inkwell.codeRunner.run' &&
    typeof candidate.token === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(candidate.token) &&
    (candidate.language === 'javascript' || candidate.language === 'html') &&
    typeof candidate.code === 'string' && candidate.code.length <= MAX_CODE_RUN_LENGTH;
}
