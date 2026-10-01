/**
 * @file Registers cross-origin policy, legal pages, application sessions, and Notion OAuth routes.
 * @author Aidan Boissonneault
 * @lastModified September 2026
 */

import type { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { randomUUID } from 'node:crypto';
import { closePage, legalPage, privacyBody, termsBody } from '../htmlPages.js';
import {
  createNotionOAuthState,
  exchangeNotionCode,
  notionOAuthGenerationFromState,
  notionUserFromToken,
  revokeNotionToken,
} from '../notionAuth.js';
import {
  MAX_CONTROL_JSON_REQUEST_BYTES,
  hash,
  isTrustedOrigin,
  randomToken,
  readLimitedJsonBody,
  serverBaseUrl,
} from '../workerUtils.js';
import {
  INKWELL_SESSION_COOKIE,
  auth,
  getInkwellSession,
  readInkwellSyncState,
  requireInkwellSession,
  supabase,
} from '../services/workerRuntime.js';
import type { WorkerEnv } from '../types.js';

const INKWELL_OAUTH_STATE_COOKIE = 'inkwell_notion_oauth_state';
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

/**
 * Registers middleware, legal documents, OAuth, session, logout, and diagnostic routes.
 * @param app - Worker Hono application.
 * @returns Nothing.
 */
export function registerAuthRoutes(app: Hono<{ Bindings: WorkerEnv }>): void {
  /** Applies CORS headers and handles preflight requests. @param c - Hono context. @param next - Downstream middleware. @returns Middleware response. */
  app.use('*', async (c, next) => {
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
    c.header('Cache-Control', 'no-store');
    if (c.req.path !== '/youtube/embed') c.header('X-Frame-Options', 'DENY');
    if (serverBaseUrl(c.env).startsWith('https://')) {
      c.header('Strict-Transport-Security', 'max-age=31536000');
    }

    const origin = c.req.header('origin');
    const trusted = isTrustedOrigin(c.env, origin);
    const isWebhook =
      c.req.path === '/webhooks/notion' ||
      /^\/webhooks\/notion\/[A-Za-z0-9_-]+$/.test(c.req.path);
    const isWebhookSetup =
      (c.req.path === '/webhooks/notion/setup/arm' && c.req.method === 'POST') ||
      (c.req.path === '/webhooks/notion/verification-token' &&
        ['GET', 'DELETE'].includes(c.req.method));
    const isMutation = !['GET', 'HEAD', 'OPTIONS'].includes(c.req.method);

    if (trusted && origin) {
      c.header('Access-Control-Allow-Origin', origin);
      c.header('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
      c.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, X-Inkwell-Account');
      c.header('Access-Control-Allow-Credentials', 'true');
      c.header('Vary', 'Origin');
    }

    if (c.req.method === 'OPTIONS') return c.body(null, trusted ? 204 : 403);
    if (isWebhookSetup && origin && !trusted) {
      return c.json({ error: 'Untrusted origin.' }, 403);
    }
    if (isMutation && !isWebhook && !isWebhookSetup && !trusted) {
      return c.json({ error: 'Untrusted origin.' }, 403);
    }

    const requiresAccountBinding =
      (c.req.path.startsWith('/sync/') && c.req.path !== '/sync/events') ||
      c.req.path.startsWith('/media/');
    if (requiresAccountBinding && c.req.method !== 'OPTIONS') {
      const session = await getInkwellSession(c);
      if (!session) return c.json({ error: 'Unauthorized' }, 401);
      const expectedAccountId = c.req.header('x-inkwell-account');
      if (!expectedAccountId) {
        return c.json({ error: 'Refresh the Inkwell session before syncing.' }, 428);
      }
      if (expectedAccountId !== session.user.id) {
        return c.json({ error: 'The active Notion account changed. Refresh the Inkwell session before syncing.' }, 409);
      }
    }

    await next();
  });
  
  /** Serves the terms page. @param c - Hono context. @returns HTML response. */
  app.get('/terms', (c) => c.html(legalPage('Terms of Service', termsBody())));
  /** Serves the privacy page. @param c - Hono context. @returns HTML response. */
  app.get('/privacy', (c) => c.html(legalPage('Privacy Policy', privacyBody())));
  
  // ─── Auth routes ──────────────────────────────────────────────────────────────
  
  /** Serves the successful authentication close page. @param c - Hono context. @returns HTML response. */
  app.get('/auth/inkwell/complete', (c) =>
    c.html(closePage('You are logged in to Inkwell. You can return to the side panel.')),
  );
  
  /** Serves the failed authentication close page. @param c - Hono context. @returns HTML response. */
  app.get('/auth/inkwell/error', (c) =>
    c.html(closePage('Inkwell login did not complete. You can close this tab and try again.'), 400),
  );
  
  /** Starts the Notion OAuth flow. @param c - Hono context. @returns Redirect response. */
  app.get('/auth/notion/start', async (c) => {
    const env = c.env;
  
    if (!env.NOTION_OAUTH_CLIENT_ID || !env.NOTION_OAUTH_CLIENT_SECRET) {
      return c.html(closePage('Notion login is not configured on the sync server yet.'), 503);
    }
  
    const workerUrl = serverBaseUrl(env);
    let state: string;
    try {
      const generation = await auth.getNotionOAuthGeneration();
      state = await createNotionOAuthState(env.NOTION_OAUTH_CLIENT_SECRET, generation);
    } catch {
      return c.html(closePage('Notion login could not be started. Please try again.'), 503);
    }
    const redirectUri = `${workerUrl}/auth/notion/callback`;
    const url = new URL('https://api.notion.com/v1/oauth/authorize');
    url.searchParams.set('client_id', env.NOTION_OAUTH_CLIENT_ID);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('owner', 'user');
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('state', state);
  
    setCookie(c, INKWELL_OAUTH_STATE_COOKIE, state, {
      httpOnly: true,
      maxAge: 600,
      path: '/auth/notion',
      sameSite: 'Lax',
      secure: workerUrl.startsWith('https://'),
    });
  
    return c.redirect(url.toString());
  });
  
  /** Completes OAuth and creates an application session. @param c - Hono context. @returns Redirect response. */
  app.get('/auth/notion/callback', async (c) => {
    const env = c.env;
    if (!env.NOTION_OAUTH_CLIENT_SECRET) {
      return c.html(closePage('Notion login is not configured on the sync server yet.'), 503);
    }
    const expectedState = getCookie(c, INKWELL_OAUTH_STATE_COOKIE);
    const state = c.req.query('state') ?? '';
    const code = c.req.query('code') ?? '';
    const error = c.req.query('error') ?? '';
  
    deleteCookie(c, INKWELL_OAUTH_STATE_COOKIE, { path: '/auth/notion' });
  
    if (error) {
      return c.html(closePage('Notion login did not complete. You can close this tab and try again.'), 400);
    }
  
    if (!code || !state || !expectedState || state !== expectedState) {
      return c.html(closePage('Notion login could not be verified. You can close this tab and try again.'), 400);
    }
    const oauthGeneration = await notionOAuthGenerationFromState(env.NOTION_OAUTH_CLIENT_SECRET, state)
      .catch(() => null);
    if (oauthGeneration === null) {
      return c.html(closePage('Notion login could not be verified. You can close this tab and try again.'), 400);
    }
  
    let exchangedAccessToken: string | undefined;
    let sessionCommitted = false;
    try {
      const tokens = await exchangeNotionCode(env, code, `${serverBaseUrl(env)}/auth/notion/callback`);
      exchangedAccessToken = tokens.access_token;
      const user = notionUserFromToken(tokens);
      const userId = `notion:${user.id}`;
  
      const { sessionToken } = await auth.createNotionSession({
        userId,
        notionAccountId: user.id,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        workspaceId: tokens.workspace_id,
        workspaceName: tokens.workspace_name,
        user,
        ipAddress: c.req.header('cf-connecting-ip') ?? null,
        userAgent: c.req.header('user-agent') ?? null,
        sessionToken: randomToken(),
        sessionId: randomUUID(),
        SESSION_MAX_AGE_SECONDS,
        oauthGeneration,
      });
      sessionCommitted = true;
  
      setCookie(c, INKWELL_SESSION_COOKIE, sessionToken, {
        httpOnly: true,
        maxAge: SESSION_MAX_AGE_SECONDS,
        path: '/',
        sameSite: 'Lax',
        secure: serverBaseUrl(env).startsWith('https://'),
      });
  
      return c.html(closePage('You are logged in to Inkwell. You can return to the side panel.'));
    } catch {
      if (exchangedAccessToken && !sessionCommitted) {
        await revokeNotionToken(env, exchangedAccessToken);
      }
      console.error('Failed to complete Notion login');
      return c.html(closePage('Notion login failed. You can close this tab and try again.'), 500);
    }
  });
  
  /** Returns the active application and Notion session. @param c - Hono context. @returns JSON response. */
  app.get('/session', async (c) => {
    const session = await getInkwellSession(c);
    const installation = session
      ? await auth.getActiveInstallation(session.user.id).catch(() => undefined)
      : undefined;
  
    return c.json({
      authenticated: Boolean(session),
      userId: session?.user.id,
      userName: session?.user.name,
      userEmail: session?.user.email,
      connected: Boolean(installation),
      workspaceId: installation?.workspace_id,
      workspaceName: installation?.workspace_name,
    });
  });
  
  /** Revokes the active installation and clears its session. @param c - Hono context. @returns JSON response. */
  app.post('/auth/notion/logout', async (c) => {
    const session = await requireInkwellSession(c);
    if (!session) {
      deleteCookie(c, INKWELL_SESSION_COOKIE, { path: '/' });
      return c.json({ connected: false, loggedOut: false, notionTokenRevoked: false, retryable: false }, 401);
    }

    const token = getCookie(c, INKWELL_SESSION_COOKIE);
    if (!token) {
      deleteCookie(c, INKWELL_SESSION_COOKIE, { path: '/' });
      return c.json({ connected: false, loggedOut: false, notionTokenRevoked: false, retryable: false }, 401);
    }

    try {
      // The database lock invalidates older OAuth states and prevents a callback
      // from restoring credentials until this logout has fully completed.
      await auth.beginNotionLogout(session.user.id);
    } catch {
      // Keep logout usable if the serialization migration is not deployed yet.
      // This path still clears credentials, but cannot guarantee the OAuth race is closed.
      const notionTokens = await auth.getNotionAccountTokens(session.user.id).catch(() => null);
      await auth.revokeInstallation(session.user.id).catch(() => undefined);
      const notionTokenRevoked = notionTokens?.accessToken
        ? await revokeNotionToken(c.env, notionTokens.accessToken)
        : false;
      await auth.clearNotionAccountTokens(session.user.id).catch(() => undefined);
      await auth.deleteCustomSession(token).catch(() => undefined);
      deleteCookie(c, INKWELL_SESSION_COOKIE, { path: '/' });
      return c.json({
        connected: false,
        loggedOut: true,
        notionTokenRevoked,
        serverDataCleanupComplete: false,
        retryable: false,
      });
    }

    const notionTokens = await auth.getNotionAccountTokens(session.user.id).catch(() => null);
    const notionTokenRevoked = notionTokens?.accessToken
      ? await revokeNotionToken(c.env, notionTokens.accessToken)
      : false;
    let completed = false;
    for (let attempt = 0; attempt < 2 && !completed; attempt += 1) {
      try {
        await auth.completeNotionLogout(session.user.id, token);
        completed = true;
      } catch {
        // The operation is idempotent, so retry once if its response was lost.
      }
    }
    if (!completed) {
      // The cookie remains available so a user can retry after the database recovers.
      return c.json({
        connected: false,
        loggedOut: false,
        notionTokenRevoked,
        serverDataCleanupComplete: false,
        retryable: true,
      }, 503);
    }

    deleteCookie(c, INKWELL_SESSION_COOKIE, { path: '/' });
    return c.json({
      connected: false,
      loggedOut: true,
      notionTokenRevoked,
      serverDataCleanupComplete: true,
      retryable: false,
    });
  });

  /** Deletes Inkwell's account data and Notion connection while preserving Notion pages. */
  app.post('/auth/notion/delete-connection', async (c) => {
    const parsed = await readLimitedJsonBody<{ requestId?: unknown }>(c.req.raw, MAX_CONTROL_JSON_REQUEST_BYTES);
    if (parsed.tooLarge) return c.json({ deleted: false, error: 'Deletion request is too large.' }, 413);
    const requestId = parsed.body?.requestId;
    if (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{40,128}$/.test(requestId)) {
      return c.json({ deleted: false, error: 'Invalid deletion request.' }, 400);
    }

    const requestIdHash = hash(requestId);
    let receipt = null;
    try {
      receipt = await auth.getConnectionDeletionReceipt(requestIdHash);
    } catch {
      return c.json({ deleted: false, error: 'Unable to verify the deletion request.' }, 503);
    }

    if (receipt?.status === 'completed') {
      deleteCookie(c, INKWELL_SESSION_COOKIE, { path: '/' });
      return c.json({ deleted: true, notionTokenRevoked: receipt.notionTokenRevoked });
    }

    const session = await requireInkwellSession(c);
    if (!session) {
      if (receipt?.status === 'pending' && receipt.userId) {
        try {
          if (!(await auth.hasInkwellUser(receipt.userId))) {
            await auth.completeConnectionDeletionReceipt(requestIdHash);
            deleteCookie(c, INKWELL_SESSION_COOKIE, { path: '/' });
            return c.json({ deleted: true, notionTokenRevoked: receipt.notionTokenRevoked });
          }
        } catch {
          return c.json({ deleted: false, error: 'Unable to finish the deletion request.' }, 503);
        }
      }
      deleteCookie(c, INKWELL_SESSION_COOKIE, { path: '/' });
      return c.json({ deleted: false, notionTokenRevoked: false }, 401);
    }

    if (receipt?.userId && receipt.userId !== session.user.id) {
      return c.json({ deleted: false, error: 'Deletion request does not match this account.' }, 403);
    }

    try {
      // This transaction serializes with OAuth commits and stops queue work
      // before we read the credential that must be revoked at Notion.
      receipt = await auth.prepareConnectionDeletionReceipt(requestIdHash, session.user.id);
    } catch {
      return c.json({ deleted: false, error: 'Unable to prepare the deletion request.' }, 503);
    }
    if (receipt.userId && receipt.userId !== session.user.id) {
      return c.json({ deleted: false, error: 'Deletion request does not match this account.' }, 403);
    }
    if (receipt.status === 'completed') {
      deleteCookie(c, INKWELL_SESSION_COOKIE, { path: '/' });
      return c.json({ deleted: true, notionTokenRevoked: receipt.notionTokenRevoked });
    }

    let notionTokens;
    try {
      notionTokens = await auth.getNotionAccountTokens(session.user.id);
    } catch {
      return c.json({ deleted: false, error: 'Unable to verify the Notion connection.' }, 503);
    }

    const notionTokenRevoked = receipt.notionTokenRevoked || (
      notionTokens?.accessToken
        ? await revokeNotionToken(c.env, notionTokens.accessToken)
        : false
    );

    try {
      await auth.updateConnectionDeletionRevocation(requestIdHash, notionTokenRevoked);
      await auth.completeConnectionDeletionReceipt(requestIdHash);
    } catch {
      return c.json({ deleted: false, notionTokenRevoked }, 500);
    }

    deleteCookie(c, INKWELL_SESSION_COOKIE, { path: '/' });
    return c.json({ deleted: true, notionTokenRevoked });
  });
  
  /** Returns recent installation diagnostics. @param c - Hono context. @returns JSON response. */
  app.get('/logs', async (c) => {
    const session = await requireInkwellSession(c);
    if (!session) return c.json({ error: 'Unauthorized' }, 401);
    const installation = await auth.getActiveInstallation(session.user.id).catch(() => null);
    if (!installation) return c.json({ logs: [] });
    const store = await readInkwellSyncState(installation.id);
    return c.json({ logs: store.logs.slice(-100) });
  });
}

