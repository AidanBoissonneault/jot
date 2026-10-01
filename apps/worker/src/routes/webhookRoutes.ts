/**
 * @file Registers Notion webhook verification and converts remote edits into local stale notifications.
 * @author Aidan Boissonneault
 * @lastModified September 2026
 */

import type { Context, Hono } from 'hono';
import { createHash, timingSafeEqual } from 'node:crypto';
import { verifyNotionWebhookSignature } from '../notionAuth.js';
import { supabase } from '../services/workerRuntime.js';
import type { JsonObject, WorkerEnv } from '../types.js';
import { randomToken, safeErrorMetadata, serverBaseUrl } from '../workerUtils.js';

const SETUP_ARM_WINDOW_SECONDS = 10 * 60;
const MAX_VERIFICATION_TOKEN_LENGTH = 4096;

/**
 * Registers the Notion webhook endpoint.
 * @param app - Worker Hono application.
 * @returns Nothing.
 */
export function registerWebhookRoutes(app: Hono<{ Bindings: WorkerEnv }>): void {
  /** Opens the short setup window required before accepting an initial verification token. */
  app.post('/webhooks/notion/setup/arm', async (c) => {
    if (!isAuthorizedWebhookSetupRequest(c.req.raw, c.env)) {
      return c.json({ error: 'Unauthorized.' }, 401);
    }

    const callbackToken = randomToken(32);
    const callbackTokenHash = hashToken(callbackToken);
    const { data: armed, error } = await supabase.rpc('arm_notion_webhook_setup', {
      p_callback_token_hash: callbackTokenHash,
    });
    if (error) {
      console.error('[webhooks/notion] setup arm failed');
      return c.json({ error: 'Webhook setup is unavailable.' }, 503);
    }
    if (armed !== true) {
      return c.json({ error: 'A verification token is already configured.' }, 409);
    }

    const callbackUrl = new URL(
      `/webhooks/notion/${callbackToken}`,
      serverBaseUrl(c.env),
    ).toString();
    c.header('Cache-Control', 'no-store, private');
    c.header('Referrer-Policy', 'no-referrer');
    return c.json({ armed: true, callbackUrl, expiresInSeconds: SETUP_ARM_WINDOW_SECONDS });
  });

  /** Retrieves the captured token once for an authorized operator, without caching it. */
  app.get('/webhooks/notion/verification-token', async (c) => {
    c.header('Cache-Control', 'no-store, private');
    c.header('Pragma', 'no-cache');
    c.header('Referrer-Policy', 'no-referrer');
    if (!isAuthorizedWebhookSetupRequest(c.req.raw, c.env)) {
      return c.json({ error: 'Unauthorized.' }, 401);
    }

    const { data: token, error } = await supabase.rpc('consume_notion_webhook_verification_token');
    if (error) {
      console.error('[webhooks/notion] token retrieval failed');
      return c.json({ error: 'Webhook setup is unavailable.' }, 503);
    }
    if (typeof token !== 'string' || token.length === 0) {
      return c.json({ error: 'The verification token is unavailable or was already retrieved.' }, 409);
    }

    return c.json({ verificationToken: token });
  });

  /** Resets setup state so the operator can rotate/recreate the Notion webhook subscription. */
  app.delete('/webhooks/notion/verification-token', async (c) => {
    if (!isAuthorizedWebhookSetupRequest(c.req.raw, c.env)) {
      return c.json({ error: 'Unauthorized.' }, 401);
    }

    const { error } = await supabase.rpc('reset_notion_webhook_setup');
    if (error) {
      console.error('[webhooks/notion] setup reset failed');
      return c.json({ error: 'Webhook setup is unavailable.' }, 503);
    }
    c.header('Cache-Control', 'no-store, private');
    return c.json({ reset: true });
  });

  /** Verifies and accepts Notion webhook events. @param c - Hono context. @returns JSON acknowledgement. */
  const handleNotionWebhook = async (
    c: Context<{ Bindings: WorkerEnv }>,
    callbackToken?: string,
  ) => {
    const rawBody = await readWebhookBody(c.req.raw, 1024 * 1024);
    if (rawBody === null) return c.json({ error: 'Webhook payload is too large.' }, 413);
  
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      console.warn('[webhooks/notion] invalid JSON payload');
      return c.json({ error: 'Invalid JSON payload.' }, 400);
    }

    const { data: setup, error: lookupError } = await supabase
      .from('notion_webhook_setup')
      .select('verification_token, setup_callback_token_hash')
      .eq('id', 1)
      .maybeSingle();
    if (lookupError) {
      console.error('[webhooks/notion] webhook setup lookup failed');
      return c.json({ error: 'Webhook verification is unavailable.' }, 503);
    }
    const storedSecret = typeof setup?.verification_token === 'string'
      ? setup.verification_token
      : undefined;
    const storedCallbackTokenHash = typeof setup?.setup_callback_token_hash === 'string'
      ? setup.setup_callback_token_hash
      : undefined;
    if (
      (callbackToken && (!storedCallbackTokenHash || !constantTimeTokenEquals(hashToken(callbackToken), storedCallbackTokenHash))) ||
      (storedCallbackTokenHash && !callbackToken)
    ) {
      return c.json({ error: 'Webhook endpoint not found.' }, 404);
    }

    // Current Notion webhook setup sends a one-time verification_token. Never
    // write this secret to logs.
    if (typeof payload.verification_token === 'string') {
      const token = payload.verification_token;
      if (token.length === 0 || token.length > MAX_VERIFICATION_TOKEN_LENGTH) {
        return c.json({ error: 'Invalid verification token.' }, 400);
      }

      if (
        (storedSecret && constantTimeTokenEquals(token, storedSecret)) ||
        (c.env.NOTION_WEBHOOK_SECRET && constantTimeTokenEquals(token, c.env.NOTION_WEBHOOK_SECRET))
      ) {
        console.info('[webhooks/notion] verification token received (redacted).');
        return c.json({ ok: true });
      }
      if (!callbackToken) {
        return c.json({ error: 'Webhook setup is not armed or the callback URL is invalid.' }, 409);
      }

      const { data: registered, error } = await supabase.rpc(
        'register_notion_webhook_verification_token',
        { p_token: token, p_callback_token_hash: hashToken(callbackToken) },
      );
      if (error) {
        console.error('[webhooks/notion] verification token registration failed');
        return c.json({ error: 'Webhook setup is unavailable.' }, 503);
      }
      if (registered !== true) {
        console.warn('[webhooks/notion] rejected unarmed or conflicting verification token');
        return c.json({ error: 'Webhook setup is not armed or the token conflicts.' }, 409);
      }

      console.info('[webhooks/notion] verification token received (redacted).');
      return c.json({ ok: true });
    }

    const signature = c.req.header('x-notion-signature') ?? c.req.header('notion-signature') ?? '';
    const webhookSecret = storedSecret ?? c.env.NOTION_WEBHOOK_SECRET;
    if (!webhookSecret) {
      console.error('[webhooks/notion] webhook verification is not configured');
      return c.json({ error: 'Webhook verification is not configured.' }, 503);
    }
    const verified = await verifyNotionWebhookSignature(
      webhookSecret,
      rawBody,
      signature,
    ).catch((error) => {
      console.error('[webhooks/notion] signature computation failed:', safeErrorMetadata(error));
      return false;
    });
    if (!verified) {
      console.warn('[webhooks/notion] invalid signature');
      return c.json({ error: 'Invalid webhook signature.' }, 401);
    }

    try {
      await processNotionWebhook(c.env, payload);
    } catch (error) {
      console.error('[webhooks/notion] processing failed:', safeErrorMetadata(error));
      return c.json({ error: 'Webhook processing failed.' }, 503);
    }
  
    return c.json({ ok: true });
  };

  app.post('/webhooks/notion', (c) => handleNotionWebhook(c));
  app.post('/webhooks/notion/:callbackToken', (c) =>
    handleNotionWebhook(c, c.req.param('callbackToken')),
  );
  
  /** Processes a verified Notion event and marks mapped local pages stale. @param env - Worker bindings. @param payload - Parsed webhook body. @returns Completion after notifications are queued. */
  async function processNotionWebhook(env: WorkerEnv, payload: JsonObject): Promise<void> {
    const notionPageId = (payload.entity as Record<string, unknown> | undefined)?.id as string | undefined;
    if (!notionPageId) return;
  
    // Skip changes made by our own bot integration (new format uses authors[], old format uses actor)
    const authors = payload.authors as Array<Record<string, unknown>> | undefined;
    const actor = payload.actor as Record<string, unknown> | undefined;
    if (actor?.type === 'bot' || (authors?.length && authors.every((a) => a.type === 'bot'))) {
      return;
    }
  
    const { data: rows, error: mappingError } = await supabase
      .from('notion_block_sync')
      .select('installation_id, local_id')
      .eq('notion_block_id', notionPageId);
    if (mappingError) throw new Error('Unable to load webhook mappings.');
  
    if (!rows?.length) {
      console.log('[webhooks/notion] no local pages mapped to the event');
      return;
    }
  
    console.log('[webhooks/notion] notifying', rows.length, 'mapped page(s) stale');
    for (const row of rows) {
      const { data: staleVersion, error: versionError } = await supabase.rpc('increment_block_version', {
        p_installation_id: row.installation_id,
        p_local_id: row.local_id,
        p_entity_type: 'page',
      });
      if (versionError || staleVersion === null || staleVersion === undefined) {
        throw new Error('Unable to update the webhook sync version.');
      }

      const { error: staleError } = await supabase
        .from('notion_block_sync')
        .update({ is_stale: true, stale_since: new Date().toISOString() })
        .eq('installation_id', row.installation_id)
        .eq('local_id', row.local_id);
      if (staleError) throw new Error('Unable to mark webhook sync state stale.');
  
      const doStub = env.SYNC_EVENTS.get(
        env.SYNC_EVENTS.idFromName(String(row.installation_id)),
      );
      await doStub.fetch(new Request('http://do/notify', {
        method: 'POST',
        body: JSON.stringify({ status: 'stale', pageId: row.local_id, version: staleVersion }),
      })).catch(() => undefined);
    }
  
  }
}

/** Checks the operator bearer token without logging or including either value in errors. */
function isAuthorizedWebhookSetupRequest(request: Request, env: WorkerEnv): boolean {
  const expected = env.NOTION_WEBHOOK_SETUP_TOKEN;
  const authorization = request.headers.get('authorization') ?? '';
  const match = /^Bearer ([^\s]+)$/i.exec(authorization);
  if (!expected || Buffer.byteLength(expected) < 32 || !match) return false;
  return constantTimeTokenEquals(match[1], expected);
}

/** Compares arbitrary token lengths through fixed-size digests before the timing-safe compare. */
function constantTimeTokenEquals(left: string, right: string): boolean {
  const leftDigest = createHash('sha256').update(left, 'utf8').digest();
  const rightDigest = createHash('sha256').update(right, 'utf8').digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

/** Stores only a digest of the random callback URL segment. */
function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Reads a raw webhook body with a hard byte limit before JSON parsing. */
async function readWebhookBody(request: Request, maxBytes: number): Promise<string | null> {
  const contentLength = Number(request.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) return null;
  if (!request.body) return '';

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

