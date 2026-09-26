// Spend tracking and hard caps for Claude API usage.
//
// Figures are estimates from list prices and the `usage` block on each
// response. Your Anthropic Console bill is the source of truth, so also set a
// spend limit there. This cap is the in-app backstop that stops runaway tasks.

// USD per million tokens (input, output), list prices.
const PRICES = {
  "claude-opus-5": [5, 25],
  "claude-opus-5-5": [4, 20],
  "claude-fable-5-1": [10, 50],
  "claude-sonnet-5": [2, 10],
  "claude-haiku-4-5": [1, 5],
};
const WEB_SEARCH_USD = 10 / 1000;

export class BudgetExceededError extends Error {}

export function estimateCostUsd(model, usage = {}) {
  const [inPrice, outPrice] = PRICES[model] ?? PRICES["claude-opus-5"];
  const m = 1_000_000;
  return (
    ((usage.input_tokens ?? 0) * inPrice +
      (usage.cache_creation_input_tokens ?? 0) * inPrice * 1.25 +
      (usage.cache_read_input_tokens ?? 0) * inPrice * 0.1 +
      (usage.output_tokens ?? 0) * outPrice) /
      m +
    (usage.server_tool_use?.web_search_requests ?? 0) * WEB_SEARCH_USD
  );
}

const monthKey = (d = new Date()) => d.toISOString().slice(0, 7);

export class UsageMeter {
  /** @param {{store: object, monthlyBudgetUsd: number, taskBudgetUsd: number}} opts  0 = no cap */
  constructor({ store, monthlyBudgetUsd, taskBudgetUsd }) {
    this.store = store;
    this.monthlyBudgetUsd = monthlyBudgetUsd;
    this.taskBudgetUsd = taskBudgetUsd;
    store.data.usage ??= {};
  }

  month() {
    return (this.store.data.usage[monthKey()] ??= { usd: 0, requests: 0 });
  }

  /** Throws before a request that would start over budget. */
  check(task) {
    const spent = this.month().usd;
    if (this.monthlyBudgetUsd > 0 && spent >= this.monthlyBudgetUsd) {
      throw new BudgetExceededError(
        `Monthly assistant budget of $${this.monthlyBudgetUsd.toFixed(2)} reached ($${spent.toFixed(2)} used). Raise MONTHLY_BUDGET_USD to continue.`,
      );
    }
    if (task && this.taskBudgetUsd > 0 && (task.costUsd ?? 0) >= this.taskBudgetUsd) {
      throw new BudgetExceededError(
        `This task hit its $${this.taskBudgetUsd.toFixed(2)} limit ($${task.costUsd.toFixed(2)} used). Raise TASK_BUDGET_USD or finish it yourself.`,
      );
    }
  }

  record(task, model, usage) {
    const usd = estimateCostUsd(model, usage);
    const month = this.month();
    month.usd += usd;
    month.requests += 1;
    if (task) task.costUsd = (task.costUsd ?? 0) + usd;
    return usd;
  }

  summary() {
    const m = this.month();
    return { month: monthKey(), usd: m.usd, requests: m.requests, monthlyBudgetUsd: this.monthlyBudgetUsd, taskBudgetUsd: this.taskBudgetUsd };
  }
}
