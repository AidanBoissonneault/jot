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
  deleteNotionWebhook,
  exchangeNotionCode,
  notionUserFromToken,
  registerNotionWebhook,
} from '../notionAuth.js';
import { isTrustedOrigin, randomToken, serverBaseUrl } from '../workerUtils.js';
import {
  INKWELL_SESSION_COOKIE,
  auth,
  ensureInkwellSyncStateRow,
  getInkwellSession,
  readStore,
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
    const origin = c.req.header('origin');
    const trusted = isTrustedOrigin(c.env, origin);
  
    c.header('Access-Control-Allow-Origin', trusted ? origin : '*');
    c.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    c.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
    c.header('Access-Control-Allow-Credentials', 'true');
  
    if (c.req.method === 'OPTIONS') return c.body(null, 204);
  
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
    const state = randomToken(24);
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
  
    try {
      const tokens = await exchangeNotionCode(env, code, `${serverBaseUrl(env)}/auth/notion/callback`);
      const user = notionUserFromToken(tokens);
      const userId = `notion:${user.id}`;
  
      const { sessionToken, installationId } = await auth.createNotionSession({
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
      });
  
      if (installationId) {
        await ensureInkwellSyncStateRow(installationId);
        await registerNotionWebhook(
          env,
          supabase,
          installationId,
          tokens.access_token,
          serverBaseUrl(env),
        ).catch(() => undefined);
      }
  
      setCookie(c, INKWELL_SESSION_COOKIE, sessionToken, {
        httpOnly: true,
        maxAge: SESSION_MAX_AGE_SECONDS,
        path: '/',
        sameSite: 'Lax',
        secure: serverBaseUrl(env).startsWith('https://'),
      });
  
      return c.html(closePage('You are logged in to Inkwell. You can return to the side panel.'));
    } catch (err) {
      console.error('Failed to complete Notion login', err);
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
    if (!session) return;
  
    const token = getCookie(c, INKWELL_SESSION_COOKIE);
    const installation = await auth.getActiveInstallation(session.user.id).catch(() => undefined);
    if (installation?.id) {
      await deleteNotionWebhook(c.env, supabase, installation.id).catch(() => undefined);
    }
    await auth.revokeInstallation(session.user.id);
    await auth.deleteCustomSession(token);
    deleteCookie(c, INKWELL_SESSION_COOKIE, { path: '/' });
  
    return c.json({ connected: false });
  });
  
  /** Returns recent installation diagnostics. @param c - Hono context. @returns JSON response. */
  app.get('/logs', async (c) => {
    const store = await readStore();
    return c.json({ logs: store.logs.slice(-100) });
  });
}

