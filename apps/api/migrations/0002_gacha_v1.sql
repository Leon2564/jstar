-- v1.0: Star Genesis catalog (150 cards, 5 tiers), pity and shards, daily login and monthly check-in, birthday.
ALTER TABLE users ADD COLUMN pity INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN shards INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN last_draw_id TEXT;
ALTER TABLE users ADD COLUMN login_day TEXT;
ALTER TABLE users ADD COLUMN check_month TEXT;
ALTER TABLE users ADD COLUMN check_days INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN check_claimed TEXT NOT NULL DEFAULT '[]';
ALTER TABLE users ADD COLUMN birthday TEXT;
ALTER TABLE users ADD COLUMN deleted_at TEXT;

-- The 30 placeholder cards of the demo are replaced by the catalog (seeded at boot); drop them and their copies.
DELETE FROM owned WHERE card_id NOT LIKE 's1-%';
DELETE FROM cards WHERE id NOT LIKE 's1-%';
DELETE FROM pools;
