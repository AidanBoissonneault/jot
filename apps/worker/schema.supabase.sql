-- Jot sync server — Supabase schema
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

CREATE TABLE IF NOT EXISTS jot_sync_state (
  installation_id BIGINT PRIMARY KEY REFERENCES notion_installations(id) ON DELETE CASCADE,
  jot_database_id TEXT,
  jot_data_source_id TEXT,
  jot_parent_page_id TEXT,
  jot_database_title TEXT,
  note_pages_json JSONB NOT NULL DEFAULT '{}',
  block_mappings_json JSONB NOT NULL DEFAULT '{}',
  parent_pages_json JSONB NOT NULL DEFAULT '{}',
  project_pages_json JSONB NOT NULL DEFAULT '{}',
  project_blocks_json JSONB NOT NULL DEFAULT '{}',
  thread_blocks_json JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Row Level Security
ALTER TABLE "user" ENABLE ROW LEVEL SECURITY;
ALTER TABLE session ENABLE ROW LEVEL SECURITY;
ALTER TABLE account ENABLE ROW LEVEL SECURITY;
ALTER TABLE notion_installations ENABLE ROW LEVEL SECURITY;
ALTER TABLE jot_sync_state ENABLE ROW LEVEL SECURITY;

-- Service role gets full access (worker uses service_role key)
CREATE POLICY "service_role_user"               ON "user"               FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_role_session"            ON session              FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_role_account"            ON account              FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_role_notion_installs"    ON notion_installations FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_role_jot_sync_state"     ON jot_sync_state      FOR ALL TO service_role USING (true) WITH CHECK (true);
