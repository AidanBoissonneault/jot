/**
 * @file Manages Inkwell users, sessions, accounts, and active Notion installations in Supabase.
 * @author Aidan Boissonneault
 * @lastModified September 2026
 */

import type { Identifier, WorkerSupabaseClient } from './types.js';
import { hash } from './workerUtils.js';

/** Describes an authenticated Inkwell user. */
export interface AuthUser {
  email: string;
  emailVerified: boolean;
  id: string;
  image: string | null;
  name: string;
}

/** Describes a persisted custom application session. */
export interface AuthSession {
  expiresAt: string;
  id: string;
  token: string;
  userId: string;
}

/** Describes a validated session paired with its user. */
export interface AuthSessionResult {
  session: AuthSession;
  user: AuthUser;
}

/** Describes the notion installation contract used by this API feature. */
export interface NotionInstallation {
  id: Identifier;
  workspace_id: string | null;
  workspace_name: string | null;
}

/** Describes the connected notion installation contract used by this API feature. */
export interface ConnectedNotionInstallation extends NotionInstallation {
  tokens: { access_token: string };
}

/** Notion credentials persisted for an Inkwell account. */
export interface NotionAccountTokens {
  accessToken: string | null;
  refreshToken: string | null;
}

/** Minimal state retained so a client can retry connection deletion after a lost response. */
export interface ConnectionDeletionReceipt {
  notionTokenRevoked: boolean;
  requestIdHash: string;
  status: 'pending' | 'completed';
  userId: string | null;
}

/** Describes the notion oauth user contract used by this API feature. */
interface NotionOAuthUser {
  email: string;
  id: string;
  image: string | null;
  name: string;
}

/** Describes the create notion session options contract used by this API feature. */
interface CreateNotionSessionOptions {
  SESSION_MAX_AGE_SECONDS: number;
  accessToken: string;
  ipAddress: string | null;
  notionAccountId: string;
  refreshToken: string | null | undefined;
  sessionId: string;
  sessionToken: string;
  user: NotionOAuthUser;
  userAgent: string | null;
  userId: string;
  workspaceId: string | null | undefined;
  workspaceName: string | null | undefined;
}

/** Describes the complete authentication and installation service. */
export interface AuthService {
  createNotionSession: (options: CreateNotionSessionOptions) => Promise<{
    installationId: Identifier | null;
    sessionToken: string;
  }>;
  deleteCustomSession: (token: string | undefined) => Promise<void>;
  getActiveInstallation: (userId: string) => Promise<NotionInstallation | null>;
  getActiveInstallationWithTokens: (userId: string) => Promise<ConnectedNotionInstallation | undefined>;
  getCustomSession: (token: string | undefined) => Promise<AuthSessionResult | null>;
  getNotionAccountTokens: (userId: string) => Promise<NotionAccountTokens | null>;
  clearNotionAccountTokens: (userId: string) => Promise<void>;
  getConnectionDeletionReceipt: (requestIdHash: string) => Promise<ConnectionDeletionReceipt | null>;
  createConnectionDeletionReceipt: (requestIdHash: string, userId: string) => Promise<ConnectionDeletionReceipt>;
  updateConnectionDeletionRevocation: (requestIdHash: string, notionTokenRevoked: boolean) => Promise<void>;
  completeConnectionDeletionReceipt: (requestIdHash: string) => Promise<void>;
  hasInkwellUser: (userId: string) => Promise<boolean>;
  revokeInstallation: (userId: string) => Promise<void>;
}

/**
 * Creates the authentication service bound to a Supabase client.
 * @param supabase - Privileged database client used by the worker.
 * @returns Typed authentication and installation operations.
 */
