import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../server/db.js";
import { Agent } from "../server/agent.js";
import { Runner } from "../server/runner.js";
import { UsageMeter, estimateCostUsd } from "../server/usage.js";
import { createApp, LoginGuard } from "../server/app.js";

const toolUse = (id, name, input, usage) => ({ stop_reason: "tool_use", content: [{ type: "tool_use", id, name, input }], usage });

function setup(responses, configOverrides = {}, meterOpts = null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "task-pilot-"));
  const store = new Store(dir);
  const sent = [];
  const notifier = { send: async (m) => sent.push(m), vapidPublicKey: "test" };
  const config = { model: "claude-opus-5", effort: "high", enableWebTools: false, webhooks: {}, agentEnabled: true, ...configOverrides };
  const requests = [];
  const client = { beta: { messages: { create: async (p) => (requests.push(structuredClone(p)), responses.shift()) } } };
  const fetched = [];
  const fetchImpl = async (url, init) => (fetched.push({ url, body: init.body }), new Response("ok", { status: 200 }));
  const meter = meterOpts ? new UsageMeter({ store, ...meterOpts }) : null;
  const agent = new Agent({ config, client, notifier, meter, fetchImpl });
  const runner = new Runner({ store, agent, notifier, log: { error() {} } });
  return { store, runner, sent, requests, fetched, config, agent, notifier, meter, dir };
}

test("webhooks run only after the user taps Allow", async () => {
  const ctx = setup(
    [toolUse("w1", "call_webhook", { name: "share", payload: { to: "sam" } }), toolUse("c1", "complete_step", { summary: "Shared" })],
    { webhooks: { share: "https://hooks.example/abc" }, webhooksRequireApproval: true },
  );
  const task = ctx.store.createTask({ title: "Share list", activities: [{ title: "Share", executor: "agent" }] });
  ctx.runner.approve(task.id);
  await ctx.runner.process(task.id);
  let t = ctx.store.getTask(task.id);
  assert.equal(t.status, "waiting_on_you");
  assert.equal(t.activities[0].agent.pending.kind, "action");
  assert.equal(ctx.fetched.length, 0, "webhook must not fire before approval");
  assert.match(ctx.sent.at(-1).title, /Allow action/);
  assert.match(ctx.sent.at(-1).body, /"to": "sam"/);

  await ctx.runner.resolveAction(task.id, t.activities[0].id, true);
  await ctx.runner.process(task.id);
  assert.equal(ctx.fetched.length, 1);
  assert.equal(ctx.fetched[0].url, "https://hooks.example/abc");
  assert.equal(ctx.store.getTask(task.id).status, "done");
});

test("declined actions never run and the agent is told", async () => {
  const ctx = setup(
    [toolUse("w1", "call_webhook", { name: "share" }), toolUse("c1", "complete_step", { summary: "Skipped sharing" })],
    { webhooks: { share: "https://hooks.example/abc" } },
  );
  const task = ctx.store.createTask({ title: "Share", activities: [{ title: "Share", executor: "agent" }] });
  ctx.runner.approve(task.id);
  await ctx.runner.process(task.id);
  await ctx.runner.resolveAction(task.id, task.activities[0].id, false);
  await ctx.runner.process(task.id);
  assert.equal(ctx.fetched.length, 0);
  const reply = ctx.requests[1].messages.at(-1).content[0];
  assert.equal(reply.is_error, true);
  assert.match(reply.content, /declined/);
});

test("two pausing tool calls in one turn both get a tool_result", async () => {
  const ctx = setup([
    { stop_reason: "tool_use", content: [
      { type: "tool_use", id: "q1", name: "ask_user", input: { question: "A?" } },
      { type: "tool_use", id: "q2", name: "ask_user", input: { question: "B?" } },
    ] },
    toolUse("c", "complete_step", { summary: "ok" }),
  ]);
  const task = ctx.store.createTask({ title: "Q", activities: [{ title: "Ask", executor: "agent" }] });
  ctx.runner.approve(task.id);
  await ctx.runner.process(task.id);
  ctx.runner.answer(task.id, task.activities[0].id, "yes");
  await ctx.runner.process(task.id);
  const ids = ctx.requests[1].messages.at(-1).content.map((b) => b.tool_use_id).sort();
  assert.deepEqual(ids, ["q1", "q2"]);
});

