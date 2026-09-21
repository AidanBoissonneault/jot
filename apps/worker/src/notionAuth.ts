/**
 * @file Handles Notion OAuth exchange, identity normalization, webhook signatures, and webhook registration.
 * @author Aidan Boissonneault
 * @lastModified September 2026
 */

import type { Identifier, JsonObject, WorkerEnv, WorkerSupabaseClient } from './types.js';

/** Describes the notion oauth tokens contract used by this API feature. */
export interface NotionOAuthTokens {
  access_token: string;
  bot_id: string | undefined;
  owner: { user: NotionOAuthOwner | undefined } | undefined;
  refresh_token: string | null | undefined;
  workspace_id: string | undefined;
  workspace_name: string | undefined;
}

/** Describes the notion oauth owner contract used by this API feature. */
interface NotionOAuthOwner {
  avatar_url: string | null;
  id: string;
  name: string | null;
  person: { email: string | undefined } | undefined;
}

/** Describes the notion oauth user contract used by this API feature. */
export interface NotionOAuthUser {
  email: string;
  id: string;
  image: string | null;
  name: string;
}

/**
 * Computes the hexadecimal HMAC-SHA256 digest used by Notion webhooks.
 * @param secret - Configured webhook secret.
 * @param body - Exact raw request body.
 * @returns Lowercase hexadecimal signature.
 */
export async function computeHmacSignature(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return Array.from(new Uint8Array(signature))
    .map((byte: number): string => byte.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Registers the worker's callback URL and persists the returned webhook identifier.
 * @param env - Worker bindings and Notion configuration.
 * @param supabase - Privileged persistence client.
 * @param installationId - Active installation identifier.
 * @param accessToken - Notion access token.
 * @param baseUrl - Public worker base URL.
 * @returns A promise resolved after the best-effort registration.
 */
export async function registerNotionWebhook(
  env: WorkerEnv,
  supabase: WorkerSupabaseClient,
  installationId: Identifier,
  accessToken: string,
  baseUrl: string,
): Promise<void> {
  if (!env.NOTION_WEBHOOK_SECRET) return;
  const response = await fetch('https://api.notion.com/v1/webhooks', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'Notion-Version': env.NOTION_VERSION ?? '2026-03-11',
    },
    body: JSON.stringify({
      url: `${baseUrl}/webhooks/notion`,
      filter: { event_types: ['page.content_updated', 'page.properties_updated'] },
    }),
  });
  if (!response.ok) return;
  const data: unknown = await response.json().catch(() => ({}));
  const webhookId = stringProperty(data, 'id');
  if (webhookId) {
    await supabase.from('notion_installations').update({ notion_webhook_id: webhookId }).eq('id', installationId);
  }
}

/**
 * Deletes an installation's registered Notion webhook and clears its identifier.
 * @param env - Worker bindings and Notion configuration.
 * @param supabase - Privileged persistence client.
 * @param installationId - Active installation identifier.
 * @returns A promise resolved after best-effort deletion.
 */
