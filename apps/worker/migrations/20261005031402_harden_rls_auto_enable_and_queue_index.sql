-- The DDL event trigger remains installed and continues to call this function.
-- This only removes direct execution privileges from API roles.
REVOKE ALL ON FUNCTION public.rls_auto_enable()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE INDEX IF NOT EXISTS idx_inkwell_sync_queue_payloads_installation_id
  ON public.inkwell_sync_queue_payloads (installation_id);
