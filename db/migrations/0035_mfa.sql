-- 0035_mfa: two-step sign-in with an authenticator app (TOTP, RFC 6238) for any user who turns it on (M8).
--   * The shared secret is stored sealed (AES-256-GCM in the server); recovery codes as SHA-256 hashes.
--   * A session opened by the password alone is "pending" until the code is verified: it can only verify,
--     read /auth/me, or sign out (plugins/auth.ts). The last accepted time step blocks replaying a code.
ALTER TABLE users ADD COLUMN mfa_secret_enc text;
ALTER TABLE users ADD COLUMN mfa_pending_secret_enc text;
ALTER TABLE users ADD COLUMN mfa_enabled_at timestamptz;
ALTER TABLE users ADD COLUMN mfa_last_step bigint;
ALTER TABLE users ADD COLUMN mfa_recovery_hashes text[] NOT NULL DEFAULT '{}';
ALTER TABLE users ADD CONSTRAINT users_mfa_check CHECK (mfa_enabled_at IS NULL OR mfa_secret_enc IS NOT NULL);
ALTER TABLE sessions ADD COLUMN mfa_verified_at timestamptz;
