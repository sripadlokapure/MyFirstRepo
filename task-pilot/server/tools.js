// What the agent is allowed to do while working on a step.
//
// The agent can only act through the tools listed here, so this file is the
// place to widen (or narrow) what "autonomous" means for you. To add a
// capability, add an entry in `buildCustomTools` with a JSON schema and a
// `run` function; the model sees `name`, `description` and `input_schema`.
// Set `needsApproval: true` on anything with side effects so each call waits
// for your OK on the phone.

/** Control tools: these change the flow of the run rather than doing work. */
export const CONTROL_TOOLS = {
  complete_step: {
    name: "complete_step",
    description:
      "Call when the current step is finished. `summary` is shown to the user as the step's result, so include the concrete outcome (facts found, links, what was sent).",
    input_schema: {
      type: "object",
      properties: { summary: { type: "string", description: "What was done and the outcome." } },
      required: ["summary"],
      additionalProperties: false,
    },
  },
  fail_step: {
    name: "fail_step",
    description:
      "Call when the step cannot be completed with the tools available (e.g. it needs a login, a payment, or a physical action). Explain what the user needs to do instead.",
    input_schema: {
      type: "object",
      properties: { reason: { type: "string" } },
      required: ["reason"],
      additionalProperties: false,
    },
  },
  ask_user: {
    name: "ask_user",
    description:
      "Ask the user a question and pause until they answer from their phone. Use when a choice, preference, or missing detail blocks progress. Do not use it for things you can find out yourself.",
    input_schema: {
      type: "object",
      properties: { question: { type: "string" } },
      required: ["question"],
      additionalProperties: false,
    },
  },
};

/**
 * Build the tools that do real work. `ctx` gives access to the notifier and
 * the current task so tools can report back.
 */
export function buildCustomTools(ctx) {
  const tools = [
    {
      name: "notify_user",
      description:
        "Send a push notification to the user's phone without pausing, e.g. a heads-up or an interim finding worth knowing now.",
      input_schema: {
        type: "object",
        properties: { message: { type: "string" } },
        required: ["message"],
        additionalProperties: false,
      },
      run: async ({ message }) => {
        await ctx.notifier.send({ title: ctx.task.title, body: message, taskId: ctx.task.id });
        return "Notification sent.";
      },
    },
  ];

  // Named webhooks let the agent trigger real-world automations you have
  // already set up (Zapier, Make, IFTTT, Home Assistant, n8n, your own API...).
  // It can only call the names you configure, never arbitrary URLs.
  const hooks = ctx.config.webhooks;
  const names = Object.keys(hooks);
  if (names.length > 0) {
    tools.push({
      name: "call_webhook",
      // You approve each call on your phone (payload shown) unless you turn
      // this off with WEBHOOKS_REQUIRE_APPROVAL=false.
      needsApproval: ctx.config.webhooksRequireApproval !== false,
      description:
        "Trigger one of the user's pre-configured automations by name with a JSON payload. Available: " +
        names.map((n) => `"${n}"`).join(", ") +
        ".",
      input_schema: {
        type: "object",
        properties: {
          name: { type: "string", enum: names },
          payload: { type: "object", description: "JSON body sent to the automation." },
        },
        required: ["name"],
        additionalProperties: false,
      },
      run: async ({ name, payload }) => {
        const url = hooks[name];
        if (!url) throw new Error(`Unknown webhook "${name}"`);
        const res = await ctx.fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload ?? {}),
          signal: AbortSignal.timeout(30_000),
        });
        const text = (await res.text()).slice(0, 4000);
        if (!res.ok) throw new Error(`Webhook "${name}" returned ${res.status}: ${text}`);
        return `Webhook "${name}" returned ${res.status}. ${text}`;
      },
    });
  }

  return tools;
}

/** Anthropic-hosted tools: they run on Anthropic's side, no code needed here. */
export function serverTools(config) {
  if (!config.enableWebTools) return [];
  // Optionally confine browsing to (or away from) specific sites. The API
  // accepts one list or the other, not both.
  const scope = config.webAllowedDomains?.length
    ? { allowed_domains: config.webAllowedDomains }
    : config.webBlockedDomains?.length
      ? { blocked_domains: config.webBlockedDomains }
      : {};
  return [
    { type: "web_search_20260209", name: "web_search", max_uses: 10, ...scope },
    // web_fetch can only open URLs that already appear in the conversation.
    { type: "web_fetch_20260209", name: "web_fetch", max_uses: 10, max_content_tokens: 50_000, ...scope },
  ];
}
