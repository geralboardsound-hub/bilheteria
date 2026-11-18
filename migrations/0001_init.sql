-- Boardsound · esquema inicial (D1 / SQLite)
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,
  email       TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  role        TEXT NOT NULL DEFAULT 'operator',   -- admin | operator
  salt        TEXT NOT NULL,
  hash        TEXT NOT NULL,
  iterations  INTEGER NOT NULL,
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_exp ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS assets (
  id          TEXT PRIMARY KEY,
  mime        TEXT NOT NULL,
  bytes       INTEGER NOT NULL,
  blob        BLOB NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id               TEXT PRIMARY KEY,
  slug             TEXT NOT NULL UNIQUE,
  name             TEXT NOT NULL,
  event_date       TEXT,
  event_time       TEXT,
  venue            TEXT,
  city             TEXT,
  venue_capacity   INTEGER NOT NULL DEFAULT 0,   -- 0 = usar a soma dos lotes
  description      TEXT,
  flyer_asset      TEXT REFERENCES assets(id),
  accent           TEXT DEFAULT '#FFC400',
  cover            TEXT DEFAULT 'poster',
  headline         TEXT,
  note             TEXT,
  support_whatsapp TEXT,
  bank_name        TEXT,
  bank_holder      TEXT,
  bank_iban        TEXT,
  bank_account     TEXT,
  proof_whatsapp   TEXT,
  show_countdown   INTEGER NOT NULL DEFAULT 1,
  show_desc        INTEGER NOT NULL DEFAULT 1,
  show_note        INTEGER NOT NULL DEFAULT 1,
  status           TEXT NOT NULL DEFAULT 'draft', -- draft | published
  published_at     INTEGER,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_status ON events(status, published_at);

CREATE TABLE IF NOT EXISTS lots (
  id         TEXT PRIMARY KEY,
  event_id   TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  price      INTEGER NOT NULL,
  qty        INTEGER NOT NULL,
  position   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_lots_event ON lots(event_id, position);

CREATE TABLE IF NOT EXISTS orders (
  id                TEXT PRIMARY KEY,
  event_id          TEXT NOT NULL REFERENCES events(id),
  token_hash        TEXT NOT NULL UNIQUE,       -- o link do cliente nunca contém o id
  buyer_name        TEXT NOT NULL,
  buyer_phone       TEXT NOT NULL,
  buyer_aux         TEXT,
  total             INTEGER NOT NULL,
  status            TEXT NOT NULL,              -- pending | review | confirmed | expired
  created_at        INTEGER NOT NULL,
  deadline          INTEGER NOT NULL,
  confirmed_at      INTEGER,
  operator          TEXT,
  bank_ref          TEXT,
  ticket_link       TEXT,
  proof_asset       TEXT REFERENCES assets(id),
  proof_name        TEXT,
  proof_uploaded_at INTEGER,
  payment_bank      TEXT,
  payment_holder    TEXT,
  payment_iban      TEXT,
  payment_account   TEXT,
  payment_whatsapp  TEXT,
  message_status    TEXT DEFAULT 'prepared'     -- prepared | sent | failed
);
CREATE INDEX IF NOT EXISTS idx_orders_event ON orders(event_id, status);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status, deadline);

CREATE TABLE IF NOT EXISTS order_items (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  lot_id   TEXT,
  name     TEXT NOT NULL,
  price    INTEGER NOT NULL,
  qty      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_items_order ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_items_lot ON order_items(lot_id);

CREATE TABLE IF NOT EXISTS order_log (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  ts       INTEGER NOT NULL,
  text     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_log_order ON order_log(order_id);

CREATE TABLE IF NOT EXISTS credentials (
  id          TEXT PRIMARY KEY,
  event_id    TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  origin      TEXT NOT NULL DEFAULT 'production', -- production | artist
  invited_by  TEXT,
  operator    TEXT,
  phone       TEXT,
  ticket_link TEXT,
  notes       TEXT,
  created_at  INTEGER NOT NULL,
  created_by  TEXT
);
CREATE INDEX IF NOT EXISTS idx_credentials_event ON credentials(event_id);

CREATE TABLE IF NOT EXISTS rate_limits (
  key          TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count        INTEGER NOT NULL
);


/* ------------------------------------------------------------------ */
/* conta de administrador inicial — criada junto com a base de dados   */
/* e-mail: geral.boardsound@gmail.com   palavra-passe: @Angola123      */
/* (PBKDF2-SHA256, 210 000 iterações — mesmo formato usado no login)   */
/* ------------------------------------------------------------------ */
INSERT OR IGNORE INTO users (id, email, name, role, salt, hash, iterations, active, created_at)
VALUES ('u-ADMIN0001', 'geral.boardsound@gmail.com', 'Boardsound', 'admin',
        '9f2c71d40ba63e58c188247df0936b15', '3f88536eb547d4666d6e6f117fdb9dc4694b95f8e2358f58af1e6599351e0b5a', 210000, 1, 1794960000000);
