// Moves approved tasks forward step by step, and sends due-date reminders.
import { answerQuestion } from "./agent.js";
import { makeActivity } from "./db.js";

const ACTIVE = new Set(["queued", "running"]);
const FINISHED = new Set(["done", "cancelled"]);

export class Runner {
  constructor({ store, agent, notifier, log = console }) {
    this.store = store;
    this.agent = agent;
    this.notifier = notifier;
    this.log = log;
    this.inflight = new Map(); // task id -> promise of the run in progress
    this.timer = null;
  }

  start(intervalMs = 30_000) {
    // Anything "running" when the server stopped gets picked up again. The
    // interrupted step restarts from scratch; its partial transcript is dropped.
    for (const task of this.store.listTasks()) {
      if (task.status === "running") {
        task.status = "queued";
        for (const a of task.activities) if (a.status === "in_progress") a.agent = null;
        this.store.addLog(task, "Server restarted; resuming.");
      }
      if (task.status === "planning") {
        task.status = "todo";
        this.store.addLog(task, "Server restarted while planning; generate the plan again.", "warn");
      }
    }
    this.store.save();
    this.timer = setInterval(() => this.tick(), intervalMs);
    this.tick();
  }

  stop() {
    clearInterval(this.timer);
  }

  tick() {
    for (const task of this.store.listTasks()) {
      if (ACTIVE.has(task.status)) this.process(task.id);
    }
    this.checkReminders().catch((err) => this.log.error("[reminders]", err));
  }

  kick(taskId) {
    this.process(taskId);
  }

  // ---------------------------------------------------------------- planning

  async plan(taskId) {
    const task = this.store.getTask(taskId);
    if (!task) throw new Error("Task not found");
    task.status = "planning";
    this.store.addLog(task, "Drafting a plan from your instructions...");
    this.store.save();
    try {
      const plan = await this.agent.plan(task);
      task.activities = plan.activities.map((a) => makeActivity(a));
      task.planSummary = plan.summary;
      task.status = "pending_approval";
      this.store.addLog(task, `Plan ready with ${task.activities.length} steps. ${plan.summary}`);
      this.store.save();
      await this.notifier.send({
        title: `Approve plan: ${task.title}`,
        body: `${task.activities.length} steps ready for review. ${plan.summary}`,
        taskId: task.id,
        urgent: true,
      });
    } catch (err) {
      task.status = "todo";
      this.store.addLog(task, `Planning failed: ${err.message}`, "error");
      this.store.save();
      await this.notifier.send({ title: `Planning failed: ${task.title}`, body: err.message, taskId: task.id });
      throw err;
    }
  }

  // --------------------------------------------------------- user decisions

  approve(taskId) {
    const task = this.#mustGet(taskId);
    if (task.activities.length === 0) throw new Error("Add at least one activity before approving.");
    if (task.private && task.activities.some((a) => a.executor === "agent" && a.status !== "done" && a.status !== "skipped")) {
      throw new Error("Private tasks are never sent to Claude. Make every step a “Me” step, or turn off Private.");
    }
    task.status = "queued";
    task.approvedAt = new Date().toISOString();
    this.store.addLog(task, "Plan approved. Starting work.");
    this.store.save();
    this.kick(taskId);
    return task;
  }

  cancel(taskId) {
    const task = this.#mustGet(taskId);
    task.status = "cancelled";
    this.store.addLog(task, "Cancelled.");
    this.store.save();
    return task;
  }

  retry(taskId) {
    const task = this.#mustGet(taskId);
    for (const a of task.activities) {
      if (a.status === "failed" || a.status === "in_progress") {
        a.status = "todo";
        a.agent = null;
      }
    }
    task.status = "queued";
    this.store.addLog(task, "Retrying.");
    this.store.save();
    this.kick(taskId);
    return task;
  }

  completeActivity(taskId, activityId, note) {
    const { task, activity } = this.#mustGetActivity(taskId, activityId);
    activity.status = "done";
    if (note) activity.result = note;
    this.store.addLog(task, `Step done: ${activity.title}`);
    this.#resumeOrFinish(task);
    return task;
  }

