/**
 * @file Registers Notion webhook verification and converts remote edits into local stale notifications.
 * @author Aidan Boissonneault
 * @lastModified September 2026
 */

import type { Hono } from 'hono';
import { computeHmacSignature } from '../notionAuth.js';
import { supabase } from '../services/workerRuntime.js';
import type { JsonObject, WorkerEnv } from '../types.js';

/**
 * Registers the Notion webhook endpoint.
 * @param app - Worker Hono application.
 * @returns Nothing.
 */
export function registerWebhookRoutes(app: Hono<{ Bindings: WorkerEnv }>): void {
  /** Verifies and accepts Notion webhook events. @param c - Hono context. @returns JSON acknowledgement. */
  app.post('/webhooks/notion', async (c) => {
    const rawBody = await c.req.text();
  
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      console.warn('[webhooks/notion] invalid JSON payload');
      return c.json({ ok: true, ignored: 'invalid_json' });
    }
  
    // Current Notion webhook setup sends a one-time verification_token that must
    // be copied from server logs into the Notion integration settings.
    if (typeof payload.verification_token === 'string') {
      console.log('[webhooks/notion] verification token received:', payload.verification_token);
      return c.json({ ok: true });
    }
  
    // Older Notion webhook URL verification must be answered synchronously.
    if (payload.type === 'url_verification' && payload.challenge) {
      return c.json({ challenge: payload.challenge });
    }
  
    const signature = c.req.header('x-notion-signature') ?? c.req.header('notion-signature') ?? '';
    if (c.env.NOTION_WEBHOOK_SECRET) {
      const expected = await computeHmacSignature(c.env.NOTION_WEBHOOK_SECRET, rawBody).catch((error) => {
        console.error('[webhooks/notion] signature computation failed:', error);
        return '';
      });
      if (signature !== `sha256=${expected}` && signature !== `v0=${expected}`) {
        console.warn('[webhooks/notion] invalid signature');
        return c.json({ ok: true, ignored: 'invalid_signature' });
      }
    }
  
    const processing = processNotionWebhook(c.env, payload).catch((error) => {
      console.error('[webhooks/notion] processing failed:', error);
    });
    c.executionCtx?.waitUntil?.(processing);
  
    return c.json({ ok: true });
  });
  
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
  
    const { data: rows } = await supabase
      .from('notion_block_sync')
      .select('installation_id, local_id')
      .eq('notion_block_id', notionPageId);
  
    if (!rows?.length) {
      console.log('[webhooks/notion] no local pages mapped to notion page', notionPageId);
      return;
    }
  
    console.log('[webhooks/notion] notifying', rows.length, 'page(s) stale for notion page', notionPageId);
    for (const row of rows) {
      const { data: staleVersion } = await supabase.rpc('increment_block_version', {
        p_installation_id: row.installation_id,
        p_local_id: row.local_id,
        p_entity_type: 'page',
      });
  
      await supabase
        .from('notion_block_sync')
        .update({ is_stale: true, stale_since: new Date().toISOString() })
        .eq('installation_id', row.installation_id)
        .eq('local_id', row.local_id);
  
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

