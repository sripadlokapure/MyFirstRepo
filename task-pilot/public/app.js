// Task Pilot front end: plain JS, no build step.
const $view = document.getElementById("view");
const $banner = document.getElementById("banner");
const $toast = document.getElementById("toast");

const STATUS_LABEL = {
  todo: "To do",
  planning: "Planning…",
  pending_approval: "Needs approval",
  queued: "Queued",
  running: "Working…",
  in_progress: "Working…",
  waiting_on_you: "Needs you",
  done: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
  skipped: "Skipped",
};
const NEEDS_YOU = new Set(["pending_approval", "waiting_on_you", "failed"]);
const CLOSED = new Set(["done", "cancelled"]);

let token = safeGet("token");
let config = null;
let listFilter = safeGet("filter") || "active";

// ------------------------------------------------------------------ utils

function safeGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function safeSet(key, value) {
  try { value == null ? localStorage.removeItem(key) : localStorage.setItem(key, value); } catch {}
}

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function toast(msg) {
  $toast.textContent = msg;
  $toast.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => ($toast.hidden = true), 2800);
}

async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    token = null;
    safeSet("token", null);
    route();
    throw new Error("Please sign in again");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function chip(status) {
  return `<span class="chip s-${esc(status)}">${esc(STATUS_LABEL[status] ?? status)}</span>`;
}

function fmtDue(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const days = Math.round((d - Date.now()) / 86400000);
  const rel = d < Date.now() ? "overdue" : days === 0 ? "today" : days === 1 ? "tomorrow" : `in ${days} days`;
  const abs = d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  return `${abs} · ${rel}`;
}
const isOverdue = (item) => item.dueDate && !CLOSED.has(item.status) && new Date(item.dueDate) < new Date();

// <input type="datetime-local"> works in local time without a zone.
function toLocalInput(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}
const fromLocalInput = (v) => (v ? new Date(v).toISOString() : null);

