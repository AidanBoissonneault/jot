/**
 * @file Manages Inkwell users, sessions, accounts, and active Notion installations in Supabase.
 * @author Aidan Boissonneault
 * @lastModified September 2026
 */

import type { Identifier, WorkerSupabaseClient } from './types.js';

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

  const { data, error } = await supabase
    .from('session')
    .select('id, token, expiresAt, userId, user:userId(id, name, email, image, emailVerified)')
    .eq('token', token)
    .gt('expiresAt', new Date().toISOString())
    .single();

  if (error || !data) return null;
  const relatedUser = Array.isArray(data.user) ? data.user[0] : data.user;

  if (!relatedUser) return null;

  return {
    session: {
      id: data.id,
      token: data.token,
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
  const userId = await upsertInkwellUser(supabase, preferredUserId, user);
  const accountId = `notion:${notionAccountId}`;
  const expiresAt = new Date(Date.now() + SESSION_MAX_AGE_SECONDS * 1000).toISOString();

  await supabase.from('account').upsert(
    {
      id: crypto.randomUUID(),
      accountId,
      providerId: 'notion',
      userId,
      accessToken,
      refreshToken: refreshToken ?? null,
    },
    { onConflict: 'providerId,accountId' },
  );

  await supabase.from('session').delete().or(
    `userId.eq.${userId},expiresAt.lt.${new Date().toISOString()}`,
  );
  await supabase.from('session').insert({
    id: sessionId,
    expiresAt,
    token: sessionToken,
    ipAddress,
    userAgent,
    userId,
  });

  const installationId = await upsertNotionInstallation(supabase, userId, {
    workspaceId: workspaceId ?? null,
    workspaceName: workspaceName ?? null,
  });

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
  await supabase.from('session').delete().eq('token', token);
}

/**
 * Revokes every active Notion installation belonging to a user.
 * @param supabase - Privileged database client.
 * @param userId - Inkwell user identifier.
 * @returns A promise resolved after the update.
 */
async function revokeInstallation(supabase: WorkerSupabaseClient, userId: string): Promise<void> {
  await supabase
    .from('notion_installations')
    .update({ active: 0, revoked_at: new Date().toISOString() })
    .eq('user_id', userId);
}

/**
 * Creates or refreshes an Inkwell user while retaining an existing email identity.
 * @param supabase - Privileged database client.
 * @param preferredUserId - Stable identifier derived from the Notion user.
 * @param user - User profile returned by Notion OAuth.
 * @returns The persisted Inkwell user identifier.
 */
async function upsertInkwellUser(
  supabase: WorkerSupabaseClient,
  preferredUserId: string,
  user: NotionOAuthUser,
): Promise<string> {
  const { data: existing } = await supabase
    .from('user')
    .select('id')
    .or(`id.eq.${preferredUserId},email.eq.${user.email}`)
    .limit(1)
    .maybeSingle();
  const userId: string = existing?.id ?? preferredUserId;

  await supabase.from('user').upsert(
    { id: userId, name: user.name, email: user.email, emailVerified: 0, image: user.image },
    { onConflict: 'id' },
  );

  return userId;
}

/**
 * Replaces a user's active Notion workspace installation.
 * @param supabase - Privileged database client.
 * @param userId - Inkwell user identifier.
 * @param workspace - Notion workspace identity and display name.
 * @returns The BIGINT installation identifier, or null when none was returned.
 */
async function upsertNotionInstallation(
  supabase: WorkerSupabaseClient,
  userId: string,
  { workspaceId, workspaceName }: Pick<CreateNotionSessionOptions, 'workspaceId' | 'workspaceName'>,
): Promise<Identifier | null> {
  await revokeInstallation(supabase, userId);
  const { data } = await supabase
    .from('notion_installations')
    .upsert(
      {
        user_id: userId,
        workspace_id: workspaceId,
        workspace_name: workspaceName,
        active: 1,
        revoked_at: null,
      },
      { onConflict: 'user_id' },
    )
    .select('id')
    .single();

  return data?.id ?? null;
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
