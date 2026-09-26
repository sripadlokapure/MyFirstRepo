import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Minimal .env loader so there's no extra dependency. Real env vars win.
function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith("#")) continue;
    const value = m[2].replace(/^(['"])(.*)\1$/, "$2");
    if (!(m[1] in process.env)) process.env[m[1]] = value;
  }
}

export function loadConfig(env = process.env) {
  loadDotEnv(path.join(root, ".env"));
  const dataDir = path.resolve(root, env.DATA_DIR || "data");
  fs.mkdirSync(dataDir, { recursive: true });

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
    publicUrl: (env.PUBLIC_URL || "").replace(/\/$/, ""),
    appToken: env.APP_TOKEN || loadOrCreateToken(dataDir),
    agentEnabled: Boolean(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN),
    model: env.CLAUDE_MODEL || "claude-opus-5",
    effort: env.CLAUDE_EFFORT || "high",
    enableWebTools: env.ENABLE_WEB_TOOLS !== "false",
    webhooks,
    ntfyTopic: env.NTFY_TOPIC || "",
    ntfyServer: env.NTFY_SERVER || "https://ntfy.sh",
    vapidSubject: env.VAPID_SUBJECT || "",
  };
}

function loadOrCreateToken(dataDir) {
  const file = path.join(dataDir, "app-token.txt");
  if (fs.existsSync(file)) return fs.readFileSync(file, "utf8").trim();
  const token = crypto.randomBytes(18).toString("base64url");
  fs.writeFileSync(file, token, { mode: 0o600 });
  return token;
}