  reopenActivity(taskId, activityId) {
    const { task, activity } = this.#mustGetActivity(taskId, activityId);
    activity.status = "todo";
    activity.agent = null;
    if (task.status === "done") task.status = task.approvedAt ? "waiting_on_you" : "todo";
    this.store.save();
    return task;
  }

  skipActivity(taskId, activityId) {
    const { task, activity } = this.#mustGetActivity(taskId, activityId);
    activity.status = "skipped";
    this.store.addLog(task, `Step skipped: ${activity.title}`);
    this.#resumeOrFinish(task);
    return task;
  }

  approveActivity(taskId, activityId) {
    const { task, activity } = this.#mustGetActivity(taskId, activityId);
    activity.approvedAt = new Date().toISOString();
    activity.status = "todo";
    this.store.addLog(task, `Step approved: ${activity.title}`);
    this.#resumeOrFinish(task);
    return task;
  }

  answer(taskId, activityId, text) {
    const { task, activity } = this.#mustGetActivity(taskId, activityId);
    if (!answerQuestion(activity, text)) throw new Error("That step is not waiting for an answer.");
    activity.status = "todo";
    this.store.addLog(task, `You answered: ${text}`);
    this.#resumeOrFinish(task);
    return task;
  }

  async resolveAction(taskId, activityId, approved) {
    const { task, activity } = this.#mustGetActivity(taskId, activityId);
    if (activity.agent?.pending?.kind !== "action") throw new Error("That step is not waiting for an approval.");
    this.store.addLog(task, `${approved ? "Allowed" : "Declined"}: ${activity.agent.pending.question.split("\n")[0]}`);
    await this.agent.resolveAction(task, activity, approved);
    activity.status = "todo";
    this.#resumeOrFinish(task);
    return task;
  }

