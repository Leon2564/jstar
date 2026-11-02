-- Production mode (DEMO_MODE off): the demo lucky codes are printed in the repo, so they are voided (marked used by
-- nobody, like an admin void), and the seeded demo admin is closed. Real admins come from ADMIN_EMAILS.
UPDATE serials SET redeemed_at = '2026-09-26T00:00:00.000Z', redeemed_by_device = 'void'
  WHERE batch_id IN ('demo', 'smoketest') AND redeemed_at IS NULL;
UPDATE users SET role = 'user', banned = 1 WHERE email = 'admin@jstar.demo';
