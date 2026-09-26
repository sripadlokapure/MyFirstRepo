// HTTP API + static PWA. Every /api route except /api/health needs the app token.
import crypto from "node:crypto";
import path from "node:path";
import express from "express";
import { TASK_STATUSES } from "./db.js";

export function createApp({ config, store, runner, notifier, agent }) {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use(express.static(path.join(config.root, "public"), { extensions: ["html"] }));

  app.get("/api/health", (req, res) => res.json({ ok: true }));

  const expected = Buffer.from(config.appToken);
  app.use("/api", (req, res, next) => {
    const header = req.get("authorization") ?? "";
    // EventSource can't send headers, so the live-update stream uses ?token=.
    const given = Buffer.from(header.startsWith("Bearer ") ? header.slice(7) : String(req.query.token ?? ""));
    if (given.length === expected.length && crypto.timingSafeEqual(given, expected)) return next();
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
  const view = (task) => ({ ...task, activities: task.activities.map(({ agent, ...a }) => ({ ...a, question: agent?.pendingQuestion?.question ?? null })) });
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
    "/api/tasks/:id/activities/:aid/answer",
    act((t, a, b) => {
      if (!b.answer?.trim()) throw new Error("Answer is empty");
      return runner.answer(t, a, b.answer.trim());
    }),
  );

  // ---- push
  app.post(
    "/api/push/subscribe",
    wrap((req) => {
      if (!req.body?.endpoint) throw new Error("Invalid subscription");
      store.addSubscription(req.body);
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

  return app;
}