test("spend caps stop the agent before it spends more", async () => {
  const usage = { input_tokens: 200_000, output_tokens: 20_000 }; // ≈ $1.50 on claude-opus-5
  assert.ok(Math.abs(estimateCostUsd("claude-opus-5", usage) - 1.5) < 1e-9);
  const ctx = setup(
    [toolUse("n1", "notify_user", { message: "hi" }, usage), toolUse("n2", "notify_user", { message: "hi" }, usage)],
    {},
    { monthlyBudgetUsd: 100, taskBudgetUsd: 1 },
  );
  const task = ctx.store.createTask({ title: "Expensive", activities: [{ title: "Loop", executor: "agent" }] });
  ctx.runner.approve(task.id);
  await ctx.runner.process(task.id);
  const t = ctx.store.getTask(task.id);
  assert.equal(ctx.requests.length, 1, "second request blocked by the per-task cap");
  assert.equal(t.status, "failed");
  assert.match(t.log.at(-1).message, /limit/);
  assert.ok(ctx.meter.summary().usd > 1.4);
});

test("private tasks are never sent to Claude", async () => {
  const ctx = setup([]);
  const task = ctx.store.createTask({ title: "Bank PIN change", private: true, activities: [{ title: "x", executor: "agent" }] });
  await assert.rejects(ctx.runner.plan(task.id), /private/);
  assert.throws(() => ctx.runner.approve(task.id), /Private/);
  assert.equal(ctx.requests.length, 0);
});

test("oversized or malformed input is rejected", () => {
  const ctx = setup([]);
  assert.throws(() => ctx.store.createTask({ title: "x".repeat(201) }), /title/);
  assert.throws(() => ctx.store.createTask({ title: "ok", priority: "urgent!!" }), /priority/);
  assert.throws(() => ctx.store.createTask({ title: "ok", activities: Array(51).fill({ title: "a" }) }), /50/);
  assert.throws(() => ctx.store.createTask({ title: "ok", dueDate: "not a date" }), /dueDate/);
});

test("login guard locks out an IP after repeated failures", () => {
  let t = 0;
  const locked = [];
  const g = new LoginGuard({ maxPerIp: 3, maxGlobal: 50, windowMs: 1000, now: () => t, onLockout: (ip) => locked.push(ip) });
  g.fail("1.2.3.4");
  g.fail("1.2.3.4");
  assert.equal(g.blockedFor("1.2.3.4"), 0);
  g.fail("1.2.3.4");
  assert.ok(g.blockedFor("1.2.3.4") > 0);
  assert.equal(g.blockedFor("5.6.7.8"), 0);
  assert.deepEqual(locked, ["1.2.3.4"]);
  t = 1001;
  assert.equal(g.blockedFor("1.2.3.4"), 0, "lock expires");
});

test("HTTP: security headers, lockout, no token in URLs, no transcript leak", async () => {
  const ctx = setup([]);
  const app = createApp({ ...ctx, config: { ...ctx.config, root: path.resolve("."), appToken: "a-very-long-secret-token-123" } });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const auth = { authorization: "Bearer a-very-long-secret-token-123" };
  try {
    const home = await fetch(`${base}/`);
    assert.match(home.headers.get("content-security-policy"), /script-src 'self'/);
    assert.equal(home.headers.get("x-frame-options"), "DENY");
    assert.equal(home.headers.get("x-powered-by"), null);

    assert.equal((await fetch(`${base}/api/tasks?token=a-very-long-secret-token-123`)).status, 401, "query-string tokens are not accepted");

    const task = ctx.store.createTask({ title: "T", activities: [{ title: "s", executor: "agent" }] });
    task.activities[0].agent = { messages: [{ role: "user", content: "secret transcript" }], pending: { kind: "question", question: "Q?" } };
    const body = await (await fetch(`${base}/api/tasks/${task.id}`, { headers: auth })).json();
    assert.equal(body.activities[0].agent, undefined);
    assert.equal(body.activities[0].question, "Q?");

    const bad = await fetch(`${base}/api/tasks`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: "{not json" });
    assert.equal(bad.status, 400);
    assert.doesNotMatch(await bad.text(), /at \//, "no stack traces");

    for (let i = 0; i < 10; i++) await fetch(`${base}/api/tasks`, { headers: { authorization: "Bearer wrong" } });
    const blocked = await fetch(`${base}/api/tasks`, { headers: auth });
    assert.equal(blocked.status, 429, "even the right token is refused while the IP is locked out");
    assert.match(ctx.sent.at(-1).body, /Repeated wrong app tokens/);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
