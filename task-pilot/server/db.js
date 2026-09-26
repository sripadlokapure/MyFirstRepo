// Tiny JSON-file store. Good enough for one person's task list; swap for
// SQLite/Postgres if you ever need multi-user or heavy traffic.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const TASK_STATUSES = [
  "todo", // manual task, nobody has asked the agent to do anything
  "planning", // agent is drafting activities from the instructions
  "pending_approval", // plan is ready, waiting for you to approve
  "queued", // approved, waiting for the runner to pick it up
  "running", // agent is working on it
  "waiting_on_you", // blocked on a question, a human activity, or a step approval
  "done",
  "failed",
  "cancelled",
];

export const ACTIVITY_STATUSES = ["todo", "in_progress", "waiting_on_you", "done", "skipped", "failed"];

export const newId = () => crypto.randomUUID();
const now = () => new Date().toISOString();

export class Store {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, "db.json");
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.data = { tasks: [], subscriptions: [] };
    if (fs.existsSync(this.file)) {
      this.data = { ...this.data, ...JSON.parse(fs.readFileSync(this.file, "utf8")) };
    }
    this.listeners = new Set();
  }

  save() {
    // Write-then-rename so a crash never leaves a half-written file.
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    for (const fn of this.listeners) fn();
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  // ---- tasks ----
  listTasks() {
    return this.data.tasks;
  }

  getTask(id) {
    return this.data.tasks.find((t) => t.id === id) ?? null;
  }

  createTask(input) {
    validateTaskInput(input);
    const task = {
      id: newId(),
      title: String(input.title ?? "").trim() || "Untitled task",
      description: input.description ?? "",
      instructions: input.instructions ?? "",
      dueDate: input.dueDate || null,
      priority: input.priority ?? "normal",
      // Private tasks are never sent to Claude; they stay a plain checklist.
      private: Boolean(input.private),
      status: "todo",
      activities: (input.activities ?? []).map((a) => makeActivity(a)),
      log: [],
      reminders: {},
      createdAt: now(),
      updatedAt: now(),
    };
    this.data.tasks.unshift(task);
    this.addLog(task, "Task created");
    this.save();
    return task;
  }

  updateTask(id, patch) {
    const task = this.getTask(id);
    if (!task) return null;
    validateTaskInput(patch);
    const allowed = ["title", "description", "instructions", "dueDate", "priority", "status", "private"];
    for (const key of allowed) if (key in patch) task[key] = patch[key];
    if ("dueDate" in patch) task.reminders = {}; // new date, new reminders
    if (Array.isArray(patch.activities)) {
      task.activities = patch.activities.map((a) => {
        const existing = task.activities.find((x) => x.id === a.id);
        return existing ? Object.assign(existing, pickActivityFields(a)) : makeActivity(a);
      });
    }
    task.updatedAt = now();
    this.save();
    return task;
  }

  deleteTask(id) {
    const before = this.data.tasks.length;
    this.data.tasks = this.data.tasks.filter((t) => t.id !== id);
    if (this.data.tasks.length !== before) this.save();
    return this.data.tasks.length !== before;
  }

  addLog(task, message, level = "info") {
    task.log.push({ at: now(), level, message });
    if (task.log.length > 500) task.log.splice(0, task.log.length - 500);
    task.updatedAt = now();
  }

  // ---- push subscriptions ----
  addSubscription(sub) {
    if (!this.data.subscriptions.some((s) => s.endpoint === sub.endpoint)) {
      this.data.subscriptions.push(sub);
      this.save();
    }
  }

  removeSubscription(endpoint) {
    this.data.subscriptions = this.data.subscriptions.filter((s) => s.endpoint !== endpoint);
    this.save();
  }
}

const LIMITS = { title: 200, description: 5000, instructions: 10000, activities: 50 };

/** Reject oversized or malformed input instead of storing it (or sending it to Claude). */
export function validateTaskInput(input) {
  const fail = (msg) => {
    throw Object.assign(new Error(msg), { status: 400 });
  };
  for (const key of ["title", "description", "instructions"]) {
    if (input[key] != null && typeof input[key] !== "string") fail(`${key} must be text`);
    if ((input[key]?.length ?? 0) > LIMITS[key]) fail(`${key} is longer than ${LIMITS[key]} characters`);
  }
  if (input.dueDate != null && input.dueDate !== "" && Number.isNaN(Date.parse(input.dueDate))) fail("dueDate is not a valid date");
  if (input.priority != null && !["low", "normal", "high"].includes(input.priority)) fail("priority must be low, normal or high");
  if (input.activities != null) {
    if (!Array.isArray(input.activities)) fail("activities must be a list");
    if (input.activities.length > LIMITS.activities) fail(`At most ${LIMITS.activities} activities`);
    for (const a of input.activities) {
      if (typeof a !== "object" || a === null) fail("Each activity must be an object");
      if (String(a.title ?? "").length > LIMITS.title) fail("Activity title is too long");
      if (String(a.instructions ?? "").length > LIMITS.instructions) fail("Activity instructions are too long");
      if (a.dueDate && Number.isNaN(Date.parse(a.dueDate))) fail("Activity dueDate is not a valid date");
      if (a.status != null && !ACTIVITY_STATUSES.includes(a.status)) fail("Unknown activity status");
    }
  }
}

function pickActivityFields(a) {
  const out = {};
  for (const key of ["title", "instructions", "executor", "dueDate", "status", "needsApproval", "result"]) {
    if (key in a) out[key] = a[key];
  }
  return out;
}

export function makeActivity(a = {}) {
  return {
    id: a.id ?? newId(),
    title: String(a.title ?? "").trim() || "Untitled step",
    instructions: String(a.instructions ?? ""),
    // "agent" = Claude does it; "human" = you do it and tick it off.
    executor: a.executor === "human" ? "human" : "agent",
    // When true the agent stops and asks before running this particular step,
    // even after the overall plan was approved (payments, sending messages...).
    needsApproval: Boolean(a.needsApproval),
    dueDate: a.dueDate || null,
    status: a.status ?? "todo",
    result: a.result ?? "",
    // Agent conversation state, so a step can pause for your answer and resume.
    agent: null,
  };
}
