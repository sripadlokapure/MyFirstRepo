import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../server/db.js";
import { Agent } from "../server/agent.js";
import { Runner } from "../server/runner.js";
import { createApp } from "../server/app.js";

// Fake Claude client: returns scripted responses in order and records requests.
function fakeClient(responses) {
  const requests = [];
  return {
    requests,
    beta: {
      messages: {
        create: async (params) => {
          requests.push(structuredClone(params));
          const next = responses.shift();
          if (!next) throw new Error("No more scripted responses");
          return next;
        },
      },
    },
  };
}
const toolUse = (id, name, input) => ({ stop_reason: "tool_use", content: [{ type: "tool_use", id, name, input }] });

function setup(responses) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "task-pilot-"));
  const store = new Store(dir);
  const sent = [];
  const notifier = { send: async (m) => sent.push(m), vapidPublicKey: "test" };
  const config = { model: "claude-opus-5", effort: "high", enableWebTools: false, webhooks: {}, agentEnabled: true };
  const client = fakeClient(responses);
  const agent = new Agent({ config, client, notifier });
  const runner = new Runner({ store, agent, notifier, log: { error() {} } });
  return { store, runner, sent, client, config, agent, notifier, dir };
}

test("plan -> approve -> question -> answer -> human step -> done", async () => {
  const plan = {
    summary: "Research then book.",
    activities: [
      { title: "Research options", instructions: "Find 3", executor: "agent", needsApproval: false, dueDate: "" },
      { title: "Book it", instructions: "Pay on site", executor: "human", needsApproval: false, dueDate: "" },
    ],
  };
  const { store, runner, sent, client } = setup([
    { stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(plan) }] },
    toolUse("t1", "ask_user", { question: "Budget?" }),
    toolUse("t2", "complete_step", { summary: "Found A, B, C" }),
  ]);

  const task = store.createTask({ title: "Trip", instructions: "Plan a trip" });
  await runner.plan(task.id);
  assert.equal(store.getTask(task.id).status, "pending_approval");
  assert.equal(store.getTask(task.id).activities.length, 2);
  assert.match(sent.at(-1).title, /Approve plan/);
  assert.equal(client.requests[0].output_config.format.type, "json_schema");

  runner.approve(task.id);
  await runner.process(task.id);
  let t = store.getTask(task.id);
  assert.equal(t.status, "waiting_on_you");
  assert.equal(t.activities[0].agent.pending.question, "Budget?");
  assert.match(sent.at(-1).body, /Budget\?/);

  runner.answer(task.id, t.activities[0].id, "Under 5000");
  await runner.process(task.id);
  t = store.getTask(task.id);
  assert.equal(t.activities[0].status, "done");
  assert.equal(t.activities[0].result, "Found A, B, C");
  // The answer went back as the tool_result for the ask_user call.
  const resumed = client.requests[2].messages.at(-1).content[0];
  assert.equal(resumed.tool_use_id, "t1");
  assert.match(resumed.content, /Under 5000/);
  // Human step now waits on the user.
  assert.equal(t.status, "waiting_on_you");
  assert.equal(t.activities[1].status, "waiting_on_you");
  assert.match(sent.at(-1).title, /Your turn/);

  runner.completeActivity(task.id, t.activities[1].id, "Booked");
  await runner.process(task.id);
  assert.equal(store.getTask(task.id).status, "done");
  assert.match(sent.at(-1).title, /^Done/);
});

test("steps marked needsApproval wait for a second OK", async () => {
  const { store, runner, sent, client } = setup([toolUse("x", "complete_step", { summary: "Sent" })]);
  const task = store.createTask({
    title: "Email landlord",
    activities: [{ title: "Send email", executor: "agent", needsApproval: true }],
  });
  runner.approve(task.id);
  await runner.process(task.id);
  assert.equal(store.getTask(task.id).status, "waiting_on_you");
  assert.equal(client.requests.length, 0, "agent must not run before step approval");
  assert.match(sent.at(-1).title, /Approve step/);

  runner.approveActivity(task.id, task.activities[0].id);
  await runner.process(task.id);
  assert.equal(store.getTask(task.id).status, "done");
});

test("fail_step marks the task failed and alerts", async () => {
  const { store, runner, sent } = setup([toolUse("f", "fail_step", { reason: "Needs a login" })]);
  const task = store.createTask({ title: "Pay bill", activities: [{ title: "Pay", executor: "agent" }] });
  runner.approve(task.id);
  await runner.process(task.id);
  const t = store.getTask(task.id);
  assert.equal(t.status, "failed");
  assert.equal(t.activities[0].result, "Needs a login");
  assert.match(sent.at(-1).title, /Needs attention/);
});

test("cancel stops the agent between turns", async () => {
  const ctx = setup([]);
  const task = ctx.store.createTask({ title: "Long", activities: [{ title: "Loop", executor: "agent" }] });
  ctx.client.beta.messages.create = async () => {
    ctx.runner.cancel(task.id); // user taps Stop while the agent is mid-step
    return toolUse(`n${Math.random()}`, "notify_user", { message: "still going" });
  };
  ctx.runner.approve(task.id);
  await ctx.runner.process(task.id);
  assert.equal(ctx.store.getTask(task.id).status, "cancelled");
});

test("due-date reminders fire once per stage", async () => {
  const { store, runner, sent } = setup([]);
  const now = Date.parse("2026-01-01T12:00:00Z");
  store.createTask({ title: "Taxes", dueDate: "2026-01-01T12:30:00Z" });
  await runner.checkReminders(now);
  await runner.checkReminders(now);
  assert.equal(sent.length, 1);
  assert.match(sent[0].title, /within the hour/);
  await runner.checkReminders(now + 3600_000);
  assert.equal(sent.length, 2);
  assert.match(sent[1].title, /overdue/);
});

test("manual tasks complete when every activity is ticked off", () => {
  const { store, runner } = setup([]);
  const task = store.createTask({ title: "Groceries", activities: [{ title: "Milk", executor: "human" }, { title: "Eggs", executor: "human" }] });
  runner.completeActivity(task.id, task.activities[0].id);
  assert.equal(store.getTask(task.id).status, "todo");
  runner.skipActivity(task.id, task.activities[1].id);
  assert.equal(store.getTask(task.id).status, "done");
});

test("API rejects requests without the app token", async () => {
  const ctx = setup([]);
  const app = createApp({ ...ctx, config: { ...ctx.config, root: path.resolve("."), appToken: "secret-token" } });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(`${base}/api/tasks`)).status, 401);
    assert.equal((await fetch(`${base}/api/tasks`, { headers: { authorization: "Bearer nope" } })).status, 401);
    const ok = await fetch(`${base}/api/tasks`, {
      method: "POST",
      headers: { authorization: "Bearer secret-token", "content-type": "application/json" },
      body: JSON.stringify({ title: "Hello" }),
    });
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.equal(body.title, "Hello");
    assert.equal((await fetch(`${base}/api/health`)).status, 200);
  } finally {
    server.close();
  }
});
