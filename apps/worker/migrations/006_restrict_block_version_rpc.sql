-- The sync worker is the only caller of this write RPC. Keep the table change
-- behind RLS and prevent the PostgREST anon/authenticated roles from invoking it.
CREATE OR REPLACE FUNCTION public.increment_block_version(
  p_installation_id BIGINT,
  p_local_id TEXT,
  p_entity_type TEXT
) RETURNS BIGINT
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE v_version BIGINT;
BEGIN
  INSERT INTO public.notion_block_sync (installation_id, local_id, entity_type, local_version, status)
  VALUES (p_installation_id, p_local_id, p_entity_type, 1, 'pending')
  ON CONFLICT (installation_id, local_id) DO UPDATE
    SET local_version = notion_block_sync.local_version + 1,
        status = 'pending',
        updated_at = now()
  RETURNING local_version INTO v_version;
  RETURN v_version;
END;
$$;

REVOKE ALL ON FUNCTION public.increment_block_version(BIGINT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.increment_block_version(BIGINT, TEXT, TEXT) TO service_role;
