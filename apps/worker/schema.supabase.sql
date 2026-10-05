-- Inkwell sync server — Supabase schema
-- Run in Supabase SQL editor: project → SQL Editor → New query

CREATE TABLE IF NOT EXISTS "user" (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  "emailVerified" INTEGER NOT NULL DEFAULT 0,
  image TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS session (
  id TEXT PRIMARY KEY,
  "expiresAt" TIMESTAMPTZ NOT NULL,
  token TEXT NOT NULL UNIQUE,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "ipAddress" TEXT,
  "userAgent" TEXT,
  "userId" TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_session_user_id ON session("userId");

CREATE TABLE IF NOT EXISTS account (
  id TEXT PRIMARY KEY,
  "accountId" TEXT NOT NULL,
  "providerId" TEXT NOT NULL,
  "userId" TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  "accessToken" TEXT,
  "refreshToken" TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE("providerId", "accountId")
);

CREATE INDEX IF NOT EXISTS idx_account_user_id ON account("userId");

CREATE TABLE IF NOT EXISTS notion_installations (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE UNIQUE,
  workspace_id TEXT,
  workspace_name TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_notion_installations_user_id ON notion_installations(user_id);
CREATE INDEX IF NOT EXISTS idx_notion_installations_active ON notion_installations(active);

CREATE TABLE IF NOT EXISTS inkwell_sync_state (
  installation_id BIGINT PRIMARY KEY REFERENCES notion_installations(id) ON DELETE CASCADE,
  inkwell_database_id TEXT,
  inkwell_data_source_id TEXT,
  inkwell_parent_page_id TEXT,
  inkwell_database_title TEXT,
  note_pages_json JSONB NOT NULL DEFAULT '{}',
  block_mappings_json JSONB NOT NULL DEFAULT '{}',
  parent_pages_json JSONB NOT NULL DEFAULT '{}',
  project_pages_json JSONB NOT NULL DEFAULT '{}',
  project_blocks_json JSONB NOT NULL DEFAULT '{}',
  thread_blocks_json JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS notion_block_sync (
  installation_id BIGINT NOT NULL REFERENCES notion_installations(id) ON DELETE CASCADE,
  local_id        TEXT NOT NULL,
  notion_block_id TEXT,
  entity_type     TEXT NOT NULL,
  local_version   BIGINT NOT NULL DEFAULT 0,
  synced_version  BIGINT,
  status          TEXT NOT NULL DEFAULT 'pending',
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (installation_id, local_id)
);

CREATE INDEX IF NOT EXISTS idx_notion_block_sync_status ON notion_block_sync(status);

CREATE TABLE IF NOT EXISTS inkwell_sync_queue_payloads (
  id UUID PRIMARY KEY,
  installation_id BIGINT NOT NULL REFERENCES notion_installations(id) ON DELETE CASCADE,
  payload JSONB NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_inkwell_sync_queue_payloads_created_at
  ON inkwell_sync_queue_payloads(created_at);

CREATE INDEX IF NOT EXISTS idx_inkwell_sync_queue_payloads_installation_id
  ON inkwell_sync_queue_payloads(installation_id);

-- Atomically installs a Notion OAuth connection and its browser session.
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

REVOKE ALL ON FUNCTION public.commit_notion_oauth_session(
  TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT,
  TIMESTAMPTZ, TEXT, TEXT, TEXT, TEXT
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commit_notion_oauth_session(
  TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT,
  TIMESTAMPTZ, TEXT, TEXT, TEXT, TEXT
) TO service_role;

-- Keeps a retry capability after a successful server deletion whose response is lost.
-- Completed rows contain only a one-way random request hash and revocation outcome.
CREATE TABLE IF NOT EXISTS inkwell_connection_deletion_receipts (
  request_id_hash TEXT PRIMARY KEY CHECK (length(request_id_hash) = 64),
  user_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'completed')),
  notion_token_revoked BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((status = 'pending' AND user_id IS NOT NULL) OR (status = 'completed' AND user_id IS NULL))
);

ALTER TABLE inkwell_connection_deletion_receipts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_inkwell_connection_deletion_receipts"
  ON inkwell_connection_deletion_receipts;
CREATE POLICY "service_role_inkwell_connection_deletion_receipts"
  ON inkwell_connection_deletion_receipts FOR ALL TO service_role
  USING (true) WITH CHECK (true);
REVOKE ALL ON TABLE inkwell_connection_deletion_receipts FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE inkwell_connection_deletion_receipts TO service_role;

CREATE OR REPLACE FUNCTION public.complete_inkwell_connection_deletion(p_request_id_hash TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
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

REVOKE ALL ON FUNCTION public.complete_inkwell_connection_deletion(TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_inkwell_connection_deletion(TEXT) TO service_role;

CREATE OR REPLACE FUNCTION public.increment_block_version(
  p_installation_id BIGINT,
  p_local_id TEXT,
  p_entity_type TEXT
) RETURNS BIGINT
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE v_version BIGINT;
BEGIN
  INSERT INTO public.notion_block_sync AS block_sync (installation_id, local_id, entity_type, local_version, status)
  VALUES (p_installation_id, p_local_id, p_entity_type, 1, 'pending')
  ON CONFLICT (installation_id, local_id) DO UPDATE
    SET local_version = block_sync.local_version + 1,
        status = 'pending',
        updated_at = pg_catalog.now()
  RETURNING local_version INTO v_version;
  RETURN v_version;
END;
$$;

-- Row Level Security
ALTER TABLE "user" ENABLE ROW LEVEL SECURITY;
ALTER TABLE session ENABLE ROW LEVEL SECURITY;
ALTER TABLE account ENABLE ROW LEVEL SECURITY;
ALTER TABLE notion_installations ENABLE ROW LEVEL SECURITY;
ALTER TABLE inkwell_sync_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE inkwell_sync_queue_payloads ENABLE ROW LEVEL SECURITY;

-- Service role gets full access (worker uses service_role key)
CREATE POLICY "service_role_user"               ON "user"               FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_role_session"            ON session              FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_role_account"            ON account              FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_role_notion_installs"    ON notion_installations FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_role_inkwell_sync_state"     ON inkwell_sync_state      FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE notion_block_sync ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_notion_block_sync" ON notion_block_sync FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_role_inkwell_sync_queue_payloads" ON inkwell_sync_queue_payloads FOR ALL TO service_role USING (true) WITH CHECK (true);
REVOKE ALL ON TABLE inkwell_sync_queue_payloads FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE inkwell_sync_queue_payloads TO service_role;
-- Migration v2: Notion webhook staleness + cross-device version tracking
-- Run in Supabase SQL editor: project → SQL Editor → New query

-- Add staleness columns to notion_block_sync
ALTER TABLE notion_block_sync
  ADD COLUMN IF NOT EXISTS is_stale BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS stale_since TIMESTAMPTZ;

-- Add webhook subscription ID to notion_installations
ALTER TABLE notion_installations
  ADD COLUMN IF NOT EXISTS notion_webhook_id TEXT;

-- Migration v3: protected, one-time retrieval of Notion's webhook verification token
CREATE TABLE IF NOT EXISTS notion_webhook_setup (
  id SMALLINT PRIMARY KEY CHECK (id = 1),
  verification_token TEXT,
  setup_callback_token_hash TEXT,
  retrieved_at TIMESTAMPTZ,
  setup_armed_until TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (retrieved_at IS NULL OR verification_token IS NOT NULL),
  CHECK (setup_armed_until IS NULL OR verification_token IS NULL)
);

INSERT INTO notion_webhook_setup (id)
VALUES (1)
ON CONFLICT (id) DO NOTHING;

ALTER TABLE notion_webhook_setup
  ADD COLUMN IF NOT EXISTS setup_callback_token_hash TEXT;

ALTER TABLE notion_webhook_setup ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_notion_webhook_setup"
  ON notion_webhook_setup FOR ALL TO service_role
  USING (true) WITH CHECK (true);
GRANT ALL ON TABLE notion_webhook_setup TO service_role;
REVOKE ALL ON TABLE notion_webhook_setup FROM PUBLIC, anon, authenticated;

DROP FUNCTION IF EXISTS arm_notion_webhook_setup();
CREATE OR REPLACE FUNCTION public.arm_notion_webhook_setup(p_callback_token_hash TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE v_armed BOOLEAN := FALSE;
BEGIN
  IF p_callback_token_hash IS NULL OR pg_catalog.length(p_callback_token_hash) <> 64 THEN
    RETURN FALSE;
  END IF;

  UPDATE public.notion_webhook_setup
     SET setup_callback_token_hash = p_callback_token_hash,
         setup_armed_until = pg_catalog.now() + INTERVAL '10 minutes',
         updated_at = pg_catalog.now()
   WHERE id = 1
     AND verification_token IS NULL
  RETURNING TRUE INTO v_armed;
  RETURN COALESCE(v_armed, FALSE);
END;
$$;

REVOKE ALL ON FUNCTION public.increment_block_version(BIGINT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.increment_block_version(BIGINT, TEXT, TEXT) TO service_role;

DROP FUNCTION IF EXISTS register_notion_webhook_verification_token(TEXT);
CREATE OR REPLACE FUNCTION public.register_notion_webhook_verification_token(
  p_token TEXT,
  p_callback_token_hash TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_current_token TEXT;
  v_current_callback_token_hash TEXT;
  v_armed_until TIMESTAMPTZ;
BEGIN
  SELECT verification_token, setup_callback_token_hash, setup_armed_until
    INTO v_current_token, v_current_callback_token_hash, v_armed_until
    FROM public.notion_webhook_setup
   WHERE id = 1
   FOR UPDATE;

  IF v_current_token IS NOT NULL THEN
    RETURN v_current_token = p_token AND v_current_callback_token_hash = p_callback_token_hash;
  END IF;
  IF p_token IS NULL OR pg_catalog.length(p_token) = 0 OR pg_catalog.length(p_token) > 4096
     OR p_callback_token_hash IS NULL OR v_current_callback_token_hash IS DISTINCT FROM p_callback_token_hash
     OR v_armed_until IS NULL OR v_armed_until <= pg_catalog.now() THEN
    RETURN FALSE;
  END IF;

  UPDATE public.notion_webhook_setup
     SET verification_token = p_token,
         setup_armed_until = NULL,
         updated_at = pg_catalog.now()
   WHERE id = 1;
  RETURN TRUE;
END;
$$;

CREATE OR REPLACE FUNCTION public.consume_notion_webhook_verification_token()
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE v_token TEXT;
BEGIN
  UPDATE public.notion_webhook_setup
     SET retrieved_at = pg_catalog.now(),
         updated_at = pg_catalog.now()
   WHERE id = 1
     AND verification_token IS NOT NULL
     AND retrieved_at IS NULL
  RETURNING verification_token INTO v_token;
  RETURN v_token;
END;
$$;

CREATE OR REPLACE FUNCTION public.reset_notion_webhook_setup()
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  UPDATE public.notion_webhook_setup
     SET verification_token = NULL,
         setup_callback_token_hash = NULL,
         retrieved_at = NULL,
         setup_armed_until = NULL,
         updated_at = pg_catalog.now()
   WHERE id = 1;
  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION public.arm_notion_webhook_setup(TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.register_notion_webhook_verification_token(TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.consume_notion_webhook_verification_token() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reset_notion_webhook_setup() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.arm_notion_webhook_setup(TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.register_notion_webhook_verification_token(TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.consume_notion_webhook_verification_token() TO service_role;
GRANT EXECUTE ON FUNCTION public.reset_notion_webhook_setup() TO service_role;
-- Serialize deletion preparation with OAuth persistence so deletion revokes
-- the newest credential and invalidates OAuth callbacks from an older generation.

-- OAuth state carries this signed version. Advancing it at completion invalidates
-- callbacks that began before or during the wipe after pending receipts protected them.
CREATE TABLE IF NOT EXISTS public.inkwell_oauth_generation (
  id SMALLINT PRIMARY KEY CHECK (id = 1),
  generation BIGINT NOT NULL DEFAULT 1 CHECK (generation > 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now()
);
INSERT INTO public.inkwell_oauth_generation (id) VALUES (1)
ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.inkwell_oauth_generation ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_inkwell_oauth_generation"
  ON public.inkwell_oauth_generation;
CREATE POLICY "service_role_inkwell_oauth_generation"
  ON public.inkwell_oauth_generation FOR ALL TO service_role
  USING (true) WITH CHECK (true);
REVOKE ALL ON TABLE public.inkwell_oauth_generation FROM PUBLIC, anon, authenticated;
GRANT SELECT, UPDATE ON TABLE public.inkwell_oauth_generation TO service_role;

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
  p_workspace_name TEXT,
  p_oauth_generation TEXT
) RETURNS BIGINT
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_installation_id BIGINT;
  v_current_generation BIGINT;
  v_existing_user_id TEXT;
  v_existing_token TEXT;
BEGIN
  IF p_user_id IS NULL OR p_user_id = ''
     OR p_account_row_id IS NULL OR p_account_id IS NULL OR p_account_id = ''
     OR p_access_token IS NULL OR p_access_token = ''
     OR p_session_id IS NULL OR p_session_token_hash IS NULL OR p_session_token_hash = ''
     OR p_expires_at IS NULL OR p_name IS NULL OR p_email IS NULL
     OR p_oauth_generation IS NULL OR p_oauth_generation !~ '^(0|[1-9][0-9]{0,18})$' THEN
    RAISE EXCEPTION 'Invalid OAuth session input';
  END IF;

  -- Match the deletion transaction's lock before observing pending deletion.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_user_id, 0)
  );
  SELECT generation
    INTO v_current_generation
    FROM public.inkwell_oauth_generation
   WHERE id = 1
   FOR SHARE;
  IF NOT FOUND OR v_current_generation::TEXT IS DISTINCT FROM p_oauth_generation THEN
    RAISE EXCEPTION 'Notion OAuth flow was invalidated by a connection deletion';
  END IF;
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

-- Remove the previous 15-argument entry point so it cannot bypass generation checks.
DROP FUNCTION IF EXISTS public.commit_notion_oauth_session(
  TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT,
  TIMESTAMPTZ, TEXT, TEXT, TEXT, TEXT
);

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

  UPDATE public.inkwell_oauth_generation
     SET generation = generation + 1,
         updated_at = pg_catalog.now()
   WHERE id = 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'OAuth generation is unavailable';
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
  TIMESTAMPTZ, TEXT, TEXT, TEXT, TEXT, TEXT
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_inkwell_connection_deletion(TEXT) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.prepare_inkwell_connection_deletion(TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.commit_notion_oauth_session(
  TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT,
  TIMESTAMPTZ, TEXT, TEXT, TEXT, TEXT, TEXT
) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_inkwell_connection_deletion(TEXT) TO service_role;

NOTIFY pgrst, 'reload schema';

-- Serialize logout with OAuth commits so an in-flight callback cannot restore tokens.
ALTER TABLE public."user"
  ADD COLUMN IF NOT EXISTS logout_pending BOOLEAN NOT NULL DEFAULT FALSE;
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
  p_workspace_name TEXT,
  p_oauth_generation TEXT
) RETURNS BIGINT
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_installation_id BIGINT;
  v_current_generation BIGINT;
  v_existing_user_id TEXT;
  v_existing_token TEXT;
BEGIN
  IF p_user_id IS NULL OR p_user_id = ''
     OR p_account_row_id IS NULL OR p_account_id IS NULL OR p_account_id = ''
     OR p_access_token IS NULL OR p_access_token = ''
     OR p_session_id IS NULL OR p_session_token_hash IS NULL OR p_session_token_hash = ''
     OR p_expires_at IS NULL OR p_name IS NULL OR p_email IS NULL
     OR p_oauth_generation IS NULL OR p_oauth_generation !~ '^(0|[1-9][0-9]{0,18})$' THEN
    RAISE EXCEPTION 'Invalid OAuth session input';
  END IF;

  -- Match the deletion transaction's lock before observing pending deletion.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_user_id, 0)
  );
  SELECT generation
    INTO v_current_generation
    FROM public.inkwell_oauth_generation
   WHERE id = 1
   FOR SHARE;
  IF NOT FOUND OR v_current_generation::TEXT IS DISTINCT FROM p_oauth_generation THEN
    RAISE EXCEPTION 'Notion OAuth flow was invalidated by a connection deletion';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM public.inkwell_connection_deletion_receipts AS receipt
     WHERE receipt.user_id = p_user_id
       AND receipt.status = 'pending'
  ) THEN
    RAISE EXCEPTION 'Inkwell connection deletion is in progress';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public."user" AS inkwell_user
     WHERE inkwell_user.id = p_user_id
       AND inkwell_user.logout_pending
  ) THEN
    RAISE EXCEPTION 'Inkwell logout is in progress';
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
CREATE OR REPLACE FUNCTION public.begin_inkwell_notion_logout(p_user_id TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_logout_pending BOOLEAN;
BEGIN
  IF p_user_id IS NULL OR p_user_id = '' THEN
    RAISE EXCEPTION 'Invalid Notion logout input';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_user_id, 0)
  );

  SELECT logout_pending
    INTO v_logout_pending
    FROM public."user"
   WHERE id = p_user_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN FALSE;
  END IF;

  IF NOT v_logout_pending THEN
    UPDATE public.inkwell_oauth_generation
       SET generation = generation + 1,
           updated_at = pg_catalog.now()
     WHERE id = 1;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'OAuth generation is unavailable';
    END IF;

    UPDATE public."user"
       SET logout_pending = TRUE,
           "updatedAt" = pg_catalog.now()
     WHERE id = p_user_id;
    UPDATE public.notion_installations
       SET active = 0,
           revoked_at = pg_catalog.now(),
           updated_at = pg_catalog.now()
     WHERE user_id = p_user_id;
  END IF;

  RETURN TRUE;
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_inkwell_notion_logout(
  p_user_id TEXT,
  p_session_token_hash TEXT
) RETURNS BOOLEAN
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_logout_pending BOOLEAN;
BEGIN
  IF p_user_id IS NULL OR p_user_id = ''
     OR p_session_token_hash IS NULL OR p_session_token_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'Invalid Notion logout input';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_user_id, 0)
  );

  SELECT logout_pending
    INTO v_logout_pending
    FROM public."user"
   WHERE id = p_user_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN FALSE;
  END IF;

  -- A repeated call is successful only when its session was already removed.
  IF NOT v_logout_pending THEN
    RETURN NOT EXISTS (
      SELECT 1
        FROM public.session AS existing_session
       WHERE existing_session."userId" = p_user_id
         AND existing_session.token = p_session_token_hash
    );
  END IF;

  UPDATE public.inkwell_oauth_generation
     SET generation = generation + 1,
         updated_at = pg_catalog.now()
   WHERE id = 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'OAuth generation is unavailable';
  END IF;

  UPDATE public.account
     SET "accessToken" = NULL,
         "refreshToken" = NULL,
         "updatedAt" = pg_catalog.now()
   WHERE "userId" = p_user_id
     AND "providerId" = 'notion';
  UPDATE public.notion_installations
     SET active = 0,
         revoked_at = pg_catalog.now(),
         updated_at = pg_catalog.now()
   WHERE user_id = p_user_id;
  DELETE FROM public.session
   WHERE "userId" = p_user_id
     AND token = p_session_token_hash;
  UPDATE public."user"
     SET logout_pending = FALSE,
         "updatedAt" = pg_catalog.now()
   WHERE id = p_user_id;

  RETURN TRUE;
END;
$$;

REVOKE ALL ON FUNCTION public.begin_inkwell_notion_logout(TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_inkwell_notion_logout(TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.begin_inkwell_notion_logout(TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_inkwell_notion_logout(TEXT, TEXT) TO service_role;

-- Keep direct API callers from invoking the helper without changing its active
-- ensure_rls DDL event trigger. Older bootstrap targets may not have the helper.
DO $$
BEGIN
  IF pg_catalog.to_regprocedure('public.rls_auto_enable()') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.rls_auto_enable() FROM PUBLIC, anon, authenticated, service_role';
  END IF;
END;
$$;

NOTIFY pgrst, 'reload schema';
