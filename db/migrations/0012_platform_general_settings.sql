-- Platform-wide defaults the admin edits. Each value has a reader in code (lib/tenancy.ts):
-- trial length and the tax / discount defaults written into every NEW workspace. Existing workspaces are untouched.
ALTER TABLE platform_settings DROP CONSTRAINT platform_settings_key_check;
ALTER TABLE platform_settings ADD CONSTRAINT platform_settings_key_check CHECK (key IN ('landing_content', 'general'));
