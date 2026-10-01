-- Serialize deletion preparation with OAuth persistence so deletion revokes
-- the newest credential, or rejects and revokes an OAuth token issued later.

CREATE OR REPLACE FUNCTION public.prepare_inkwell_connection_deletion(
  p_request_id_hash TEXT,
  p_user_id TEXT
) RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_request_id_hash TEXT;
  v_user_id TEXT;
  v_status TEXT;
  v_notion_token_revoked BOOLEAN;
BEGIN
  IF p_request_id_hash IS NULL OR p_request_id_hash !~ '^[0-9a-f]{64}$'
     OR p_user_id IS NULL OR p_user_id = '' THEN
    RAISE EXCEPTION 'Invalid connection deletion input';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_user_id, 0)
  );

  INSERT INTO public.inkwell_connection_deletion_receipts
    (request_id_hash, user_id, status, notion_token_revoked)
  VALUES (p_request_id_hash, p_user_id, 'pending', FALSE)
  ON CONFLICT (request_id_hash) DO NOTHING;

  SELECT request_id_hash, user_id, status, notion_token_revoked
    INTO v_request_id_hash, v_user_id, v_status, v_notion_token_revoked
    FROM public.inkwell_connection_deletion_receipts
   WHERE request_id_hash = p_request_id_hash
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Connection deletion receipt is unavailable';
  END IF;
  IF v_status = 'pending' AND v_user_id IS DISTINCT FROM p_user_id THEN
    RAISE EXCEPTION 'Connection deletion request owner mismatch';
  END IF;

  IF v_status = 'pending' THEN
    UPDATE public.notion_installations
       SET active = 0,
           revoked_at = pg_catalog.now(),
           updated_at = pg_catalog.now()
     WHERE user_id = p_user_id;
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'request_id_hash', v_request_id_hash,
    'user_id', v_user_id,
    'status', v_status,
    'notion_token_revoked', v_notion_token_revoked
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.commit_notion_oauth_session(
  p_user_id TEXT,
  p_name TEXT,
  p_email TEXT,
  p_image TEXT,
  p_account_row_id TEXT,
  p_account_id TEXT,
  p_access_token TEXT,
  p_refresh_token TEXT,
  p_session_id TEXT,
  p_session_token_hash TEXT,
  p_expires_at TIMESTAMPTZ,
  p_ip_address TEXT,
  p_user_agent TEXT,
  p_workspace_id TEXT,
  p_workspace_name TEXT
) RETURNS BIGINT
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_installation_id BIGINT;
  v_existing_user_id TEXT;
  v_existing_token TEXT;
