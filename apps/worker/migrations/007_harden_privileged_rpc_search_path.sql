-- Pin privileged RPC name resolution and qualify every table reference.
-- These functions are service-role only; keep that boundary explicit.

REVOKE ALL ON TABLE public.notion_webhook_setup FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.notion_webhook_setup TO service_role;

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

REVOKE ALL ON FUNCTION public.arm_notion_webhook_setup(TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.register_notion_webhook_verification_token(TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.consume_notion_webhook_verification_token() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reset_notion_webhook_setup() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_inkwell_connection_deletion(TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.increment_block_version(BIGINT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.arm_notion_webhook_setup(TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.register_notion_webhook_verification_token(TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.consume_notion_webhook_verification_token() TO service_role;
GRANT EXECUTE ON FUNCTION public.reset_notion_webhook_setup() TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_inkwell_connection_deletion(TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.increment_block_version(BIGINT, TEXT, TEXT) TO service_role;
