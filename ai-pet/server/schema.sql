PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  coins         INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS pets (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  species        TEXT NOT NULL,
  personality    TEXT NOT NULL,           -- JSON: Personality
  needs          TEXT NOT NULL,           -- JSON: Needs
  stage          TEXT NOT NULL DEFAULT 'egg',
  care_score     INTEGER NOT NULL DEFAULT 0,
  action         TEXT NOT NULL DEFAULT 'idle',
  emotion        TEXT NOT NULL DEFAULT 'curious',
  born_at        INTEGER NOT NULL,
  needs_at       INTEGER NOT NULL,        -- ニーズを最後に計算した時刻
  last_think_at  INTEGER NOT NULL DEFAULT 0,
  last_encounter_at INTEGER NOT NULL DEFAULT 0,
  UNIQUE(user_id)
);

-- 記憶 第1層: 事実（key で上書きされるので矛盾しない）
CREATE TABLE IF NOT EXISTS pet_facts (
  pet_id     INTEGER NOT NULL REFERENCES pets(id) ON DELETE CASCADE,
  key        TEXT NOT NULL,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (pet_id, key)
);

-- 記憶 第2層: エピソード
CREATE TABLE IF NOT EXISTS pet_episodes (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  pet_id       INTEGER NOT NULL REFERENCES pets(id) ON DELETE CASCADE,
  summary      TEXT NOT NULL,
  importance   INTEGER NOT NULL DEFAULT 3,
  emotion      TEXT,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL,
  use_count    INTEGER NOT NULL DEFAULT 0,
  faded        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_episodes_pet ON pet_episodes(pet_id, faded);

-- 記憶 第3層: 直近会話
CREATE TABLE IF NOT EXISTS chat_turns (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  pet_id     INTEGER NOT NULL REFERENCES pets(id) ON DELETE CASCADE,
  role       TEXT NOT NULL,               -- 'owner' | 'pet'
  text       TEXT NOT NULL,
  emotion    TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_pet ON chat_turns(pet_id, id);

CREATE TABLE IF NOT EXISTS inventory (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL,
  count   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, item_id)
);

CREATE TABLE IF NOT EXISTS room_layout (
  user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  layout     TEXT NOT NULL,               -- JSON: RoomLayout
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS friends (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  friend_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, friend_id)
);

CREATE TABLE IF NOT EXISTS gifts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  from_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id      TEXT NOT NULL,
  message      TEXT NOT NULL DEFAULT '',
  created_at   INTEGER NOT NULL,
  claimed      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_gifts_to ON gifts(to_user_id, claimed);

CREATE TABLE IF NOT EXISTS visits (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  host_user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  visitor_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  comment         TEXT NOT NULL DEFAULT '',
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_visits_host ON visits(host_user_id, created_at);

-- ペット同士のAI交流ログ（本作の核）
CREATE TABLE IF NOT EXISTS encounters (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  pet_id         INTEGER NOT NULL REFERENCES pets(id) ON DELETE CASCADE,
  other_pet_id   INTEGER NOT NULL REFERENCES pets(id) ON DELETE CASCADE,
  lines          TEXT NOT NULL,           -- JSON: EncounterLine[]
  souvenir       TEXT NOT NULL,           -- 自分のペットが語る土産話
  affinity_delta INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  seen           INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_encounters_pet ON encounters(pet_id, created_at);

CREATE TABLE IF NOT EXISTS pet_affinity (
  pet_id       INTEGER NOT NULL REFERENCES pets(id) ON DELETE CASCADE,
  other_pet_id INTEGER NOT NULL REFERENCES pets(id) ON DELETE CASCADE,
  affinity     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (pet_id, other_pet_id)
);

-- Finch 型の「今日の約束」軽量版
CREATE TABLE IF NOT EXISTS promises (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text       TEXT NOT NULL,
  for_date   TEXT NOT NULL,               -- YYYY-MM-DD（ローカル日付）
  done       INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_promises_user ON promises(user_id, for_date);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);