export function createAuth(supabase: WorkerSupabaseClient): AuthService {
  return {
    /** Creates or replaces an Inkwell session from a successful Notion OAuth exchange. */
    createNotionSession: (options: CreateNotionSessionOptions) => createNotionSession(supabase, options),
    /** Removes the custom session represented by the supplied cookie token. */
    deleteCustomSession: (token: string | undefined) => deleteCustomSession(supabase, token),
    /** Returns public metadata for a user's active Notion installation. */
    getActiveInstallation: (userId: string) => getActiveInstallation(supabase, userId),
    /** Returns an active Notion installation together with its access token. */
    getActiveInstallationWithTokens: (userId: string) => getActiveInstallationWithTokens(supabase, userId),
    /** Resolves a valid custom session and its owning user. */
    getCustomSession: (token: string | undefined) => getCustomSession(supabase, token),
    /** Loads stored Notion credentials for remote revocation. */
    getNotionAccountTokens: (userId: string) => getNotionAccountTokens(supabase, userId),
    /** Clears stored access and refresh tokens. */
    clearNotionAccountTokens: (userId: string) => clearNotionAccountTokens(supabase, userId),
    /** Reads the retry receipt for a connection deletion request. */
    getConnectionDeletionReceipt: (requestIdHash: string) => getConnectionDeletionReceipt(supabase, requestIdHash),
    /** Creates a pending receipt without overwriting an existing completed receipt. */
    createConnectionDeletionReceipt: (requestIdHash: string, userId: string) => createConnectionDeletionReceipt(supabase, requestIdHash, userId),
    /** Records whether Notion revoked the token during this deletion attempt. */
    updateConnectionDeletionRevocation: (requestIdHash: string, notionTokenRevoked: boolean) => updateConnectionDeletionRevocation(supabase, requestIdHash, notionTokenRevoked),
    /** Atomically removes the user and completes the retry receipt. */
    completeConnectionDeletionReceipt: (requestIdHash: string) => completeConnectionDeletionReceipt(supabase, requestIdHash),
    /** Checks whether the user row still exists while recovering a pending deletion. */
    hasInkwellUser: (userId: string) => hasInkwellUser(supabase, userId),
    /** Marks all Notion installations for a user as revoked. */
    revokeInstallation: (userId: string) => revokeInstallation(supabase, userId),
  };
}

/**
 * Loads a non-expired custom session by token.
 * @param supabase - Privileged database client.
 * @param token - Session token read from the request cookie.
 * @returns The session and user, or null when the token is absent or invalid.
 */
async function getCustomSession(
  supabase: WorkerSupabaseClient,
  token: string | undefined,
): Promise<AuthSessionResult | null> {
  if (!token) return null;

  const hashedToken = hash(token);
  const { data: hashedSession, error } = await supabase
    .from('session')
    .select('id, token, expiresAt, userId, user:userId(id, name, email, image, emailVerified)')
    .eq('token', hashedToken)
    .gt('expiresAt', new Date().toISOString())
    .maybeSingle();

  if (error) return null;
  let data = hashedSession;
  if (!data) {
    // Upgrade valid sessions created by older releases, which stored the raw cookie token.
    const legacy = await supabase
      .from('session')
      .select('id, token, expiresAt, userId, user:userId(id, name, email, image, emailVerified)')
      .eq('token', token)
      .gt('expiresAt', new Date().toISOString())
      .maybeSingle();
    if (legacy.error || !legacy.data) return null;
    const { error: migrationError } = await supabase
      .from('session')
      .update({ token: hashedToken })
      .eq('id', legacy.data.id)
      .eq('token', token);
    if (migrationError) return null;
    data = legacy.data;
  }

  const relatedUser = Array.isArray(data.user) ? data.user[0] : data.user;

  if (!relatedUser) return null;

  return {
    session: {
      id: data.id,
      token: hashedToken,
      userId: data.userId,
      expiresAt: data.expiresAt,
    },
    user: {
      id: relatedUser.id,
      name: relatedUser.name,
      email: relatedUser.email,
      image: relatedUser.image,
      emailVerified: Boolean(relatedUser.emailVerified),
    },
  };
}

/**
 * Persists the OAuth account, installation, and replacement browser session.
 * @param supabase - Privileged database client.
 * @param options - OAuth identity, token, request, and session values.
 * @returns The browser session token and active installation identifier.
 */
