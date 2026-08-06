-- 『ぽこもふ島』永続化スキーマ（docs/02_ゲーム実装プラン/03_データモデル.md §3）
--
-- 方針: メモリ上の構造体が「正」。ここは永続化と記憶検索のための保存先。
-- 起動時に CREATE TABLE IF NOT EXISTS でそのまま適用する（破壊的変更はしない）。
--
-- docs 03章からの追加点（理由つき）:
--   1. island.last_weather_roll_tick
--      WorldClock は「1島時間ごとに10%で天気を抽選」する状態を持つため、
--      これを保存しないと再起動直後に抽選タイミングがズレて決定論が崩れる。
--   2. island_snapshot.next_entity_id / rng_state_json
--      ID採番とRNGの内部状態は復元しないと「同じseedなら同じ進行」が続かない。
--      決定論の継続に必要なのでスナップショットへ含める。
--   3. player(secret_hash) の UNIQUE インデックスと player(island_id) のインデックス
--      hello の secret 引き当てを毎接続で行うため。テーブル定義自体は変えていない。

PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;

-- 島インスタンスの状態（1行 = 1島）
CREATE TABLE IF NOT EXISTS island (
  id            TEXT PRIMARY KEY,          -- 'main' など
  seed          TEXT NOT NULL,
  tick          INTEGER NOT NULL,          -- 累積tick（4Hz）
  island_day    INTEGER NOT NULL,
  season        TEXT NOT NULL,
  weather       TEXT NOT NULL,
  last_weather_roll_tick INTEGER NOT NULL DEFAULT 0,  -- 追加: 天気抽選の位相
  updated_at    INTEGER NOT NULL           -- unix ms（catch-up判定に使う）
);

-- 30秒ごとのスナップショット（動物・資源・設置物をまとめてJSONで）
CREATE TABLE IF NOT EXISTS island_snapshot (
  island_id       TEXT PRIMARY KEY,
  tick            INTEGER NOT NULL,
  critters_json   TEXT NOT NULL,
  resources_json  TEXT NOT NULL,
  placeables_json TEXT NOT NULL,
  tiles_decay     BLOB NOT NULL,            -- 128*128 の Uint8Array
  next_entity_id  INTEGER NOT NULL DEFAULT 1,   -- 追加: ID採番の継続
  rng_state_json  TEXT NOT NULL DEFAULT '[0,0,0,0]' -- 追加: xorshift128 の状態
);

CREATE TABLE IF NOT EXISTS player (
  id            TEXT PRIMARY KEY,
  secret_hash   TEXT NOT NULL,              -- 匿名認証用
  display_name  TEXT NOT NULL,
  island_id     TEXT NOT NULL,
  last_pos_x    REAL NOT NULL,
  last_pos_y    REAL NOT NULL,
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_player_secret ON player(secret_hash);
CREATE INDEX IF NOT EXISTS idx_player_island ON player(island_id);

CREATE TABLE IF NOT EXISTS pet (
  id            INTEGER PRIMARY KEY,        -- EntityId
  player_id     TEXT NOT NULL UNIQUE REFERENCES player(id),
  species       TEXT NOT NULL,              -- mofi/mizune/hakka/momona/hoshira
  name          TEXT NOT NULL,
  persona_json  TEXT NOT NULL,              -- 性格タグ・口ぐせ・好物・苦手
  traits_json   TEXT NOT NULL,
  affection     REAL NOT NULL DEFAULT 30,
  summary       TEXT NOT NULL DEFAULT '',   -- 長期記憶の圧縮テキスト
  created_at    INTEGER NOT NULL
);

-- 島の出来事（誰の記憶にもなりうる客観ログ）
CREATE TABLE IF NOT EXISTS island_event (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  island_id     TEXT NOT NULL,
  tick          INTEGER NOT NULL,
  island_day    INTEGER NOT NULL,
  kind          TEXT NOT NULL,              -- born/died/quarrel/befriend/harvest/build/weather...
  actor_id      INTEGER,
  target_id     INTEGER,
  pos_x         REAL, pos_y REAL,
  text          TEXT NOT NULL,              -- 「ミズネがハッカとケンカした」
  importance    INTEGER NOT NULL            -- 1..10
);
CREATE INDEX IF NOT EXISTS idx_event_day ON island_event(island_id, island_day);

-- ペットのエピソード記憶（主観。island_eventから複写 or 会話から生成）
CREATE TABLE IF NOT EXISTS pet_memory (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  pet_id        INTEGER NOT NULL REFERENCES pet(id),
  tick          INTEGER NOT NULL,
  island_day    INTEGER NOT NULL,
  kind          TEXT NOT NULL,              -- talk/observe/gossip/diary
  text          TEXT NOT NULL,
  keywords      TEXT NOT NULL,              -- 空白区切り。検索用
  importance    INTEGER NOT NULL,           -- 1..10
  last_access_tick INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mem_pet ON pet_memory(pet_id, tick DESC);

-- 会話ログ（プレイヤー↔ペット、ペット↔ペット）
CREATE TABLE IF NOT EXISTS chat_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  island_id     TEXT NOT NULL,
  tick          INTEGER NOT NULL,
  speaker_kind  TEXT NOT NULL,              -- player/pet/critter
  speaker_id    TEXT NOT NULL,
  listener_id   TEXT,
  text          TEXT NOT NULL
);

-- 個体間の好感度（動物含む。上限を超えたら弱い関係から削除）
CREATE TABLE IF NOT EXISTS relation (
  a_id          INTEGER NOT NULL,
  b_id          INTEGER NOT NULL,
  score         REAL NOT NULL,              -- -100..100
  met_count     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (a_id, b_id)
);

-- LLM使用量（コスト監視とレート制限の永続化）
CREATE TABLE IF NOT EXISTS llm_usage (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ts            INTEGER NOT NULL,
  player_id     TEXT,
  purpose       TEXT NOT NULL,              -- dialogue/decide/diary/gossip
  prompt_tokens INTEGER NOT NULL,
  completion_tokens INTEGER NOT NULL,
  latency_ms    INTEGER NOT NULL,
  ok            INTEGER NOT NULL
);
