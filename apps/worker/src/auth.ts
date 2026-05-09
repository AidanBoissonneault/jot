// @ts-nocheck
// Supabase auth backend — handles user, session, account, notion_installations.
// jot_sync_state is managed in worker.js (sync concern, not auth).

export function createAuth(supabase) {
  return {
    getCustomSession: (token) => getCustomSession(supabase, token),
    createNotionSession: (opts) => createNotionSession(supabase, opts),
    deleteCustomSession: (token) => deleteCustomSession(supabase, token),
    getActiveInstallation: (userId) => getActiveInstallation(supabase, userId),
    getActiveInstallationWithTokens: (userId) => getActiveInstallationWithTokens(supabase, userId),
    revokeInstallation: (userId) => revokeInstallation(supabase, userId),
  };
}

async function getCustomSession(supabase, token) {
  if (!token) return null;

  const { data, error } = await supabase
    .from('session')
    .select('id, token, expiresAt, userId, user:userId(id, name, email, image, emailVerified)')
    .eq('token', token)
    .gt('expiresAt', new Date().toISOString())
    .single();

  if (error || !data) return null;

  return {
    session: {
      id: data.id,
      token: data.token,
      userId: data.userId,
      expiresAt: data.expiresAt,
    },
    user: {
      id: data.user.id,
      name: data.user.name,
      email: data.user.email,
      image: data.user.image,
      emailVerified: Boolean(data.user.emailVerified),
    },
  };
}

// Returns { sessionToken, installationId }
async function createNotionSession(supabase, {
  userId,
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
}) {
  userId = await upsertJotUser(supabase, userId, user);

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

  // Delete existing sessions for user and expired sessions
  await supabase.from('session').delete().or(`userId.eq.${userId},expiresAt.lt.${new Date().toISOString()}`);

  await supabase.from('session').insert({
    id: sessionId,
    expiresAt,
    token: sessionToken,
    ipAddress: ipAddress ?? null,
    userAgent: userAgent ?? null,
    userId,
  });

  const installationId = await upsertNotionInstallation(supabase, userId, {
    workspaceId: workspaceId ?? null,
    workspaceName: workspaceName ?? null,
  });

  return { sessionToken, installationId };
}

async function deleteCustomSession(supabase, token) {
  if (!token) return;
  await supabase.from('session').delete().eq('token', token);
}

async function revokeInstallation(supabase, userId) {
  await supabase
    .from('notion_installations')
    .update({ active: 0, revoked_at: new Date().toISOString() })
    .eq('user_id', userId);
}

async function upsertJotUser(supabase, preferredUserId, user) {
  const { data: existing } = await supabase
    .from('user')
    .select('id')
    .or(`id.eq.${preferredUserId},email.eq.${user.email}`)
    .limit(1)
    .maybeSingle();

  const userId = existing?.id ?? preferredUserId;

  await supabase.from('user').upsert(
    { id: userId, name: user.name, email: user.email, emailVerified: 0, image: user.image },
    { onConflict: 'id' },
  );

  return userId;
}

// Returns the installation id (BIGINT from Supabase)
async function upsertNotionInstallation(supabase, userId, { workspaceId, workspaceName }) {
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

async function getActiveInstallation(supabase, userId) {
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

async function getActiveInstallationWithTokens(supabase, userId) {
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
