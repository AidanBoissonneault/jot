export const LEGAL_TERMS_URL = 'https://inkwell.byaidan.com/terms';
export const LEGAL_PRIVACY_URL = 'https://inkwell.byaidan.com/privacy';
export const LEGAL_TERMS_VERSION = '2026-05-09';
export const LEGAL_PRIVACY_VERSION = '2026-05-13';

const LEGAL_ACCEPTANCE_KEY = 'inkwellLegalAcceptance';

export type LegalAcceptance = {
  acceptedAt: string;
  privacyUrl: string;
  privacyVersion: string;
  termsUrl: string;
  termsVersion: string;
};

export function currentLegalAcceptance(now = new Date()): LegalAcceptance {
  return {
    acceptedAt: now.toISOString(),
    privacyUrl: LEGAL_PRIVACY_URL,
    privacyVersion: LEGAL_PRIVACY_VERSION,
    termsUrl: LEGAL_TERMS_URL,
    termsVersion: LEGAL_TERMS_VERSION,
  };
}

export function isCurrentLegalAcceptance(value: unknown): value is LegalAcceptance {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const acceptance = value as Partial<LegalAcceptance>;
  return (
    typeof acceptance.acceptedAt === 'string' &&
    acceptance.privacyUrl === LEGAL_PRIVACY_URL &&
    acceptance.privacyVersion === LEGAL_PRIVACY_VERSION &&
    acceptance.termsUrl === LEGAL_TERMS_URL &&
    acceptance.termsVersion === LEGAL_TERMS_VERSION
  );
}

export async function hasAcceptedCurrentLegalTerms(): Promise<boolean> {
  const stored = await browser.storage.local.get(LEGAL_ACCEPTANCE_KEY);
  return isCurrentLegalAcceptance(stored[LEGAL_ACCEPTANCE_KEY]);
}

export async function storeCurrentLegalAcceptance(): Promise<LegalAcceptance> {
  const acceptance = currentLegalAcceptance();
  await browser.storage.local.set({ [LEGAL_ACCEPTANCE_KEY]: acceptance });
  return acceptance;
}
