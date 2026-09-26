// HTTP API + static PWA. Every /api route except /api/health needs the app token.
import crypto from "node:crypto";
import path from "node:path";
import express from "express";
import { TASK_STATUSES } from "./db.js";

export function createApp({ config, store, runner, notifier, agent, meter }) {
  const app = express();
  app.disable("x-powered-by");
  if (config.trustProxy) app.set("trust proxy", config.trustProxy);

  app.use(securityHeaders);
  app.use(express.json({ limit: "200kb" }));
  app.use(express.static(path.join(config.root, "public"), { extensions: ["html"] }));

  app.get("/api/health", (req, res) => res.json({ ok: true }));

  // ---- auth: bearer token + lockout after repeated wrong guesses
  const expected = crypto.createHash("sha256").update(config.appToken).digest();
  const guard = new LoginGuard({
    onLockout: (ip) =>
      notifier.send({ title: "Task Pilot security", body: `Repeated wrong app tokens from ${ip}. That address is blocked for 15 minutes.`, urgent: true }),
  });
  app.use("/api", (req, res, next) => {
    const ip = req.ip ?? "unknown";
    const wait = guard.blockedFor(ip);
    if (wait) {
      res.set("retry-after", String(Math.ceil(wait / 1000)));
      return res.status(429).json({ error: "Too many failed sign-in attempts. Try again later." });
    }
    const header = req.get("authorization") ?? "";
    // Compare fixed-length hashes so neither length nor content leaks through timing.
    const given = crypto.createHash("sha256").update(header.startsWith("Bearer ") ? header.slice(7) : "").digest();
    if (crypto.timingSafeEqual(given, expected)) return next();
    guard.fail(ip);
    res.status(401).json({ error: "Invalid or missing app token" });
  });

  const wrap = (fn) => async (req, res) => {
    try {
      const out = await fn(req, res);
      if (!res.headersSent) res.json(out ?? { ok: true });
    } catch (err) {
      res.status(err.status ?? 400).json({ error: err.message });
    }
  };
  // Never expose the agent transcript; the phone only needs what's pending.
  const view = (task) => ({
    ...task,
    activities: task.activities.map(({ agent, ...a }) => ({
      ...a,
      question: agent?.pending?.question ?? null,
      pendingKind: agent?.pending?.kind ?? null,
    })),
  });
  const found = (task) => {
    if (!task) throw Object.assign(new Error("Task not found"), { status: 404 });
    return view(task);
  };

  app.get("/api/config", (req, res) =>
    res.json({
      agentEnabled: agent.enabled,
      model: config.model,
      webTools: config.enableWebTools,
      webhooks: Object.keys(config.webhooks),
      ntfyTopic: config.ntfyTopic || null,
      ntfyServer: config.ntfyServer,
      vapidPublicKey: notifier.vapidPublicKey,
      webhooksRequireApproval: config.webhooksRequireApproval,
      alertDetails: config.alertDetails,
      usage: meter?.summary() ?? null,
    }),
  );

  // ---- tasks
  app.get("/api/tasks", wrap(() => store.listTasks().map(view)));
  app.get("/api/tasks/:id", wrap((req) => found(store.getTask(req.params.id))));

  app.post(
    "/api/tasks",
    wrap(async (req) => {
      const task = store.createTask(req.body ?? {});
      if (req.body?.autoPlan) runner.plan(task.id).catch(() => {}); // result shows up in the task log
      return view(task);
    }),
  );

  app.patch(
    "/api/tasks/:id",
    wrap((req) => {
      if (req.body?.status && !TASK_STATUSES.includes(req.body.status)) throw new Error("Unknown status");
      return found(store.updateTask(req.params.id, req.body ?? {}));
    }),
  );

  app.delete(
    "/api/tasks/:id",
    wrap((req) => {
      if (!store.deleteTask(req.params.id)) throw Object.assign(new Error("Task not found"), { status: 404 });
    }),
  );

  app.post(
    "/api/tasks/:id/plan",
    wrap((req) => {
      const task = found(store.getTask(req.params.id));
      runner.plan(task.id).catch(() => {});
      return view(store.getTask(task.id));
    }),
  );
  app.post("/api/tasks/:id/approve", wrap((req) => view(runner.approve(req.params.id))));
  app.post("/api/tasks/:id/cancel", wrap((req) => view(runner.cancel(req.params.id))));
  app.post("/api/tasks/:id/retry", wrap((req) => view(runner.retry(req.params.id))));

  // ---- activities
  const act = (fn) => wrap((req) => view(fn(req.params.id, req.params.aid, req.body ?? {})));
  app.post("/api/tasks/:id/activities/:aid/complete", act((t, a, b) => runner.completeActivity(t, a, b.note)));
  app.post("/api/tasks/:id/activities/:aid/reopen", act((t, a) => runner.reopenActivity(t, a)));
  app.post("/api/tasks/:id/activities/:aid/skip", act((t, a) => runner.skipActivity(t, a)));
  app.post("/api/tasks/:id/activities/:aid/approve", act((t, a) => runner.approveActivity(t, a)));
  app.post(
    "/api/tasks/:id/activities/:aid/action",
    wrap(async (req) => view(await runner.resolveAction(req.params.id, req.params.aid, req.body?.approve === true))),
  );
  app.post(
    "/api/tasks/:id/activities/:aid/answer",
    act((t, a, b) => {
      if (typeof b.answer !== "string" || !b.answer.trim()) throw new Error("Answer is empty");
      if (b.answer.length > 5000) throw new Error("Answer is too long");
      return runner.answer(t, a, b.answer.trim());
    }),
  );

  // ---- push
  app.post(
    "/api/push/subscribe",
    wrap((req) => {
      const { endpoint, keys } = req.body ?? {};
      if (typeof endpoint !== "string" || !/^https:\/\//.test(endpoint) || typeof keys?.p256dh !== "string" || typeof keys?.auth !== "string") {
        throw new Error("Invalid subscription");
      }
      if (store.data.subscriptions.length >= 20) throw new Error("Too many devices subscribed");
      store.addSubscription({ endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } });
    }),
  );
  app.post(
    "/api/push/test",
    wrap(async () => {
      await notifier.send({ title: "Task Pilot", body: "Notifications are working 🎉" });
    }),
  );

  // ---- live updates (Server-Sent Events)
  app.get("/api/events", (req, res) => {
    res.set({ "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    res.flushHeaders();
    let pending = false;
    const off = store.onChange(() => {
      if (pending) return;
      pending = true;
      setTimeout(() => {
        pending = false;
        res.write(`event: change\ndata: ${Date.now()}\n\n`);
      }, 250);
    });
    const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
    req.on("close", () => {
      off();
      clearInterval(ping);
    });
  });

  // Malformed JSON and anything unexpected: short JSON error, no stack traces.
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    res.status(err.status ?? 500).json({ error: err.status && err.status < 500 ? "Bad request" : "Server error" });
  });

  return app;
}

