-- Review stage (STAGE=review, nest.jstarcards.ai): no demo data. A site that ran in demo mode before keeps the demo
-- lucky codes (printed in the repo, packages/shared DEMO_SERIALS) and the seeded demo admin in its database; both are
-- closed here, as 0005_end_demo.sql did for production. Applied by deploy.sh to Nest's database only, after the
-- migrations, on every deploy (idempotent). Not a migration: the demo sites (test, v1) need their demo codes.
UPDATE serials SET redeemed_at = '2026-09-28T00:00:00.000Z', redeemed_by_device = 'void'
  WHERE batch_id IN ('demo', 'smoketest') AND redeemed_at IS NULL;
UPDATE users SET role = 'user', banned = 1 WHERE email = 'admin@jstar.demo';