BEGIN
  IF p_user_id IS NULL OR p_user_id = ''
     OR p_account_row_id IS NULL OR p_account_id IS NULL OR p_account_id = ''
     OR p_access_token IS NULL OR p_access_token = ''
     OR p_session_id IS NULL OR p_session_token_hash IS NULL OR p_session_token_hash = ''
     OR p_expires_at IS NULL OR p_name IS NULL OR p_email IS NULL THEN
    RAISE EXCEPTION 'Invalid OAuth session input';
  END IF;

  -- Match the deletion transaction's lock before observing pending deletion.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_user_id, 0)
  );
  IF EXISTS (
    SELECT 1
      FROM public.inkwell_connection_deletion_receipts AS receipt
     WHERE receipt.user_id = p_user_id
       AND receipt.status = 'pending'
  ) THEN
    RAISE EXCEPTION 'Inkwell connection deletion is in progress';
  END IF;

  -- A retry after a lost PostgREST response must recognize the commit instead
  -- of inserting a second session or revoking the session that just succeeded.
  SELECT existing_session."userId", existing_session.token
    INTO v_existing_user_id, v_existing_token
    FROM public.session AS existing_session
   WHERE existing_session.id = p_session_id;
  IF FOUND THEN
    IF v_existing_user_id IS DISTINCT FROM p_user_id
       OR v_existing_token IS DISTINCT FROM p_session_token_hash THEN
      RAISE EXCEPTION 'OAuth session identifier collision';
    END IF;
    SELECT installation.id
      INTO v_installation_id
      FROM public.notion_installations AS installation
     WHERE installation.user_id = p_user_id AND installation.active = 1;
    IF v_installation_id IS NULL THEN
      RAISE EXCEPTION 'Committed OAuth session is missing its installation';
    END IF;
    RETURN v_installation_id;
  END IF;

  INSERT INTO public."user" AS inkwell_user (id, name, email, "emailVerified", image, "updatedAt")
  VALUES (p_user_id, p_name, p_email, 0, p_image, pg_catalog.now())
  ON CONFLICT (id) DO UPDATE
    SET name = EXCLUDED.name,
        email = EXCLUDED.email,
        "emailVerified" = 0,
        image = EXCLUDED.image,
        "updatedAt" = pg_catalog.now();

  INSERT INTO public.account AS notion_account
    (id, "accountId", "providerId", "userId", "accessToken", "refreshToken", "updatedAt")
  VALUES (p_account_row_id, p_account_id, 'notion', p_user_id, p_access_token, p_refresh_token, pg_catalog.now())
  ON CONFLICT ("providerId", "accountId") DO UPDATE
    SET "userId" = EXCLUDED."userId",
        "accessToken" = EXCLUDED."accessToken",
        "refreshToken" = EXCLUDED."refreshToken",
        "updatedAt" = pg_catalog.now();

  INSERT INTO public.notion_installations AS installation
    (user_id, workspace_id, workspace_name, active, revoked_at, updated_at)
  VALUES (p_user_id, p_workspace_id, p_workspace_name, 1, NULL, pg_catalog.now())
  ON CONFLICT (user_id) DO UPDATE
    SET workspace_id = EXCLUDED.workspace_id,
        workspace_name = EXCLUDED.workspace_name,
        active = 1,
        revoked_at = NULL,
        updated_at = pg_catalog.now()
  RETURNING id INTO v_installation_id;

  INSERT INTO public.inkwell_sync_state (installation_id)
  VALUES (v_installation_id)
  ON CONFLICT (installation_id) DO NOTHING;

  INSERT INTO public.session AS new_session
    (id, "expiresAt", token, "ipAddress", "userAgent", "userId")
  VALUES (p_session_id, p_expires_at, p_session_token_hash, p_ip_address, p_user_agent, p_user_id);

  DELETE FROM public.session AS old_session
   WHERE old_session."expiresAt" < pg_catalog.now()
      OR (old_session."userId" = p_user_id AND old_session.id <> p_session_id);

  RETURN v_installation_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_inkwell_connection_deletion(p_request_id_hash TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_user_id TEXT;
  v_status TEXT;
BEGIN
  SELECT user_id, status
    INTO v_user_id, v_status
    FROM public.inkwell_connection_deletion_receipts
   WHERE request_id_hash = p_request_id_hash;

  IF NOT FOUND THEN
    RETURN FALSE;
  END IF;
  IF v_status = 'completed' THEN
    RETURN TRUE;
  END IF;
  IF v_user_id IS NULL THEN
    RETURN FALSE;
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_user_id, 0)
  );

  SELECT user_id, status
    INTO v_user_id, v_status
    FROM public.inkwell_connection_deletion_receipts
   WHERE request_id_hash = p_request_id_hash
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN FALSE;
  END IF;
  IF v_status = 'completed' THEN
    RETURN TRUE;
  END IF;
  IF v_user_id IS NULL THEN
    RETURN FALSE;
  END IF;

  UPDATE public.inkwell_connection_deletion_receipts
     SET status = 'completed', user_id = NULL, updated_at = pg_catalog.now()
   WHERE request_id_hash = p_request_id_hash;
  DELETE FROM public."user" WHERE id = v_user_id;
  RETURN TRUE;
END;
$$;

REVOKE ALL ON FUNCTION public.prepare_inkwell_connection_deletion(TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.commit_notion_oauth_session(
  TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT,
  TIMESTAMPTZ, TEXT, TEXT, TEXT, TEXT
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_inkwell_connection_deletion(TEXT) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.prepare_inkwell_connection_deletion(TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.commit_notion_oauth_session(
  TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT,
  TIMESTAMPTZ, TEXT, TEXT, TEXT, TEXT
) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_inkwell_connection_deletion(TEXT) TO service_role;