function securityHeaders(req, res, next) {
  res.set({
    // Only our own scripts/styles; no inline scripts, no framing, no plugins.
    "content-security-policy":
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; " +
      "object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=()",
    "cross-origin-opener-policy": "same-origin",
  });
  if (req.secure) res.set("strict-transport-security", "max-age=31536000");
  if (req.path.startsWith("/api/")) res.set("cache-control", "no-store");
  next();
}

/** Per-IP lockout, plus a global ceiling so spreading guesses over many IPs doesn't help. */
export class LoginGuard {
  constructor({ maxPerIp = 10, maxGlobal = 100, windowMs = 15 * 60_000, onLockout = () => {}, now = Date.now } = {}) {
    Object.assign(this, { maxPerIp, maxGlobal, windowMs, onLockout, now });
    this.failures = new Map(); // ip -> timestamps
    this.global = [];
  }

  #recent(list) {
    const cutoff = this.now() - this.windowMs;
    while (list.length && list[0] < cutoff) list.shift();
    return list;
  }

  blockedFor(ip) {
    const global = this.#recent(this.global);
    const mine = this.#recent(this.failures.get(ip) ?? []);
    const over = mine.length >= this.maxPerIp ? mine : global.length >= this.maxGlobal ? global : null;
    return over ? over[0] + this.windowMs - this.now() : 0;
  }

  fail(ip) {
    const list = this.failures.get(ip) ?? [];
    list.push(this.now());
    this.failures.set(ip, list);
    this.global.push(this.now());
    if (list.length === this.maxPerIp) Promise.resolve(this.onLockout(ip)).catch(() => {});
    if (this.failures.size > 10_000) this.failures.clear(); // bound memory under a flood
  }
}