async function run(btn, fn) {
  if (btn) btn.disabled = true;
  try {
    await fn();
  } catch (err) {
    toast(err.message);
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ------------------------------------------------------------------ router

window.addEventListener("hashchange", route);

async function route() {
  if (!token) return renderLogin();
  if (!config) {
    try {
      config = await api("/config");
    } catch (err) {
      if (token) $view.innerHTML = `<p class="empty">Can't reach the server. ${esc(err.message)}</p>`;
      return;
    }
    startLiveUpdates();
  }
  $banner.hidden = config.agentEnabled;
  $banner.textContent = "The assistant is off: add ANTHROPIC_API_KEY on the server to let Claude plan and run tasks. You can still use the to-do list.";

  const hash = location.hash.replace(/^#/, "") || "/";
  const [, page, id, sub] = hash.split("/");
  try {
    if (!page) return await renderList();
    if (page === "new") return renderForm(null);
    if (page === "task" && sub === "edit") return renderForm(await api(`/tasks/${id}`));
    if (page === "task") return await renderTask(id);
    if (page === "settings") {
      config = await api("/config"); // fresh spend figures
      return renderSettings();
    }
    location.hash = "#/";
  } catch (err) {
    $view.innerHTML = `<p class="empty">${esc(err.message)}</p><p style="text-align:center"><a href="#/">Back to tasks</a></p>`;
  }
}

// Live updates over Server-Sent Events. Read with fetch() rather than
// EventSource so the token travels in a header, never in a URL or server log.
let events;
function startLiveUpdates() {
  events?.abort();
  const ctrl = (events = new AbortController());
  (async function listen(delay) {
    try {
      const res = await fetch("/api/events", { headers: { authorization: `Bearer ${token}` }, signal: ctrl.signal });
      if (!res.ok) return;
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      delay = 1000;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value.includes("event: change")) onRemoteChange();
      }
    } catch {
      if (ctrl.signal.aborted) return;
    }
    setTimeout(() => !ctrl.signal.aborted && listen(Math.min(delay * 2, 30000)), delay);
  })(1000);
}

function onRemoteChange() {
  // Don't clobber a form the user is typing in.
  if (/^#\/(new|task\/[^/]+\/edit|settings)/.test(location.hash)) return;
  if (document.activeElement?.matches("textarea, input")) return;
  route();
}

// ------------------------------------------------------------------ login

function renderLogin() {
  $banner.hidden = true;
  $view.innerHTML = `
    <h1>Sign in</h1>
    <p class="hint">Enter the app token printed when the server starts (or the <code>APP_TOKEN</code> you set).</p>
    <form id="login">
      <label for="tok">App token</label>
      <input id="tok" type="password" autocomplete="current-password" required />
      <div class="actions"><button class="btn primary" type="submit">Continue</button></div>
    </form>`;
  document.getElementById("login").onsubmit = async (e) => {
    e.preventDefault();
    token = document.getElementById("tok").value.trim();
    safeSet("token", token);
    config = null;
    route();
  };
}

// ------------------------------------------------------------------ list

async function renderList() {
  const tasks = await api("/tasks");
  const filters = {
    active: (t) => !CLOSED.has(t.status),
    needs: (t) => NEEDS_YOU.has(t.status) || isOverdue(t),
    done: (t) => CLOSED.has(t.status),
    all: () => true,
  };
  const counts = Object.fromEntries(Object.entries(filters).map(([k, f]) => [k, tasks.filter(f).length]));
  const shown = tasks.filter(filters[listFilter] ?? filters.active).sort(byUrgency);
  const tab = (key, label) =>
    `<button class="tab" data-f="${key}" aria-pressed="${listFilter === key}">${label}${counts[key] ? ` · ${counts[key]}` : ""}</button>`;

  $view.innerHTML = `
    <div class="tabs" role="group" aria-label="Filter tasks">
      ${tab("active", "Active")}${tab("needs", "Needs you")}${tab("done", "Done")}${tab("all", "All")}
    </div>
    ${shown.length ? shown.map(card).join("") : `<p class="empty">${listFilter === "needs" ? "Nothing needs you right now." : "No tasks here yet. Tap + to add one."}</p>`}
    <a href="#/new" class="fab" aria-label="New task">+</a>`;

  $view.querySelectorAll(".tab").forEach((b) =>
    b.addEventListener("click", () => {
      listFilter = b.dataset.f;
      safeSet("filter", listFilter);
      renderList();
    }),
  );
}

function byUrgency(a, b) {
  const rank = (t) => (NEEDS_YOU.has(t.status) ? 0 : CLOSED.has(t.status) ? 2 : 1);
  if (rank(a) !== rank(b)) return rank(a) - rank(b);
  const due = (t) => (t.dueDate ? Date.parse(t.dueDate) : Infinity);
  return due(a) - due(b);
}

function card(t) {
  const total = t.activities.length;
  const done = t.activities.filter((a) => a.status === "done" || a.status === "skipped").length;
  return `
    <a class="card" href="#/task/${t.id}">
      <div class="card-top"><span class="card-title">${esc(t.title)}</span>${chip(t.status)}</div>
      <div class="meta">
        ${t.dueDate ? `<span class="${isOverdue(t) ? "overdue" : ""}">⏰ ${esc(fmtDue(t.dueDate))}</span>` : ""}
        ${total ? `<span>${done}/${total} steps</span>` : ""}
        ${t.priority === "high" ? `<span>🔥 High</span>` : ""}
      </div>
      ${total ? `<div class="progress"><span style="width:${Math.round((done / total) * 100)}%"></span></div>` : ""}
    </a>`;
}

// ------------------------------------------------------------------ detail

async function renderTask(id) {
  const t = await api(`/tasks/${id}`);
  const s = t.status;
  const can = {
    plan: config.agentEnabled && !t.private && ["todo", "pending_approval", "failed", "cancelled"].includes(s),
    approve: !t.private && (s === "pending_approval" || (s === "todo" && t.activities.some((a) => a.executor === "agent"))),
    cancel: ["pending_approval", "queued", "running", "waiting_on_you", "planning"].includes(s),
    retry: s === "failed" || s === "cancelled",
  };

  const attention =
    s === "pending_approval"
      ? `<div class="panel attention"><strong>Review the plan below.</strong> Nothing runs until you approve. Steps marked “asks first” will stop for a second OK before they run.</div>`
      : "";

  $view.innerHTML = `
    <a href="#/">← Tasks</a>
    <h1>${esc(t.title)}</h1>
    <div class="meta">
      ${chip(s)}
      ${t.dueDate ? `<span class="${isOverdue(t) ? "overdue" : ""}">⏰ ${esc(fmtDue(t.dueDate))}</span>` : ""}
      ${t.priority === "high" ? "<span>🔥 High priority</span>" : ""}
      ${t.private ? "<span>🔒 Private: never sent to Claude</span>" : ""}
      ${t.costUsd ? `<span>≈ $${t.costUsd.toFixed(2)} assistant cost</span>` : ""}
    </div>
    ${attention}
    <div class="actions">
      ${can.approve ? `<button class="btn primary" data-do="approve">✓ Approve &amp; run</button>` : ""}
      ${can.plan ? `<button class="btn" data-do="plan">✨ ${t.activities.length ? "Re-plan" : "Draft plan"} with Claude</button>` : ""}
      ${can.retry ? `<button class="btn primary" data-do="retry">↻ ${s === "failed" ? "Retry" : "Resume"}</button>` : ""}
      <a class="btn" href="#/task/${t.id}/edit">Edit</a>
      ${can.cancel ? `<button class="btn danger" data-do="cancel">Stop</button>` : ""}
      <button class="btn danger" data-do="delete">Delete</button>
    </div>
    ${t.description ? `<div class="panel pre">${esc(t.description)}</div>` : ""}
    ${t.instructions ? `<h2>Instructions</h2><div class="panel pre">${esc(t.instructions)}</div>` : ""}
    ${t.planSummary ? `<h2>Plan</h2><p>${esc(t.planSummary)}</p>` : ""}
    <h2>Activities</h2>
    ${t.activities.length ? `<ol class="steps">${t.activities.map((a, i) => step(t, a, i)).join("")}</ol>` : `<p class="hint">No activities yet. ${config.agentEnabled ? "Draft a plan with Claude or add them via Edit." : "Add them via Edit."}</p>`}
    <details><summary>Activity log (${t.log.length})</summary>
      <ul class="log">${[...t.log].reverse().map((l) => `<li class="${esc(l.level)}"><time>${esc(new Date(l.at).toLocaleString())}</time>${esc(l.message)}</li>`).join("")}</ul>
    </details>`;

  $view.querySelectorAll("[data-do]").forEach((b) => b.addEventListener("click", () => run(b, () => taskAction(t, b.dataset.do))));
  $view.querySelectorAll("[data-step]").forEach((b) =>
    b.addEventListener("click", () => run(b, () => stepAction(t, b.dataset.aid, b.dataset.step))),
  );
  $view.querySelectorAll("form.answer").forEach((f) =>
    f.addEventListener("submit", (e) => {
      e.preventDefault();
      const answer = f.querySelector("textarea").value;
      run(f.querySelector("button"), async () => {
        await api(`/tasks/${t.id}/activities/${f.dataset.aid}/answer`, { method: "POST", body: { answer } });
        toast("Sent. The assistant will continue.");
        route();
      });
    }),
  );
}

function step(t, a, i) {
  const waiting = a.status === "waiting_on_you";
  const managed = !["todo", "done", "cancelled"].includes(t.status) || t.approvedAt;
  const buttons = [];
  if (a.pendingKind === "action" && waiting) {
    buttons.push(`<button class="btn small primary" data-step="allow" data-aid="${a.id}">✓ Allow</button>`);
    buttons.push(`<button class="btn small danger" data-step="deny" data-aid="${a.id}">✕ Decline</button>`);
  } else if (a.question && waiting) {
    // answer form rendered below
  } else if (waiting && a.executor === "agent" && a.needsApproval && !a.approvedAt) {
    buttons.push(`<button class="btn small primary" data-step="approve" data-aid="${a.id}">✓ Allow this step</button>`);
    buttons.push(`<button class="btn small" data-step="skip" data-aid="${a.id}">Skip</button>`);
  } else if (a.status !== "done" && a.status !== "skipped" && (a.executor === "human" || !managed || a.status === "failed")) {
    buttons.push(`<button class="btn small ${waiting ? "primary" : ""}" data-step="complete" data-aid="${a.id}">✓ Mark done</button>`);
    buttons.push(`<button class="btn small" data-step="skip" data-aid="${a.id}">Skip</button>`);
  } else if (a.status === "done" || a.status === "skipped") {
    buttons.push(`<button class="btn small" data-step="reopen" data-aid="${a.id}">Reopen</button>`);
  }

  return `
    <li class="step ${esc(a.status)} ${waiting ? "attention" : ""}">
      <div class="step-head">
        <span class="step-num">${a.status === "done" ? "✓" : i + 1}</span>
        <span class="step-title">${esc(a.title)}</span>
        ${chip(a.status)}
      </div>
      <div class="step-body">
        <div class="meta">
          <span>${a.executor === "agent" ? "🤖 Assistant" : "🙋 You"}</span>
          ${a.needsApproval ? "<span>✋ asks first</span>" : ""}
          ${a.dueDate ? `<span class="${isOverdue(a) ? "overdue" : ""}">⏰ ${esc(fmtDue(a.dueDate))}</span>` : ""}
        </div>
        ${a.instructions ? `<p class="pre">${esc(a.instructions)}</p>` : ""}
        ${a.result ? `<div class="result pre">${esc(a.result)}</div>` : ""}
        ${
          a.pendingKind === "action" && waiting
            ? `<div class="question"><strong>The assistant wants to act:</strong><div class="pre">${esc(a.question)}</div></div>`
            : ""
        }
        ${
          a.pendingKind === "question" && waiting
            ? `<form class="answer question" data-aid="${a.id}">
                 <strong>Question:</strong> <span class="pre">${esc(a.question)}</span>
                 <label for="ans-${a.id}">Your answer</label>
                 <textarea id="ans-${a.id}" required style="min-height:70px"></textarea>
                 <div class="actions"><button class="btn primary small" type="submit">Send answer</button></div>
               </form>`
            : ""
        }
        ${buttons.length ? `<div class="actions">${buttons.join("")}</div>` : ""}
      </div>
    </li>`;
}

async function taskAction(t, action) {
  if (action === "delete") {
    if (!confirm(`Delete “${t.title}”?`)) return;
    await api(`/tasks/${t.id}`, { method: "DELETE" });
    location.hash = "#/";
    return;
  }
  if (action === "cancel" && !confirm("Stop this task? The assistant will halt after its current action.")) return;
  await api(`/tasks/${t.id}/${action}`, { method: "POST" });
  toast({ approve: "Approved. Working on it…", plan: "Drafting a plan… you'll get a notification.", retry: "Retrying…", cancel: "Stopped." }[action]);
  route();
}

async function stepAction(t, aid, action) {
  if (action === "allow" || action === "deny") {
    await api(`/tasks/${t.id}/activities/${aid}/action`, { method: "POST", body: { approve: action === "allow" } });
    toast(action === "allow" ? "Allowed. The assistant will continue." : "Declined.");
    return route();
  }
  let body;
  if (action === "complete") {
    const note = prompt("Add a note (optional):") ?? null;
    if (note === null) return;
    body = { note };
  }
  await api(`/tasks/${t.id}/activities/${aid}/${action}`, { method: "POST", body });
  route();
}

// ------------------------------------------------------------------ form

function renderForm(t) {
  const editing = Boolean(t);
  let steps = (t?.activities ?? []).map((a) => ({ ...a }));

  $view.innerHTML = `
    <a href="${editing ? `#/task/${t.id}` : "#/"}">← ${editing ? "Back" : "Tasks"}</a>
    <h1>${editing ? "Edit task" : "New task"}</h1>
    <form id="taskform">
      <label for="f-title">Title</label>
      <input id="f-title" type="text" required value="${esc(t?.title)}" placeholder="e.g. Plan weekend trip to Pune" />

      <div class="row">
        <div>
          <label for="f-due">Due</label>
          <input id="f-due" type="datetime-local" value="${esc(toLocalInput(t?.dueDate))}" />
        </div>
        <div>
          <label for="f-prio">Priority</label>
          <select id="f-prio">
            ${["low", "normal", "high"].map((p) => `<option ${(t?.priority ?? "normal") === p ? "selected" : ""}>${p}</option>`).join("")}
          </select>
        </div>
      </div>

      <label for="f-desc">Description <span class="hint">(optional)</span></label>
      <textarea id="f-desc" style="min-height:70px">${esc(t?.description)}</textarea>

      <label for="f-instr">Instructions for completing it
        <span class="hint">— what should happen, preferences, limits, where to look</span></label>
      <textarea id="f-instr" placeholder="e.g. Find 3 hotels under ₹5000/night near Koregaon Park for 12–14 Oct, compare reviews, and ask me before booking anything.">${esc(t?.instructions)}</textarea>

      <h2>Activities</h2>
      <div id="steps"></div>
      <button type="button" class="btn small" id="addstep">+ Add activity</button>

      <label class="check"><input type="checkbox" id="f-private" ${t?.private ? "checked" : ""} /> 🔒 Private: never send this task to Claude</label>
      ${
        !editing && config.agentEnabled
          ? `<label class="check"><input type="checkbox" id="f-auto" checked /> Let Claude draft the plan (you approve before anything runs)</label>`
          : ""
      }
      <div class="actions">
        <button class="btn primary" type="submit">${editing ? "Save" : "Create task"}</button>
      </div>
    </form>`;

  const $steps = document.getElementById("steps");
  const drawSteps = () => {
    $steps.innerHTML = steps.length
      ? steps
          .map(
            (s, i) => `
      <div class="edit-step" data-i="${i}">
        <div class="row" style="align-items:end">
          <div style="flex:3">
            <label for="s-title-${i}">Step ${i + 1}</label>
            <input id="s-title-${i}" type="text" data-k="title" value="${esc(s.title)}" required />
          </div>
          <button type="button" class="btn small danger" data-remove="${i}" aria-label="Remove step ${i + 1}" style="flex:none">✕</button>
        </div>
        <label for="s-instr-${i}">Instructions</label>
        <textarea id="s-instr-${i}" data-k="instructions" style="min-height:60px">${esc(s.instructions)}</textarea>
        <div class="row">
          <div>
            <label for="s-exec-${i}">Done by</label>
            <select id="s-exec-${i}" data-k="executor">
              <option value="agent" ${s.executor !== "human" ? "selected" : ""}>🤖 Assistant</option>
              <option value="human" ${s.executor === "human" ? "selected" : ""}>🙋 Me</option>
            </select>
          </div>
          <div>
            <label for="s-due-${i}">Due</label>
            <input id="s-due-${i}" type="datetime-local" data-k="dueDate" value="${esc(toLocalInput(s.dueDate))}" />
          </div>
        </div>
        <label class="check"><input type="checkbox" data-k="needsApproval" ${s.needsApproval ? "checked" : ""} /> Ask me before running this step</label>
      </div>`,
          )
          .join("")
      : `<p class="hint">No activities yet.${config.agentEnabled ? " Claude can draft them from your instructions." : ""}</p>`;
  };
  const readSteps = () => {
    $steps.querySelectorAll(".edit-step").forEach((el) => {
      const s = steps[Number(el.dataset.i)];
      el.querySelectorAll("[data-k]").forEach((input) => {
        const k = input.dataset.k;
        s[k] = input.type === "checkbox" ? input.checked : k === "dueDate" ? fromLocalInput(input.value) : input.value;
      });
    });
  };
  drawSteps();

  document.getElementById("addstep").onclick = () => {
    readSteps();
    steps.push({ title: "", instructions: "", executor: "human", needsApproval: false, dueDate: null });
    drawSteps();
    document.getElementById(`s-title-${steps.length - 1}`).focus();
  };
  $steps.addEventListener("click", (e) => {
    const i = e.target.closest("[data-remove]")?.dataset.remove;
    if (i === undefined) return;
    readSteps();
    steps.splice(Number(i), 1);
    drawSteps();
  });

  document.getElementById("taskform").onsubmit = (e) => {
    e.preventDefault();
    readSteps();
    const body = {
      title: document.getElementById("f-title").value,
      dueDate: fromLocalInput(document.getElementById("f-due").value),
      priority: document.getElementById("f-prio").value,
      description: document.getElementById("f-desc").value,
      instructions: document.getElementById("f-instr").value,
      activities: steps,
      private: document.getElementById("f-private").checked,
    };
    run(e.submitter, async () => {
      if (editing) {
        await api(`/tasks/${t.id}`, { method: "PATCH", body });
        location.hash = `#/task/${t.id}`;
      } else {
        body.autoPlan = !body.private && (document.getElementById("f-auto")?.checked ?? false);
        const created = await api("/tasks", { method: "POST", body });
        if (body.autoPlan) toast("Drafting a plan… you'll get a notification to approve it.");
        location.hash = `#/task/${created.id}`;
      }
    });
  };
}

