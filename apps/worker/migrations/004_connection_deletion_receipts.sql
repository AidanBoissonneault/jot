-- Makes account deletion safe to retry if the server commits but its response is lost.
-- Pending rows are bound to the authenticated user; completed rows retain only a
-- one-way hash of the client's random request ID and the Notion revocation result.

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

CREATE OR REPLACE FUNCTION complete_inkwell_connection_deletion(p_request_id_hash TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id TEXT;
  v_status TEXT;
BEGIN
  SELECT user_id, status
    INTO v_user_id, v_status
    FROM inkwell_connection_deletion_receipts
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

  UPDATE inkwell_connection_deletion_receipts
     SET status = 'completed', user_id = NULL, updated_at = now()
   WHERE request_id_hash = p_request_id_hash;
  DELETE FROM "user" WHERE id = v_user_id;
  RETURN TRUE;
END;
$$;

REVOKE ALL ON FUNCTION complete_inkwell_connection_deletion(TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION complete_inkwell_connection_deletion(TEXT) TO service_role;
