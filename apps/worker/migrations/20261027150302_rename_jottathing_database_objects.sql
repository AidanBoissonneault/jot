-- Rename the branded persistence objects in place. These tables contain live
-- installations, OAuth generations, receipts, and queue payloads, so all data
-- and relationships stay attached to the same PostgreSQL objects.

ALTER TABLE public.inkwell_sync_state RENAME TO jottathing_sync_state;
ALTER TABLE public.jottathing_sync_state RENAME COLUMN inkwell_database_id TO jottathing_database_id;
ALTER TABLE public.jottathing_sync_state RENAME COLUMN inkwell_data_source_id TO jottathing_data_source_id;
ALTER TABLE public.jottathing_sync_state RENAME COLUMN inkwell_parent_page_id TO jottathing_parent_page_id;
ALTER TABLE public.jottathing_sync_state RENAME COLUMN inkwell_database_title TO jottathing_database_title;

ALTER TABLE public.inkwell_sync_queue_payloads RENAME TO jottathing_sync_queue_payloads;
ALTER TABLE public.inkwell_connection_deletion_receipts RENAME TO jottathing_connection_deletion_receipts;
ALTER TABLE public.inkwell_oauth_generation RENAME TO jottathing_oauth_generation;

ALTER TABLE public.jottathing_sync_state
  RENAME CONSTRAINT jot_sync_state_pkey TO jottathing_sync_state_pkey;
ALTER TABLE public.jottathing_sync_state
  RENAME CONSTRAINT jot_sync_state_installation_id_fkey TO jottathing_sync_state_installation_id_fkey;
ALTER TABLE public.jottathing_sync_queue_payloads
  RENAME CONSTRAINT inkwell_sync_queue_payloads_pkey TO jottathing_sync_queue_payloads_pkey;
ALTER TABLE public.jottathing_sync_queue_payloads
  RENAME CONSTRAINT inkwell_sync_queue_payloads_installation_id_fkey TO jottathing_sync_queue_payloads_installation_id_fkey;
ALTER TABLE public.jottathing_sync_queue_payloads
  RENAME CONSTRAINT inkwell_sync_queue_payloads_payload_check TO jottathing_sync_queue_payloads_payload_check;
ALTER TABLE public.jottathing_sync_queue_payloads
  RENAME CONSTRAINT inkwell_sync_queue_payloads_status_check TO jottathing_sync_queue_payloads_status_check;
ALTER TABLE public.jottathing_connection_deletion_receipts
  RENAME CONSTRAINT inkwell_connection_deletion_receipts_pkey TO jottathing_connection_deletion_receipts_pkey;
ALTER TABLE public.jottathing_connection_deletion_receipts
  RENAME CONSTRAINT inkwell_connection_deletion_receipts_check TO jottathing_connection_deletion_receipts_check;
ALTER TABLE public.jottathing_connection_deletion_receipts
  RENAME CONSTRAINT inkwell_connection_deletion_receipts_request_id_hash_check TO jottathing_connection_deletion_receipts_request_id_hash_check;
ALTER TABLE public.jottathing_connection_deletion_receipts
  RENAME CONSTRAINT inkwell_connection_deletion_receipts_status_check TO jottathing_connection_deletion_receipts_status_check;
ALTER TABLE public.jottathing_oauth_generation
  RENAME CONSTRAINT inkwell_oauth_generation_pkey TO jottathing_oauth_generation_pkey;
ALTER TABLE public.jottathing_oauth_generation
  RENAME CONSTRAINT inkwell_oauth_generation_id_check TO jottathing_oauth_generation_id_check;
ALTER TABLE public.jottathing_oauth_generation
  RENAME CONSTRAINT inkwell_oauth_generation_generation_check TO jottathing_oauth_generation_generation_check;

ALTER INDEX public.idx_inkwell_sync_queue_payloads_created_at
  RENAME TO idx_jottathing_sync_queue_payloads_created_at;
ALTER INDEX public.idx_inkwell_sync_queue_payloads_installation_id
  RENAME TO idx_jottathing_sync_queue_payloads_installation_id;

