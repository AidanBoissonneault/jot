-- Protected, one-time retrieval of Notion's webhook verification token.
-- Run this on existing Supabase projects before deploying the Worker changes.

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

ALTER TABLE notion_webhook_setup
  ADD COLUMN IF NOT EXISTS setup_callback_token_hash TEXT;

INSERT INTO notion_webhook_setup (id)
VALUES (1)
ON CONFLICT (id) DO NOTHING;

ALTER TABLE notion_webhook_setup ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_notion_webhook_setup" ON notion_webhook_setup;
CREATE POLICY "service_role_notion_webhook_setup"
  ON notion_webhook_setup FOR ALL TO service_role
  USING (true) WITH CHECK (true);
GRANT ALL ON TABLE notion_webhook_setup TO service_role;

DROP FUNCTION IF EXISTS arm_notion_webhook_setup();
CREATE OR REPLACE FUNCTION arm_notion_webhook_setup(p_callback_token_hash TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_armed BOOLEAN := FALSE;
BEGIN
  IF p_callback_token_hash IS NULL OR length(p_callback_token_hash) <> 64 THEN
    RETURN FALSE;
  END IF;

  UPDATE notion_webhook_setup
     SET setup_callback_token_hash = p_callback_token_hash,
         setup_armed_until = now() + INTERVAL '10 minutes',
         updated_at = now()
   WHERE id = 1
     AND verification_token IS NULL
  RETURNING TRUE INTO v_armed;
  RETURN COALESCE(v_armed, FALSE);
END;
$$;

DROP FUNCTION IF EXISTS register_notion_webhook_verification_token(TEXT);
CREATE OR REPLACE FUNCTION register_notion_webhook_verification_token(
  p_token TEXT,
  p_callback_token_hash TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_current_token TEXT;
  v_current_callback_token_hash TEXT;
  v_armed_until TIMESTAMPTZ;
BEGIN
  SELECT verification_token, setup_callback_token_hash, setup_armed_until
    INTO v_current_token, v_current_callback_token_hash, v_armed_until
    FROM notion_webhook_setup
   WHERE id = 1
   FOR UPDATE;

  IF v_current_token IS NOT NULL THEN
    RETURN v_current_token = p_token AND v_current_callback_token_hash = p_callback_token_hash;
  END IF;
  IF p_token IS NULL OR length(p_token) = 0 OR length(p_token) > 4096
     OR p_callback_token_hash IS NULL OR v_current_callback_token_hash IS DISTINCT FROM p_callback_token_hash
     OR v_armed_until IS NULL OR v_armed_until <= now() THEN
    RETURN FALSE;
  END IF;

  UPDATE notion_webhook_setup
     SET verification_token = p_token,
         setup_armed_until = NULL,
         updated_at = now()
   WHERE id = 1;
  RETURN TRUE;
END;
$$;

CREATE OR REPLACE FUNCTION consume_notion_webhook_verification_token()
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_token TEXT;
BEGIN
  UPDATE notion_webhook_setup
     SET retrieved_at = now(),
         updated_at = now()
   WHERE id = 1
     AND verification_token IS NOT NULL
     AND retrieved_at IS NULL
  RETURNING verification_token INTO v_token;
  RETURN v_token;
END;
$$;

CREATE OR REPLACE FUNCTION reset_notion_webhook_setup()
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE notion_webhook_setup
     SET verification_token = NULL,
         setup_callback_token_hash = NULL,
         retrieved_at = NULL,
         setup_armed_until = NULL,
         updated_at = now()
   WHERE id = 1;
  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION arm_notion_webhook_setup(TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION register_notion_webhook_verification_token(TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION consume_notion_webhook_verification_token() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION reset_notion_webhook_setup() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION arm_notion_webhook_setup(TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION register_notion_webhook_verification_token(TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION consume_notion_webhook_verification_token() TO service_role;
GRANT EXECUTE ON FUNCTION reset_notion_webhook_setup() TO service_role;