async function createNotionSession(
  supabase: WorkerSupabaseClient,
  options: CreateNotionSessionOptions,
): Promise<{ installationId: Identifier | null; sessionToken: string }> {
  const {
    userId: preferredUserId,
    notionAccountId,
    accessToken,
    refreshToken,
    workspaceId,
    workspaceName,
    user,
    ipAddress,
    userAgent,
    sessionToken,
    sessionId,
    SESSION_MAX_AGE_SECONDS,
  } = options;
  const userId = preferredUserId;
  const accountId = `notion:${notionAccountId}`;
  const expiresAt = new Date(Date.now() + SESSION_MAX_AGE_SECONDS * 1000).toISOString();
  const rpcArgs = {
    p_user_id: userId,
    p_name: user.name,
    p_email: user.email,
    p_image: user.image,
    p_account_row_id: crypto.randomUUID(),
    p_account_id: accountId,
    p_access_token: accessToken,
    p_refresh_token: refreshToken ?? null,
    p_session_id: sessionId,
    p_session_token_hash: hash(sessionToken),
    p_expires_at: expiresAt,
    p_ip_address: ipAddress,
    p_user_agent: userAgent,
    p_workspace_id: workspaceId ?? null,
    p_workspace_name: workspaceName ?? null,
  };
  let installationId: Identifier | null = null;
  for (let attempt = 0; attempt < 2 && installationId === null; attempt += 1) {
    try {
      const result = await supabase.rpc('commit_notion_oauth_session', rpcArgs);
      if (!result.error && (typeof result.data === 'number' || typeof result.data === 'string')) {
        installationId = result.data;
      }
    } catch {
      // The transaction is idempotent by session ID, so a retry recovers a
      // commit whose PostgREST response was lost in transit.
    }
  }
  if (installationId === null) {
    throw new Error('Unable to securely complete the Notion connection.');
  }

  return { sessionToken, installationId };
}

/**
 * Deletes a custom browser session when a token is available.
 * @param supabase - Privileged database client.
 * @param token - Session token to remove.
 * @returns A promise resolved after deletion.
 */
async function deleteCustomSession(
  supabase: WorkerSupabaseClient,
  token: string | undefined,
): Promise<void> {
  if (!token) return;
  const { error } = await supabase.from('session').delete().eq('token', hash(token));
  if (error) throw new Error('Unable to delete the Inkwell session.');
}

/** Loads a user's stored Notion credentials for remote revocation. */
async function getNotionAccountTokens(
  supabase: WorkerSupabaseClient,
  userId: string,
): Promise<NotionAccountTokens | null> {
  const { data, error } = await supabase
    .from('account')
    .select('accessToken, refreshToken')
    .eq('userId', userId)
    .eq('providerId', 'notion')
    .limit(1)
    .maybeSingle();
  if (error) throw new Error('Unable to load the stored Notion connection.');
  return data;
}

/** Removes the access and refresh tokens while retaining the provider identity. */
async function clearNotionAccountTokens(
  supabase: WorkerSupabaseClient,
  userId: string,
): Promise<void> {
  const { error } = await supabase
    .from('account')
    .update({ accessToken: null, refreshToken: null })
    .eq('userId', userId)
    .eq('providerId', 'notion');
  if (error) throw new Error('Unable to remove the stored Notion credentials.');
}

/** Reads a privacy-minimal retry receipt using only its SHA-256 request identifier. */
async function getConnectionDeletionReceipt(
  supabase: WorkerSupabaseClient,
  requestIdHash: string,
): Promise<ConnectionDeletionReceipt | null> {
  const { data, error } = await supabase
    .from('inkwell_connection_deletion_receipts')
    .select('request_id_hash, user_id, status, notion_token_revoked')
    .eq('request_id_hash', requestIdHash)
    .maybeSingle();
  if (error) throw new Error('Unable to read the connection deletion receipt.');
  if (!data) return null;
  return {
    requestIdHash: data.request_id_hash,
    userId: data.user_id,
    status: data.status,
    notionTokenRevoked: Boolean(data.notion_token_revoked),
  };
}

