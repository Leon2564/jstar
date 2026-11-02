-- Admin moderation queue (#14) reads blocked chats by action.
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit(action, n);
