CREATE TABLE IF NOT EXISTS user (
  id VARCHAR(191) NOT NULL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255) NOT NULL,
  emailVerified BOOLEAN NOT NULL DEFAULT false,
  image TEXT NULL,
  createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updatedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_user_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS session (
  id VARCHAR(191) NOT NULL PRIMARY KEY,
  expiresAt TIMESTAMP NOT NULL,
  token VARCHAR(255) NOT NULL,
  createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updatedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  ipAddress TEXT NULL,
  userAgent TEXT NULL,
  userId VARCHAR(191) NOT NULL,
  UNIQUE KEY uniq_session_token (token),
  INDEX idx_session_user_id (userId),
  CONSTRAINT fk_session_user
    FOREIGN KEY (userId)
    REFERENCES user (id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS account (
  id VARCHAR(191) NOT NULL PRIMARY KEY,
  accountId VARCHAR(255) NOT NULL,
  providerId VARCHAR(64) NOT NULL,
  userId VARCHAR(191) NOT NULL,
  accessToken TEXT NULL,
  refreshToken TEXT NULL,
  idToken TEXT NULL,
  accessTokenExpiresAt TIMESTAMP NULL,
  refreshTokenExpiresAt TIMESTAMP NULL,
  scope TEXT NULL,
  password TEXT NULL,
  createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updatedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_account_user_id (userId),
  UNIQUE KEY uniq_account_provider_account (providerId, accountId),
  CONSTRAINT fk_account_user
    FOREIGN KEY (userId)
    REFERENCES user (id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS verification (
  id VARCHAR(191) NOT NULL PRIMARY KEY,
  identifier VARCHAR(255) NOT NULL,
  value TEXT NOT NULL,
  expiresAt TIMESTAMP NOT NULL,
  createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updatedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_verification_identifier (identifier)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS notion_installations (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id VARCHAR(191) NOT NULL,
  workspace_id VARCHAR(128) NULL,
  workspace_name VARCHAR(255) NULL,
  active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  revoked_at TIMESTAMP NULL,
  INDEX idx_notion_installations_active (active),
  INDEX idx_notion_installations_user_id (user_id),
  CONSTRAINT fk_notion_installations_user
    FOREIGN KEY (user_id)
    REFERENCES user (id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS jot_sync_state (
  installation_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  jot_database_id VARCHAR(128) NULL,
  jot_data_source_id VARCHAR(128) NULL,
  jot_parent_page_id VARCHAR(128) NULL,
  jot_database_title VARCHAR(255) NULL,
  note_pages_json JSON NOT NULL,
  block_mappings_json JSON NOT NULL,
  parent_pages_json JSON NOT NULL,
  project_pages_json JSON NOT NULL,
  project_blocks_json JSON NOT NULL,
  thread_blocks_json JSON NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_jot_sync_state_installation
    FOREIGN KEY (installation_id)
    REFERENCES notion_installations (id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
