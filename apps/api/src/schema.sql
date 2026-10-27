-- BalanzaWeb schema.
-- Written in portable SQL: the development store is SQLite (node:sqlite),
-- production runs the same tables on MySQL. See src/db.js.

CREATE TABLE IF NOT EXISTS sedes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  revision INTEGER NOT NULL DEFAULT 1,
  poll_interval_seconds INTEGER NOT NULL DEFAULT 60,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS scales (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sede_id INTEGER NOT NULL REFERENCES sedes(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  host TEXT NOT NULL,
  port INTEGER NOT NULL DEFAULT 5001,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_seen_at TEXT,
  last_result TEXT,
  UNIQUE (sede_id, name)
);

CREATE TABLE IF NOT EXISTS agents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sede_id INTEGER NOT NULL REFERENCES sedes(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  machine_id TEXT,
  last_seen_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pairing_codes (
  code TEXT PRIMARY KEY,
  sede_id INTEGER NOT NULL REFERENCES sedes(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS articles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  barcode INTEGER NOT NULL UNIQUE,
  name TEXT NOT NULL,
  lf_code INTEGER NOT NULL UNIQUE,
  plu_number INTEGER NOT NULL DEFAULT 0,
  price_cents INTEGER NOT NULL,
  unit_code INTEGER NOT NULL,
  department INTEGER NOT NULL,
  validity_days INTEGER NOT NULL,
  package_type INTEGER NOT NULL DEFAULT 0,
  barcode_type INTEGER NOT NULL DEFAULT 7,
  active INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS deployments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sede_id INTEGER NOT NULL REFERENCES sedes(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  scale_ids TEXT,
  article_count INTEGER NOT NULL,
  catalog_hash TEXT NOT NULL,
  catalog_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS deployment_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  deployment_id INTEGER,
  sede_id INTEGER NOT NULL,
  scale_id INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  ok INTEGER NOT NULL,
  records INTEGER,
  frames INTEGER,
  duration_ms INTEGER,
  error TEXT,
  created_at TEXT NOT NULL
);


CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  last_login_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS roles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS role_permissions (
  role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission TEXT NOT NULL,
  PRIMARY KEY (role_id, permission)
);

CREATE TABLE IF NOT EXISTS user_roles (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, role_id)
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

