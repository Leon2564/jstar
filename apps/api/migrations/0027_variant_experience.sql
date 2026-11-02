-- The variant-card experience (#76, docs/requirements.md §14.1).
-- 1. Her home may keep her variant look (from variant level 10, VARIANT_RULES.homePinLevel): one flag per user and
--    variant card, which is also per talent (one variant each). Mirrors CardAffectionRow.homePinned.
-- 2. The draw-night invite (src/jobs/variantInvites.ts) looks up the variant cards first owned since the night began,
--    every tick: an index on (card_id, first_owned_at) keeps that off a full scan of `owned`.
ALTER TABLE card_affection ADD COLUMN home_pinned INTEGER NOT NULL DEFAULT 0;
CREATE INDEX owned_card_first ON owned (card_id, first_owned_at);
