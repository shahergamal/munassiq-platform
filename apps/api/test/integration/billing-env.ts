// Imported first by billing-ops.test.ts (each test file runs in its own process): turns on the features whose
// configuration comes from the environment, pointed at the test stand-ins.
process.env["PLATFORM_MOYASAR_SECRET_KEY"] = "sk_test_platformKey12345678";
process.env["CLOUDFLARE_API_TOKEN"] = "cf-test-token-0123456789abcdef";
process.env["CLOUDFLARE_ZONE_ID"] = "0123456789abcdef0123456789abcdef";
process.env["DEPLOY_HOOK_URL"] = "https://deploy.example.test/api/v1/deploy?uuid=abc";
process.env["DEPLOY_HOOK_TOKEN"] = "deploy-token-123";
process.env["SERVER_RESTART_ENABLED"] = "false";
