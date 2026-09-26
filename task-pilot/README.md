# Task Pilot

A to-do app for your phone where each task has:

- **Activities** (steps), each with its own status and due date
- **Instructions** that say how the task should be done
- A **Claude assistant** that turns those instructions into a plan and then carries out the steps it can do. It only starts after you approve the plan.
- **Phone alerts** when a plan needs approval, the assistant has a question, a step is yours to do, a task finishes or fails, or something is due soon or overdue

It is a web app you add to your home screen (a PWA), backed by a small Node server that keeps running while your phone is locked.

## How a task flows

```
 create task + instructions
          │
          ▼
   ✨ Claude drafts activities ──► 🔔 "Approve plan"
          │  (edit steps, who does each, due dates)
          ▼
   ✓ you approve
          │
          ▼
 ┌─ for each activity, in order ─────────────────────────────┐
 │ 🤖 assistant step     → does the work, saves the result   │
 │   ✋ "asks first"     → 🔔 waits for your OK, then runs    │
 │   ❓ needs a decision → 🔔 asks you, resumes on answer     │
 │ 🙋 your step          → 🔔 "Your turn", waits for ✓ done  │
 └───────────────────────────────────────────────────────────┘
          │
          ▼
   🔔 "Done" (or "Needs attention" if a step failed; you can retry)
```

Task statuses: `todo`, `planning`, `pending_approval`, `queued`, `running`, `waiting_on_you`, `done`, `failed`, `cancelled`.
Activity statuses: `todo`, `in_progress`, `waiting_on_you`, `done`, `skipped`, `failed`.

Tasks you never send to the assistant work as a normal checklist: tick the activities off and the task completes.

## What the assistant can do

These are its tools (defined in `server/tools.js`):

| Tool | What it does |
| --- | --- |
| web search, web fetch | Look things up and read pages (hosted by Anthropic; turn off with `ENABLE_WEB_TOOLS=false`) |
| `ask_user` | Pauses the step and sends you a question; picks up where it left off once you answer |
| `notify_user` | Sends you a heads-up without pausing |
| `call_webhook` | Triggers one of **your** named automations (Zapier, Make, IFTTT, Home Assistant, n8n…). It cannot call any other URL. |
| `complete_step` / `fail_step` | Records the result, or explains what you need to do instead |

Anything it can't do (paying, logging into accounts, physical tasks) gets planned as a **🙋 You** step. When the planner sees a step with real-world side effects, such as sending something or triggering an automation, it marks it **✋ asks first**. You can also set or clear that flag yourself on any step.

To give the assistant more abilities, add a tool to `buildCustomTools()` in `server/tools.js`. Each tool is a name, a description, a JSON schema and a `run` function.

## Run it

Requires Node 20+.

```bash
cd task-pilot
cp .env.example .env      # add ANTHROPIC_API_KEY, NTFY_TOPIC, etc.
npm install
npm start
```

The server prints an **app token**. You enter it once on your phone. Open `http://localhost:3000` to try it on your computer.

Without `ANTHROPIC_API_KEY` it still works as a to-do list with steps, due dates and reminders. The assistant features stay off.

## Put it on your phone

Your phone needs to reach the server. Web push also requires **HTTPS**. Pick one of these:

1. **Home computer + Tailscale** (free, private): install Tailscale on the computer and on your phone, then run `tailscale serve 3000`. That gives you an `https://<machine>.ts.net` address that only your devices can open.
2. **Cloudflare Tunnel**: `cloudflared tunnel --url http://localhost:3000` gives you a public HTTPS address. Keep the app token secret.
3. **A small cloud host** (Render, Railway, Fly.io, or a VPS): deploy the included `Dockerfile` and mount a persistent volume at `/data`.

Set `PUBLIC_URL` to that address so tapping a notification opens the right task.

Then on the phone:

- **iPhone (iOS 16.4+)**: open the address in Safari, tap Share → **Add to Home Screen**, open the app from the home screen, then go to ⚙︎ → **Enable notifications**.
- **Android**: open it in Chrome, tap **Install app** (or ⋮ → Add to Home screen), then ⚙︎ → **Enable notifications**.

### Easiest alerts: ntfy

If you don't want to deal with HTTPS or web-push quirks, set `NTFY_TOPIC=some-long-random-name`. Then install the free **ntfy** app (iOS/Android) and subscribe to that topic. Every alert goes there as well. Anyone who knows a topic name on the public ntfy.sh server can read it, so pick one that's hard to guess, or run your own ntfy server.

## Safety model

- Nothing runs until you approve the plan. Steps marked **asks first** need a second OK.
- The assistant acts only through the tools listed above. For webhooks, it can only call the names you configure.
- **Stop** halts a task between assistant actions.
- Every API call needs the app token. Treat it like a password.
- Web content is treated as information, not as instructions to follow (this is in the system prompt).
- Each step is capped at 30 model turns.

## Cost

Each planning call is one Claude request. Each assistant step is usually a few requests, plus any web searches. The default model is `claude-opus-5` at effort `high`. For routine errands you can set `CLAUDE_EFFORT=medium` or `low` to spend less. You can switch model with `CLAUDE_MODEL`.

## Project layout

```
server/
  index.js    wires everything together and starts the server
  app.js      REST API + static files + live updates (SSE)
  runner.js   task state machine: planning, approval, running steps, reminders
  agent.js    Claude: plan generation (structured output) + per-step tool loop
  tools.js    what the assistant is allowed to do
  notify.js   web push + ntfy
  db.js       JSON-file storage (data/db.json)
  config.js   env / .env loading
public/       the phone app (vanilla JS PWA + service worker)
test/         node:test suite with a scripted fake Claude client
```

Run the tests with `npm test`.
