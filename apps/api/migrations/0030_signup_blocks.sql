-- M7 (v1.1.1 member acceptance): an account closed under 18 may not sign up again with the same address for a while.
-- Only a keyed hash of the address is kept (HMAC-SHA256 with the server's secret; the address itself is erased with
-- the account), with the time until which a sign-up is refused. docs/compliance-jp.md: minors.
CREATE TABLE signup_blocks (
  email_hash TEXT PRIMARY KEY,
  until      TEXT NOT NULL
);
