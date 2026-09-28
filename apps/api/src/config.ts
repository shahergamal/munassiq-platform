import { z } from "zod";

const schema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().default(4000),
    HOST: z.string().default("0.0.0.0"),
    DATABASE_URL: z.string().min(1),
    SYSTEM_DATABASE_URL: z.string().min(1),
    MIGRATE_DATABASE_URL: z.string().optional(),
    SESSION_SECRET: z.string().min(32, "SESSION_SECRET must be at least 32 characters"),
    APP_URL: z.string().url().default("http://localhost:5173"),
    COOKIE_SECURE: z.enum(["true", "false"]).default("true"),
    SMTP_URL: z.string().optional(),
    MAIL_FROM: z.string().default("no-reply@localhost"),
    // AI assistant. Without a key the assistant reports "not configured"; everything else runs normally.
    ANTHROPIC_API_KEY: z.string().optional(),
    ASSISTANT_MODEL: z.string().default("claude-opus-5"),
    ASSISTANT_DAILY_TURNS: z.coerce.number().int().min(1).max(10_000).default(50),
    // Encrypts each workspace's integration secrets at rest: the e-invoicing device key and ZATCA secrets, and the
    // payment gateway keys (falls back to SESSION_SECRET).
    // Requests per minute from one IP address, for every route (auth routes have their own lower limits). An office
    // behind one public IP shares it: raise it for larger teams (e.g. 3000), never remove it.
    // Platform admins must turn on two-step sign-in before using the admin panel or a support session.
    // Default: required in production, not in development and tests.
    ADMIN_MFA_REQUIRED: z.enum(["true", "false"]).optional(),
    RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(30).max(1_000_000).default(300),
    ZATCA_KEY_SECRET: z.string().min(32, "ZATCA_KEY_SECRET must be at least 32 characters").optional(),
    // Platform billing: the PLATFORM's own Moyasar secret key (workspaces pay their subscription and storage to it).
    PLATFORM_MOYASAR_SECRET_KEY: z.string().regex(/^sk_(test|live)_[A-Za-z0-9]{8,120}$/, "PLATFORM_MOYASAR_SECRET_KEY must be a Moyasar secret key (sk_test_/sk_live_)").optional(),
    // Operations screen (admin). Each feature is off until its variables are set.
    CLOUDFLARE_API_TOKEN: z.string().min(20).optional(),
    CLOUDFLARE_ZONE_ID: z.string().regex(/^[a-f0-9]{32}$/, "CLOUDFLARE_ZONE_ID is the 32-character zone id").optional(),
    // "Deploy update": the deploy webhook of the hosting platform (Coolify, Railway, Render…), optional bearer token.
    DEPLOY_HOOK_URL: z.string().url().refine((u) => u.startsWith("https://"), "DEPLOY_HOOK_URL must be https").optional(),
    DEPLOY_HOOK_TOKEN: z.string().min(8).optional(),
    // Only when a supervisor (Docker restart policy, PM2, systemd, the hosting platform) starts the server again.
    SERVER_RESTART_ENABLED: z.enum(["true", "false"]).default("false"),
    // Shown on the operations screen; hosting platforms set one of these to the deployed commit.
    SOURCE_COMMIT: z.string().max(80).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.NODE_ENV === "production") {
      if (v.COOKIE_SECURE !== "true") ctx.addIssue({ code: "custom", message: "COOKIE_SECURE must be true in production" });
      if (!v.APP_URL.startsWith("https://")) ctx.addIssue({ code: "custom", message: "APP_URL must be https in production" });
      if (!v.SMTP_URL) ctx.addIssue({ code: "custom", message: "SMTP_URL is required in production" });
      if (/replace-with|change-me/.test(v.SESSION_SECRET + v.DATABASE_URL + v.SYSTEM_DATABASE_URL))
        ctx.addIssue({ code: "custom", message: "placeholder secrets detected" });
    }
  });

// An empty variable (FOO= in .env, or ${FOO:-} in docker compose) means "not set".
const parsed = schema.safeParse(Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== "")));
if (!parsed.success) {
  console.error("Invalid environment configuration:");
  for (const issue of parsed.error.issues) console.error(` - ${issue.path.join(".") || "env"}: ${issue.message}`);
  process.exit(1);
}

export const config = {
  ...parsed.data,
  isProd: parsed.data.NODE_ENV === "production",
  cookieSecure: parsed.data.COOKIE_SECURE === "true",
  appOrigin: new URL(parsed.data.APP_URL).origin,
};
