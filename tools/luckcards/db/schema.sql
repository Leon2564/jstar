-- jstarcards / Cloudflare D1
--
-- 核心思想：卡池是数据不是代码。首期(S1)封顶 230,400 张，与实体卡 1:1；
-- 将来加第二弹只是插一行 series + 一批新码 + 一批新 design，引擎不动。

-- ─────────────────────────── 卡池 ───────────────────────────

CREATE TABLE IF NOT EXISTS series (
  id           TEXT PRIMARY KEY,          -- 'S1'
  title        TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'draft'
               CHECK (status IN ('draft', 'live', 'closed')),
  total_quota  INTEGER NOT NULL,          -- 该弹总发行量，= 码数 × 每码抽数
  created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS actors (
  id         TEXT PRIMARY KEY,
  name_ja    TEXT NOT NULL,
  name_zh    TEXT,
  name_en    TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS card_designs (
  id         TEXT PRIMARY KEY,            -- 'S1-a1-UR-01'
  series_id  TEXT NOT NULL REFERENCES series(id),
  actor_id   TEXT NOT NULL REFERENCES actors(id),
  tier       TEXT NOT NULL CHECK (tier IN ('N','R','SR','SSR','UR')),
  title_ja   TEXT,
  asset_key  TEXT NOT NULL,               -- R2 对象键，不直接暴露给前端
  quota      INTEGER NOT NULL,            -- 发行量上限，发完即绝版
  issued     INTEGER NOT NULL DEFAULT 0,  -- 已发出编号数
  CHECK (issued <= quota)
);

-- 抽卡时要按「剩余量」加权，这个索引让扫描只碰还有货的设计
CREATE INDEX IF NOT EXISTS idx_designs_pool
  ON card_designs(series_id, tier) WHERE issued < quota;

-- ─────────────────────────── 用户 ───────────────────────────

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  provider      TEXT NOT NULL CHECK (provider IN ('line', 'google')),
  provider_uid  TEXT NOT NULL,
  display_name  TEXT,
  locale        TEXT NOT NULL DEFAULT 'ja',
  age_confirmed_at INTEGER,               -- 自我声明成年的时间戳，留证
  age_confirm_ip_hash TEXT,
  created_at    INTEGER NOT NULL,
  UNIQUE (provider, provider_uid)
);

-- ─────────────────────────── 验证码 ───────────────────────────

CREATE TABLE IF NOT EXISTS codes (
  serial       TEXT PRIMARY KEY,          -- 印厂流水号，用于对账与物流追溯
  code_hash    TEXT NOT NULL UNIQUE,      -- HMAC-SHA256(secret, code)；明文永不入库
  series_id    TEXT NOT NULL REFERENCES series(id),
  status       TEXT NOT NULL DEFAULT 'unused'
               CHECK (status IN ('unused', 'redeemed', 'void')),
  redeemed_by  TEXT REFERENCES users(id), -- 一经绑定不可转移
  redeemed_at  INTEGER,
  batch        TEXT NOT NULL,
  created_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_codes_status ON codes(status);
CREATE INDEX IF NOT EXISTS idx_codes_user   ON codes(redeemed_by);

-- 兑换必须原子化，否则同一个码并发提交两次会各抽走一组卡。
-- 用 status='unused' 做乐观锁，changes()=0 即表示已被抢先兑换：
--   UPDATE codes SET status='redeemed', redeemed_by=?1, redeemed_at=?2
--    WHERE code_hash=?3 AND status='unused';

CREATE TABLE IF NOT EXISTS redeem_attempts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT,
  ip_hash     TEXT NOT NULL,
  ok          INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_attempts_ip ON redeem_attempts(ip_hash, created_at);

-- ─────────────────────────── 藏卡 ───────────────────────────

-- 不预先物化 23 万行编号；抽到时才 issued+1 拿号，省一个数量级的写入。
CREATE TABLE IF NOT EXISTS user_cards (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT NOT NULL REFERENCES users(id),
  design_id   TEXT NOT NULL REFERENCES card_designs(id),
  serial_no   INTEGER NOT NULL,           -- 该设计内的第几号，#017/192
  code_serial TEXT REFERENCES codes(serial),
  obtained_at INTEGER NOT NULL,
  UNIQUE (design_id, serial_no)           -- 同一编号全世界只能有一个持有者
);

CREATE INDEX IF NOT EXISTS idx_user_cards_user ON user_cards(user_id, obtained_at DESC);

-- 抽到已拥有的设计时不再发新卡，转成对该女優的羁绊值。
-- 注意：羁绊只解锁记忆深度/称呼/剧情，不发消息条数 —— 那是订阅的付费墙。
CREATE TABLE IF NOT EXISTS bonds (
  user_id     TEXT NOT NULL REFERENCES users(id),
  actor_id    TEXT NOT NULL REFERENCES actors(id),
  points      INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, actor_id)
);

-- 每一抽都留痕，用于概率公示的可审计性与客诉排查
CREATE TABLE IF NOT EXISTS draws (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  code_serial  TEXT NOT NULL REFERENCES codes(serial),
  user_id      TEXT NOT NULL REFERENCES users(id),
  slot         INTEGER NOT NULL,          -- 一码 6 抽里的第几抽
  design_id    TEXT NOT NULL REFERENCES card_designs(id),
  serial_no    INTEGER,                   -- 重复卡转羁绊时为 NULL
  was_duplicate INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  UNIQUE (code_serial, slot)
);