  #resumeOrFinish(task) {
    // Manual (never-approved) tasks just track progress; approved ones continue.
    if (["waiting_on_you", "failed", "queued", "running"].includes(task.status)) {
      if (task.status !== "running") task.status = "queued";
      this.store.save();
      this.kick(task.id);
      return;
    }
    if (task.activities.length && task.activities.every((a) => a.status === "done" || a.status === "skipped")) {
      task.status = "done";
      this.store.addLog(task, "All steps finished.");
    }
    this.store.save();
  }

  // ------------------------------------------------------------ execution

  /** Work on a task; concurrent calls share the run already in progress. */
  process(taskId) {
    if (!this.inflight.has(taskId)) {
      this.inflight.set(taskId, this.#guarded(taskId).finally(() => this.inflight.delete(taskId)));
    }
    return this.inflight.get(taskId);
  }

  async #guarded(taskId) {
    try {
      await this.#process(taskId);
    } catch (err) {
      const task = this.store.getTask(taskId);
      if (task) {
        task.status = "failed";
        this.store.addLog(task, `Error: ${err.message}`, "error");
        this.store.save();
        await this.notifier.send({ title: `Task failed: ${task.title}`, body: err.message, taskId, urgent: true });
      }
      this.log.error("[runner]", err);
    }
  }

  async #process(taskId) {
    const stillActive = () => ACTIVE.has(this.store.getTask(taskId)?.status);

    while (true) {
      const task = this.store.getTask(taskId);
      if (!task || !ACTIVE.has(task.status)) return;

      const activity = task.activities.find((a) => a.status !== "done" && a.status !== "skipped");
      if (!activity) {
        task.status = "done";
        this.store.addLog(task, "All steps finished.");
        this.store.save();
        await this.notifier.send({ title: `Done: ${task.title}`, body: summarize(task), taskId });
        return;
      }

      if (activity.status === "failed") {
        task.status = "failed";
        this.store.save();
        return;
      }

      if (activity.executor === "human") {
        await this.#waitOnUser(task, activity, `Your turn: ${activity.title}`, activity.instructions || "Tap to mark it done.");
        return;
      }

      if (activity.needsApproval && !activity.approvedAt) {
        await this.#waitOnUser(task, activity, `Approve step: ${activity.title}`, activity.instructions || "The agent is ready to do this step.");
        return;
      }

      if (activity.agent?.pending) {
        task.status = "waiting_on_you";
        activity.status = "waiting_on_you";
        this.store.save();
        return;
      }

      task.status = "running";
      activity.status = "in_progress";
      activity.startedAt ??= new Date().toISOString();
      this.store.addLog(task, `Working on: ${activity.title}`);
      this.store.save();

      const result = await this.agent.runActivity({
        task,
        activity,
        persist: () => this.store.save(),
        shouldStop: () => !stillActive(),
      });

      if (result.outcome === "stopped") return;
      if (result.outcome === "done") {
        activity.status = "done";
        activity.result = result.text;
        activity.agent = compactTranscript(activity.agent);
        this.store.addLog(task, `Finished: ${activity.title}`);
        this.store.save();
        continue;
      }
      if (result.outcome === "question") {
        await this.#waitOnUser(task, activity, `Question: ${task.title}`, result.text);
        return;
      }
      if (result.outcome === "action") {
        await this.#waitOnUser(task, activity, `Allow action? ${task.title}`, result.text);
        return;
      }
      activity.status = "failed";
      activity.result = result.text;
      task.status = "failed";
      this.store.addLog(task, `Step failed: ${activity.title}. ${result.text}`, "error");
      this.store.save();
      await this.notifier.send({ title: `Needs attention: ${task.title}`, body: `${activity.title}: ${result.text}`, taskId, urgent: true });
      return;
    }
  }

  async #waitOnUser(task, activity, title, body) {
    const alreadyWaiting = activity.status === "waiting_on_you" && task.status === "waiting_on_you";
    task.status = "waiting_on_you";
    activity.status = "waiting_on_you";
    if (!alreadyWaiting) this.store.addLog(task, title);
    this.store.save();
    if (!alreadyWaiting) await this.notifier.send({ title, body, taskId: task.id, urgent: true });
  }

  // ------------------------------------------------------------ reminders

  async checkReminders(now = Date.now()) {
    let changed = false;
    for (const task of this.store.listTasks()) {
      if (FINISHED.has(task.status)) continue;
      changed = (await this.#remind(task, task, task.title, now)) || changed;
      for (const a of task.activities) {
        if (a.status === "done" || a.status === "skipped") continue;
        changed = (await this.#remind(task, a, `${task.title} → ${a.title}`, now)) || changed;
      }
    }
    if (changed) this.store.save();
  }

  async #remind(task, item, label, now) {
    if (!item.dueDate) return false;
    const due = Date.parse(item.dueDate);
    if (Number.isNaN(due)) return false;
    item.reminders ??= {};
    const left = due - now;
    let kind = null;
    if (left <= 0) kind = "overdue";
    else if (left <= 3600_000) kind = "hour";
    else if (left <= 24 * 3600_000) kind = "day";
    if (!kind || item.reminders[kind]) return false;
    // Mark earlier stages too so an overdue task doesn't also fire "due soon".
    for (const k of ["day", "hour", "overdue"]) {
      item.reminders[k] = true;
      if (k === kind) break;
    }
    const when = kind === "overdue" ? "is overdue" : kind === "hour" ? "is due within the hour" : "is due within 24 hours";
    await this.notifier.send({ title: `${label} ${when}`, body: `Status: ${task.status.replaceAll("_", " ")}`, taskId: task.id, urgent: kind !== "day", tag: `due-${item.id}` });
    return true;
  }

  // ------------------------------------------------------------ helpers

  #mustGet(taskId) {
    const task = this.store.getTask(taskId);
    if (!task) throw Object.assign(new Error("Task not found"), { status: 404 });
    return task;
  }

  #mustGetActivity(taskId, activityId) {
    const task = this.#mustGet(taskId);
    const activity = task.activities.find((a) => a.id === activityId);
    if (!activity) throw Object.assign(new Error("Activity not found"), { status: 404 });
    return { task, activity };
  }
}

function summarize(task) {
  const last = [...task.activities].reverse().find((a) => a.result);
  return last ? last.result.slice(0, 300) : `${task.activities.length} steps completed.`;
}

// Once a step is done we only need its result, not the whole transcript.
function compactTranscript(state) {
  return state ? { turns: state.turns, messages: [], pending: null } : null;
}