/** Creates a pending retry receipt while leaving any existing receipt unchanged. */
async function createConnectionDeletionReceipt(
  supabase: WorkerSupabaseClient,
  requestIdHash: string,
  userId: string,
): Promise<ConnectionDeletionReceipt> {
  const { error } = await supabase
    .from('inkwell_connection_deletion_receipts')
    .upsert({
      request_id_hash: requestIdHash,
      user_id: userId,
      status: 'pending',
      notion_token_revoked: false,
    }, { onConflict: 'request_id_hash', ignoreDuplicates: true });
  if (error) throw new Error('Unable to prepare the connection deletion.');
  const receipt = await getConnectionDeletionReceipt(supabase, requestIdHash);
  if (!receipt) throw new Error('Unable to prepare the connection deletion.');
  return receipt;
}

/** Stores the current Notion revocation outcome before deleting the account rows. */
async function updateConnectionDeletionRevocation(
  supabase: WorkerSupabaseClient,
  requestIdHash: string,
  notionTokenRevoked: boolean,
): Promise<void> {
  const update = supabase
    .from('inkwell_connection_deletion_receipts')
    .update({ notion_token_revoked: notionTokenRevoked, updated_at: new Date().toISOString() })
    .eq('request_id_hash', requestIdHash)
    .eq('status', 'pending');
  const { error } = await (notionTokenRevoked
    ? update
    : update.eq('notion_token_revoked', false));
  if (error) throw new Error('Unable to save the connection deletion status.');
}

/** Removes the account and completes its retry receipt in one database transaction. */
async function completeConnectionDeletionReceipt(
  supabase: WorkerSupabaseClient,
  requestIdHash: string,
): Promise<void> {
  const { data, error } = await supabase.rpc('complete_inkwell_connection_deletion', {
    p_request_id_hash: requestIdHash,
  });
  if (error || data !== true) throw new Error('Unable to complete the Inkwell connection deletion.');
}

/** Checks whether a user row still exists while recovering a pending deletion. */
async function hasInkwellUser(
  supabase: WorkerSupabaseClient,
  userId: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from('user')
    .select('id')
    .eq('id', userId)
    .maybeSingle();
  if (error) throw new Error('Unable to verify the Inkwell account.');
  return Boolean(data);
}

/**
 * Revokes every active Notion installation belonging to a user.
 * @param supabase - Privileged database client.
 * @param userId - Inkwell user identifier.
 * @returns A promise resolved after the update.
 */
async function revokeInstallation(supabase: WorkerSupabaseClient, userId: string): Promise<void> {
  const { error } = await supabase
    .from('notion_installations')
    .update({ active: 0, revoked_at: new Date().toISOString() })
    .eq('user_id', userId);
  if (error) throw new Error('Unable to revoke the Notion installation.');
}

/**
 * Loads public metadata for the user's newest active installation.
 * @param supabase - Privileged database client.
 * @param userId - Inkwell user identifier.
 * @returns Installation metadata, or null when disconnected.
 */
async function getActiveInstallation(
  supabase: WorkerSupabaseClient,
  userId: string,
): Promise<NotionInstallation | null> {
  const { data } = await supabase
    .from('notion_installations')
    .select('id, workspace_id, workspace_name')
    .eq('user_id', userId)
    .eq('active', 1)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  return data;
}

/**
 * Loads the user's active installation and matching Notion access token.
 * @param supabase - Privileged database client.
 * @param userId - Inkwell user identifier.
 * @returns A connected installation, or undefined when incomplete or revoked.
 */
async function getActiveInstallationWithTokens(
  supabase: WorkerSupabaseClient,
  userId: string,
): Promise<ConnectedNotionInstallation | undefined> {
  const [{ data: accountRow }, { data: installRow }] = await Promise.all([
    supabase
      .from('account')
      .select('accessToken')
      .eq('userId', userId)
      .eq('providerId', 'notion')
      .limit(1)
      .maybeSingle(),
    supabase
      .from('notion_installations')
      .select('id, workspace_id, workspace_name')
      .eq('user_id', userId)
      .eq('active', 1)
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  if (!accountRow?.accessToken || !installRow) return undefined;
  return { ...installRow, tokens: { access_token: accountRow.accessToken } };
}