ALTER POLICY service_role_inkwell_sync_state ON public.jottathing_sync_state
  RENAME TO service_role_jottathing_sync_state;
ALTER POLICY service_role_inkwell_sync_queue_payloads ON public.jottathing_sync_queue_payloads
  RENAME TO service_role_jottathing_sync_queue_payloads;
ALTER POLICY service_role_inkwell_connection_deletion_receipts ON public.jottathing_connection_deletion_receipts
  RENAME TO service_role_jottathing_connection_deletion_receipts;
ALTER POLICY service_role_inkwell_oauth_generation ON public.jottathing_oauth_generation
  RENAME TO service_role_jottathing_oauth_generation;

-- Update SQL bodies without changing the old RPC names. That keeps already
-- deployed workers working while the current worker switches to Jottathing RPCs.
DO $$
DECLARE
  function_row RECORD;
  definition TEXT;
BEGIN
  FOR function_row IN
    SELECT p.oid
      FROM pg_catalog.pg_proc AS p
      JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.prosrc LIKE '%inkwell%'
  LOOP
    definition := pg_catalog.pg_get_functiondef(function_row.oid);
    definition := pg_catalog.replace(definition, 'public.inkwell_sync_state', 'public.jottathing_sync_state');
    definition := pg_catalog.replace(definition, 'public.inkwell_sync_queue_payloads', 'public.jottathing_sync_queue_payloads');
    definition := pg_catalog.replace(definition, 'public.inkwell_connection_deletion_receipts', 'public.jottathing_connection_deletion_receipts');
    definition := pg_catalog.replace(definition, 'public.inkwell_oauth_generation', 'public.jottathing_oauth_generation');
    definition := pg_catalog.replace(definition, 'inkwell_database_id', 'jottathing_database_id');
    definition := pg_catalog.replace(definition, 'inkwell_data_source_id', 'jottathing_data_source_id');
    definition := pg_catalog.replace(definition, 'inkwell_parent_page_id', 'jottathing_parent_page_id');
    definition := pg_catalog.replace(definition, 'inkwell_database_title', 'jottathing_database_title');
    EXECUTE definition;
  END LOOP;
END;
$$;

-- New RPC names delegate to the same hardened transactional functions. Legacy
-- RPC entry points remain available for a rolling extension/worker update.
CREATE OR REPLACE FUNCTION public.begin_jottathing_notion_logout(p_user_id TEXT)
RETURNS BOOLEAN
LANGUAGE SQL VOLATILE SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$ SELECT public.begin_inkwell_notion_logout(p_user_id) $$;

CREATE OR REPLACE FUNCTION public.complete_jottathing_notion_logout(
  p_user_id TEXT,
  p_session_token_hash TEXT
) RETURNS BOOLEAN
LANGUAGE SQL VOLATILE SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$ SELECT public.complete_inkwell_notion_logout(p_user_id, p_session_token_hash) $$;

CREATE OR REPLACE FUNCTION public.prepare_jottathing_connection_deletion(
  p_request_id_hash TEXT,
  p_user_id TEXT
) RETURNS JSONB
LANGUAGE SQL VOLATILE SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$ SELECT public.prepare_inkwell_connection_deletion(p_request_id_hash, p_user_id) $$;

CREATE OR REPLACE FUNCTION public.complete_jottathing_connection_deletion(p_request_id_hash TEXT)
RETURNS BOOLEAN
LANGUAGE SQL VOLATILE SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$ SELECT public.complete_inkwell_connection_deletion(p_request_id_hash) $$;

REVOKE ALL ON FUNCTION public.begin_jottathing_notion_logout(TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_jottathing_notion_logout(TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.prepare_jottathing_connection_deletion(TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_jottathing_connection_deletion(TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.begin_jottathing_notion_logout(TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_jottathing_notion_logout(TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.prepare_jottathing_connection_deletion(TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_jottathing_connection_deletion(TEXT) TO service_role;

NOTIFY pgrst, 'reload schema';