// ------------------------------------------------------------------ settings

function renderSettings() {
  const pushSupported = "serviceWorker" in navigator && "PushManager" in window;
  const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone;
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const perm = "Notification" in window ? Notification.permission : "unsupported";

  $view.innerHTML = `
    <a href="#/">← Tasks</a>
    <h1>Settings</h1>

    <h2>Phone alerts</h2>
    <div class="panel">
      <p>You'll be alerted when a plan needs approval, the assistant has a question, a step is yours to do, a task finishes or fails, and when things are due or overdue.</p>
      ${
        !pushSupported
          ? `<p class="hint">This browser can't receive web push${isIOS && !standalone ? ". On iPhone, tap Share → <strong>Add to Home Screen</strong>, then open Task Pilot from the home screen and come back here" : ""}. You can use ntfy below instead.</p>`
          : `<p>Status: <strong>${perm === "granted" ? "enabled" : perm === "denied" ? "blocked in browser settings" : "not enabled"}</strong></p>
             <div class="actions">
               <button class="btn primary" id="enable-push">🔔 Enable notifications on this device</button>
               <button class="btn" id="test-push">Send test</button>
             </div>`
      }
    </div>
    <div class="panel">
      <strong>ntfy</strong> ${config.ntfyTopic ? chip("done").replace("Done", "On") : chip("todo").replace("To do", "Off")}
      <p class="hint">${
        config.ntfyTopic
          ? `Install the free <strong>ntfy</strong> app and subscribe to topic <code>${esc(config.ntfyTopic)}</code> on <code>${esc(config.ntfyServer)}</code>.`
          : "Optional backup channel that works on any phone without HTTPS: set <code>NTFY_TOPIC</code> on the server."
      }</p>
    </div>

    <h2>Assistant</h2>
    <div class="panel">
      ${
        config.agentEnabled
          ? `<p>On · model <code>${esc(config.model)}</code></p>
             ${usageLine()}
             <p class="hint">Tools: ask you questions, send you notifications${config.webTools ? ", search the web, read web pages" : ""}${config.webhooks.length ? `, trigger automations (${config.webhooks.map(esc).join(", ")})${config.webhooksRequireApproval ? ", each one only after you tap Allow" : ""}` : ""}.</p>`
          : `<p>Off. Set <code>ANTHROPIC_API_KEY</code> on the server to enable planning and autonomous steps.</p>`
      }
    </div>

    <div class="actions"><button class="btn danger" id="logout">Sign out</button></div>`;

  document.getElementById("enable-push")?.addEventListener("click", (e) => run(e.currentTarget, enablePush));
  document.getElementById("test-push")?.addEventListener("click", (e) =>
    run(e.currentTarget, async () => {
      await api("/push/test", { method: "POST" });
      toast("Test sent.");
    }),
  );
  document.getElementById("logout").onclick = () => {
    safeSet("token", null);
    token = null;
    config = null;
    events?.abort();
    location.hash = "#/";
    route();
  };
}

function usageLine() {
  const u = config.usage;
  if (!u) return "";
  const cap = u.monthlyBudgetUsd > 0 ? ` of $${u.monthlyBudgetUsd.toFixed(2)} monthly cap` : " (no monthly cap)";
  const task = u.taskBudgetUsd > 0 ? ` · max $${u.taskBudgetUsd.toFixed(2)} per task` : "";
  return `<p>This month: <strong>≈ $${u.usd.toFixed(2)}</strong>${cap}${task} · ${u.requests} requests</p>`;
}

async function enablePush() {
  const perm = await Notification.requestPermission();
  if (perm !== "granted") throw new Error("Notifications were not allowed.");
  const reg = await navigator.serviceWorker.ready;
  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(config.vapidPublicKey) }));
  await api("/push/subscribe", { method: "POST", body: sub.toJSON() });
  toast("Notifications enabled on this device.");
  renderSettings();
}

function b64ToBytes(b64) {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

// ------------------------------------------------------------------ boot

if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
route();