export async function deleteNotionWebhook(
  env: WorkerEnv,
  supabase: WorkerSupabaseClient,
  installationId: Identifier,
): Promise<void> {
  const { data: row } = await supabase.from('notion_installations')
    .select('notion_webhook_id').eq('id', installationId).maybeSingle();
  if (!row?.notion_webhook_id) return;
  const { data: installation } = await supabase.from('notion_installations')
    .select('user_id').eq('id', installationId).maybeSingle();
  if (!installation?.user_id) return;
  const { data: account } = await supabase.from('account').select('accessToken')
    .eq('userId', installation.user_id).eq('providerId', 'notion').maybeSingle();
  if (!account?.accessToken) return;

  await fetch(`https://api.notion.com/v1/webhooks/${row.notion_webhook_id}`, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${account.accessToken}`,
      'Notion-Version': env.NOTION_VERSION ?? '2026-03-11',
    },
  }).catch(() => undefined);
  await supabase.from('notion_installations').update({ notion_webhook_id: null }).eq('id', installationId);
}

/**
 * Exchanges a one-time Notion OAuth code for workspace tokens.
 * @param env - Worker bindings containing OAuth credentials.
 * @param code - One-time authorization code.
 * @param redirectUri - Callback URL used for authorization.
 * @returns Validated OAuth token payload.
 */
export async function exchangeNotionCode(
  env: WorkerEnv,
  code: string,
  redirectUri: string,
): Promise<NotionOAuthTokens> {
  const credentials = Buffer.from(`${env.NOTION_OAUTH_CLIENT_ID}:${env.NOTION_OAUTH_CLIENT_SECRET}`).toString('base64');
  const response = await fetch('https://api.notion.com/v1/oauth/token', {
    method: 'POST',
    headers: { Authorization: `Basic ${credentials}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'authorization_code', code, redirect_uri: redirectUri }),
  });
  const payload: unknown = await response.json().catch(() => ({}));
  const accessToken = stringProperty(payload, 'access_token');
  if (!response.ok || !accessToken) {
    throw new Error(stringProperty(payload, 'message') ?? `Notion OAuth returned ${response.status}.`);
  }
  const record = payload as JsonObject;
  return {
    access_token: accessToken,
    bot_id: stringProperty(record, 'bot_id'),
    owner: parseOwner(record.owner),
    refresh_token: nullableStringProperty(record, 'refresh_token'),
    workspace_id: stringProperty(record, 'workspace_id'),
    workspace_name: stringProperty(record, 'workspace_name'),
  };
}

/**
 * Normalizes the OAuth owner or bot identity to an Inkwell user.
 * @param tokens - Validated Notion OAuth tokens.
 * @returns Stable user identity.
 */
export function notionUserFromToken(tokens: NotionOAuthTokens): NotionOAuthUser {
  const ownerUser = tokens.owner?.user;
  const id = ownerUser?.id ?? tokens.bot_id ?? tokens.workspace_id;
  if (!id) throw new Error('Notion OAuth response did not include a user or bot id.');
  return {
    id,
    name: ownerUser?.name ?? tokens.workspace_name ?? 'Notion user',
    email: ownerUser?.person?.email ?? `${id}@notion.local`,
    image: ownerUser?.avatar_url ?? null,
  };
}

/** Parses the optional owner container in an OAuth response. @param value - Unknown owner value. @returns Normalized owner fields. */
function parseOwner(value: unknown): NotionOAuthTokens['owner'] {
  const owner = objectValue(value);
  if (!owner) return undefined;
  const user = objectValue(owner.user);
  if (!user) return { user: undefined };
  const person = objectValue(user.person);
  const id = stringProperty(user, 'id');
  if (!id) return { user: undefined };
  return {
    user: {
      avatar_url: nullableStringProperty(user, 'avatar_url') ?? null,
      id,
      name: nullableStringProperty(user, 'name') ?? null,
      person: person ? { email: stringProperty(person, 'email') } : undefined,
    },
  };
}

/** Narrows an unknown value to an object. @param value - Unknown value. @returns JSON object when valid. */
function objectValue(value: unknown): JsonObject | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : undefined;
}

/** Reads a string property from an unknown object. @param value - Unknown object. @param key - Property name. @returns String value when present. */
function stringProperty(value: unknown, key: string): string | undefined {
  const object = objectValue(value);
  const property: unknown = object?.[key];
  return typeof property === 'string' ? property : undefined;
}

/** Reads a nullable string property from an object. @param value - Unknown object. @param key - Property name. @returns String, null, or undefined. */
function nullableStringProperty(value: unknown, key: string): string | null | undefined {
  const object = objectValue(value);
  const property: unknown = object?.[key];
  return typeof property === 'string' || property === null ? property : undefined;
}
