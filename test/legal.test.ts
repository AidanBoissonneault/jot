import { describe, expect, it } from 'vitest';
import {
  currentLegalAcceptance,
  hasAcceptedCurrentLegalTerms,
  isCurrentLegalAcceptance,
  LEGAL_PRIVACY_URL,
  LEGAL_PRIVACY_VERSION,
  LEGAL_TERMS_URL,
  LEGAL_TERMS_VERSION,
  storeCurrentLegalAcceptance,
} from '@/src/services/legal';
import { resetBrowserStorage } from './setup';
import { app } from '@/apps/worker/src/worker';

describe('legal acceptance', () => {
  it('requires the current terms and privacy versions', () => {
    const acceptance = currentLegalAcceptance(new Date('2026-05-13T12:00:00.000Z'));

    expect(isCurrentLegalAcceptance(acceptance)).toBe(true);
    expect(
      isCurrentLegalAcceptance({
        ...acceptance,
        privacyVersion: '2026-05-12',
      }),
    ).toBe(false);
    expect(
      isCurrentLegalAcceptance({
        ...acceptance,
        termsUrl: 'https://example.com/terms',
      }),
    ).toBe(false);
  });

  it('persists and reads the current acceptance record', async () => {
    resetBrowserStorage();

    await expect(hasAcceptedCurrentLegalTerms()).resolves.toBe(false);

    const acceptance = await storeCurrentLegalAcceptance();

    expect(acceptance).toMatchObject({
      privacyUrl: LEGAL_PRIVACY_URL,
      privacyVersion: LEGAL_PRIVACY_VERSION,
      termsUrl: LEGAL_TERMS_URL,
      termsVersion: LEGAL_TERMS_VERSION,
    });
    await expect(hasAcceptedCurrentLegalTerms()).resolves.toBe(true);
  });
});

describe('legal pages', () => {
  it('serves public terms and privacy pages', async () => {
    const terms = await app.request('https://inkwell.byaidan.com/terms', {}, {});
    const privacy = await app.request('https://inkwell.byaidan.com/privacy', {}, {});

    await expect(terms.text()).resolves.toContain('Terms of Service');
    expect(terms.status).toBe(200);
    expect(terms.headers.get('content-type')).toContain('text/html');

    const privacyHtml = await privacy.text();
    expect(privacy.status).toBe(200);
    expect(privacy.headers.get('content-type')).toContain('text/html');
    expect(privacyHtml).toContain('Privacy Policy');
    expect(privacyHtml).toContain('Chrome Web Store User Data Policy');
  });
});
