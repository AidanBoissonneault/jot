-- Keep document bodies out of Cloudflare Queue messages. Payload rows cascade
-- with the Notion installation so Delete connection removes pending cloud data.
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

ALTER TABLE inkwell_sync_queue_payloads ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_inkwell_sync_queue_payloads"
  ON inkwell_sync_queue_payloads;
CREATE POLICY "service_role_inkwell_sync_queue_payloads"
  ON inkwell_sync_queue_payloads FOR ALL TO service_role
  USING (true) WITH CHECK (true);
REVOKE ALL ON TABLE inkwell_sync_queue_payloads FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE inkwell_sync_queue_payloads TO service_role;
