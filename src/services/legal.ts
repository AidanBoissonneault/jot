export const LEGAL_TERMS_URL = 'https://sync.jottathing.byaidan.com/terms';
export const LEGAL_PRIVACY_URL = 'https://sync.jottathing.byaidan.com/privacy';
export const LEGAL_TERMS_VERSION = '2026-10-13';
export const LEGAL_PRIVACY_VERSION = '2026-09-30';

const LEGAL_ACCEPTANCE_KEY = 'jottathingLegalAcceptance';
const LEGACY_LEGAL_ACCEPTANCE_KEY = 'inkwellLegalAcceptance';

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
  const stored = await browser.storage.local.get([LEGAL_ACCEPTANCE_KEY, LEGACY_LEGAL_ACCEPTANCE_KEY]);
  const current = stored[LEGAL_ACCEPTANCE_KEY];
  if (isCurrentLegalAcceptance(current)) return true;

  const legacy = stored[LEGACY_LEGAL_ACCEPTANCE_KEY];
  if (!isLegalAcceptanceShape(legacy)) return false;
  const migrated = {
    ...legacy,
    privacyUrl: legacy.privacyUrl.replace('sync.inkwell.byaidan.com', 'sync.jottathing.byaidan.com'),
    termsUrl: legacy.termsUrl.replace('sync.inkwell.byaidan.com', 'sync.jottathing.byaidan.com'),
  };
  await browser.storage.local.set({ [LEGAL_ACCEPTANCE_KEY]: migrated });
  return isCurrentLegalAcceptance(migrated);
}

function isLegalAcceptanceShape(value: unknown): value is LegalAcceptance {
  if (!value || typeof value !== 'object') return false;
  const acceptance = value as Partial<LegalAcceptance>;
  return typeof acceptance.acceptedAt === 'string' &&
    typeof acceptance.privacyUrl === 'string' &&
    typeof acceptance.termsUrl === 'string' &&
    typeof acceptance.privacyVersion === 'string' &&
    typeof acceptance.termsVersion === 'string';
}

export async function storeCurrentLegalAcceptance(): Promise<LegalAcceptance> {
  const acceptance = currentLegalAcceptance();
  await browser.storage.local.set({ [LEGAL_ACCEPTANCE_KEY]: acceptance });
  return acceptance;
}
