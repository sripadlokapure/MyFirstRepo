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

## Cost

| Item | Cost |
| --- | --- |
| The app itself, web push, ntfy.sh, Tailscale personal plan | Free |
| Running it on your own computer | Free (just electricity; the computer must stay on) |
| Small cloud host instead (Render / Railway / Fly.io / VPS) | About $0–7 per month, depending on the provider |
| **Claude API**: pay per use, billed separately from a Claude.ai subscription | See below |

Claude `claude-opus-5` costs $5 per million input tokens and $25 per million output tokens, and web searches cost $10 per 1,000. These are rough per-action estimates:

- drafting a plan: about **$0.03–0.10**
- a research step with a few searches: about **$0.20–0.60**
- a typical 4-step errand: about **$0.50–1.50**

Plain to-do use (no assistant) costs nothing.

**Built-in brakes:**
- `MONTHLY_BUDGET_USD` (default **$10**) and `TASK_BUDGET_USD` (default **$2**) stop the assistant once estimated spend reaches the cap.
- Settings shows this month's spend, and each task shows its own cost.
- Also set a spend limit in the Anthropic Console. That is the hard guarantee, because this app's figures are estimates.

**To lower cost:** set `CLAUDE_EFFORT=medium` or `low`, or `ENABLE_WEB_TOOLS=false` if you don't need browsing. Stopping a task stops its spending. You can switch model with `CLAUDE_MODEL`.

## Security

**From the internet**
- **Not exposed by default.** The server listens on `127.0.0.1` only. Reach it through **Tailscale** (recommended: only your own devices can connect) or a tunnel. Don't port-forward it on your router.
- **App token.** Every API call needs a 43-character random token (at least 20 characters if you set your own). The token is compared in constant time and only sent in a header, never in URLs or logs.
- **Brute-force lockout.** After 10 wrong tokens from one IP in 15 minutes, that IP is blocked and your phone gets an alert. After 100 wrong tokens in total, all sign-ins pause until the window clears.
- **Hardened web layer.**
  - Strict Content-Security-Policy (only the app's own scripts run), no framing, `nosniff`, no referrer, and HSTS on HTTPS.
  - All output is HTML-escaped.
  - Input size and shape are validated, and the request body is limited to 200 KB.
  - Errors don't include stack traces.
- **Data at rest.** `data/` is readable only by the server's user (0700 directory, 0600 files). The Docker image runs as a non-root user. `npm audit` reports 0 known vulnerabilities.

**Around Claude (what the assistant can and can't do)**
- **Approval gates.** Nothing runs until you approve the plan. Steps marked **asks first** need a second OK. **Every automation (webhook) call shows you its exact payload and waits for you to tap Allow.**
- **No open-ended powers.** The assistant can't run code, touch files, spend money, log in anywhere, or call any URL except the webhooks you name. Browsing goes through Anthropic's hosted web tools, which can only fetch URLs already present in the conversation. You can limit browsing to certain sites with `WEB_ALLOWED_DOMAINS`.
- **Prompt injection.** A malicious web page might try to instruct the assistant. The system prompt tells it to treat web content as information, not instructions. Even if a page did take over, it could only reach you (questions, notifications) or ask you to Allow an action.
- **Hard limits.** 30 turns per step, spend caps, and a **Stop** button that halts the task between actions.
- **Your data and Anthropic.** A task's text is sent to Anthropic's API only when you plan or run it with the assistant. Anthropic's commercial terms say API data isn't used to train models by default; check their current privacy policy for retention details. Mark sensitive tasks **🔒 Private** and they are never sent to Claude. Never put passwords or card numbers in tasks.
- **Alert privacy.** Notification text passes through Apple, Google, or ntfy. Set `ALERT_DETAILS=false` to send only "something needs you". If you use the public ntfy.sh server, choose a long random topic name, or protect it with `NTFY_TOKEN`.

**What's still on you**
- Keep the token secret. If your phone is lost, change `APP_TOKEN` (or delete `data/app-token.txt`) and restart.
- Keep Node, the OS, and dependencies updated (`npm audit`).
- Back up `data/`.

No software can promise to be impossible to break into. This setup keeps the attack surface small, puts it behind your private network, and makes sure nothing with real-world effects happens without your tap.

## Project layout

```
server/
  index.js    wires everything together and starts the server
  app.js      REST API + static files + live updates (SSE)
  runner.js   task state machine: planning, approval, running steps, reminders
  agent.js    Claude: plan generation (structured output) + per-step tool loop
  tools.js    what the assistant is allowed to do
  notify.js   web push + ntfy
  usage.js    spend estimates and budget caps
  db.js       JSON-file storage (data/db.json)
  config.js   env / .env loading
public/       the phone app (vanilla JS PWA + service worker)
test/         node:test suite with a scripted fake Claude client
```

Run the tests with `npm test`.
