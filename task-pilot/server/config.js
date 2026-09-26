import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Minimal .env loader so there's no extra dependency. Real env vars win.
// Within the file, the last non-empty value for a key wins (so adding a line
// at the bottom works even if the example left an empty one above).
function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  const values = {};
  for (const line of fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=(.*)$/);
    if (!m || line.trim().startsWith("#")) continue;
    const value = m[2].trim().replace(/^(['"])(.*)\1$/, "$2");
    if (value !== "" || !(m[1] in values)) values[m[1]] = value;
  }
  for (const [key, value] of Object.entries(values)) {
    if (!(key in process.env)) process.env[key] = value;
  }
}

export function loadConfig(env = process.env) {
  loadDotEnv(path.join(root, ".env"));
  const dataDir = path.resolve(root, env.DATA_DIR || "data");
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });

  const appToken = env.APP_TOKEN || loadOrCreateToken(dataDir);
  if (appToken.length < MIN_TOKEN_LENGTH) {
    throw new Error(`APP_TOKEN must be at least ${MIN_TOKEN_LENGTH} characters. Leave it empty to have a strong one generated.`);
  }
  const list = (v) => (v || "").split(",").map((d) => d.trim()).filter(Boolean);
  const money = (v, fallback) => (v === undefined || v === "" ? fallback : Math.max(0, Number(v) || 0));

  let webhooks = {};
  if (env.WEBHOOKS) {
    try {
      webhooks = JSON.parse(env.WEBHOOKS);
    } catch {
      console.warn("[config] WEBHOOKS is not valid JSON; ignoring it.");
    }
  }

  return {
    root,
    dataDir,
    port: Number(env.PORT || 3000),
    // Localhost only by default: reach it through Tailscale/cloudflared, not an open port.
    host: env.HOST || "127.0.0.1",
    // Set when behind a reverse proxy so rate limiting sees real client IPs (e.g. "loopback" or 1).
    trustProxy: env.TRUST_PROXY || false,
    publicUrl: (env.PUBLIC_URL || "").replace(/\/$/, ""),
    appToken,
    agentEnabled: Boolean(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN),
    model: env.CLAUDE_MODEL || "claude-opus-5",
    effort: env.CLAUDE_EFFORT || "high",
    enableWebTools: env.ENABLE_WEB_TOOLS !== "false",
    webAllowedDomains: list(env.WEB_ALLOWED_DOMAINS),
    webBlockedDomains: list(env.WEB_BLOCKED_DOMAINS),
    webhooks,
    webhooksRequireApproval: env.WEBHOOKS_REQUIRE_APPROVAL !== "false",
    // 0 means no cap. Estimates from list prices; also set a limit in the Anthropic Console.
    monthlyBudgetUsd: money(env.MONTHLY_BUDGET_USD, 10),
    taskBudgetUsd: money(env.TASK_BUDGET_USD, 2),
    // false = alerts say only "a task needs you", no task details leave the server.
    alertDetails: env.ALERT_DETAILS !== "false",
    ntfyToken: env.NTFY_TOKEN || "",
    ntfyTopic: env.NTFY_TOPIC || "",
    ntfyServer: env.NTFY_SERVER || "https://ntfy.sh",
    vapidSubject: env.VAPID_SUBJECT || "",
  };
}

const MIN_TOKEN_LENGTH = 20;

function loadOrCreateToken(dataDir) {
  const file = path.join(dataDir, "app-token.txt");
  if (fs.existsSync(file)) return fs.readFileSync(file, "utf8").trim();
  const token = crypto.randomBytes(32).toString("base64url");
  fs.writeFileSync(file, token, { mode: 0o600 });
  return token;
}
