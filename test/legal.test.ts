import { describe, expect, it } from 'vitest';
import {
  hasAcceptedCurrentLegalTerms,
  LEGAL_PRIVACY_URL,
  LEGAL_TERMS_URL,
  storeCurrentLegalAcceptance,
} from '@/src/services/legal';
import { resetBrowserStorage } from './setup';
import { app } from '@/apps/worker/src/worker';

describe('legal acceptance', () => {
  it('rejects an acceptance record with an outdated version or changed URL', async () => {
    resetBrowserStorage();
    const acceptance = await storeCurrentLegalAcceptance();

    resetBrowserStorage({
      jottathingLegalAcceptance: { ...acceptance, privacyVersion: 'outdated' },
    });
    await expect(hasAcceptedCurrentLegalTerms()).resolves.toBe(false);

    resetBrowserStorage({
      jottathingLegalAcceptance: { ...acceptance, termsUrl: 'https://example.com/terms' },
    });
    await expect(hasAcceptedCurrentLegalTerms()).resolves.toBe(false);
  });

  it('persists and reads the current acceptance record', async () => {
    resetBrowserStorage();

    await expect(hasAcceptedCurrentLegalTerms()).resolves.toBe(false);

    const acceptance = await storeCurrentLegalAcceptance();

    expect(acceptance).toMatchObject({
      privacyUrl: LEGAL_PRIVACY_URL,
      termsUrl: LEGAL_TERMS_URL,
    });
    await expect(hasAcceptedCurrentLegalTerms()).resolves.toBe(true);
  });

  it('requires a fresh acceptance instead of rewriting an old branded record', async () => {
    const oldAcceptance = {
      acceptedAt: '2026-05-13T12:00:00.000Z',
      privacyUrl: 'https://sync.inkwell.byaidan.com/privacy',
      privacyVersion: '2026-05-12',
      termsUrl: 'https://sync.inkwell.byaidan.com/terms',
      termsVersion: '2026-05-12',
    };
    resetBrowserStorage({ inkwellLegalAcceptance: oldAcceptance });

    await expect(hasAcceptedCurrentLegalTerms()).resolves.toBe(false);
  });
});

describe('legal pages', () => {
  it('serves public terms and privacy pages', async () => {
    const terms = await app.request('https://jottathing.byaidan.com/terms', {}, {});
    const privacy = await app.request('https://jottathing.byaidan.com/privacy', {}, {});

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
