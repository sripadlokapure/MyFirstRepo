import { loadConfig } from "./config.js";
import { Store } from "./db.js";
import { Notifier } from "./notify.js";
import { Agent } from "./agent.js";
import { Runner } from "./runner.js";
import { UsageMeter } from "./usage.js";
import { createApp } from "./app.js";

const config = loadConfig();
const store = new Store(config.dataDir);
const notifier = new Notifier({ store, ...config });
const meter = new UsageMeter({ store, ...config });
const agent = new Agent({ config, notifier, meter });
const runner = new Runner({ store, agent, notifier });
const app = createApp({ config, store, runner, notifier, agent, meter });

app.listen(config.port, config.host, () => {
  console.log(`Task Pilot running on http://${config.host}:${config.port}`);
  console.log(`App token (enter it on your phone): ${config.appToken}`);
  console.log(agent.enabled ? `Agent: on (${config.model})` : "Agent: OFF - set ANTHROPIC_API_KEY to let Claude plan and run tasks");
  const cap = (v) => (v > 0 ? `$${v.toFixed(2)}` : "none");
  console.log(`Spend caps: ${cap(config.monthlyBudgetUsd)}/month, ${cap(config.taskBudgetUsd)}/task`);
  console.log(config.ntfyTopic ? `ntfy alerts: ${config.ntfyServer}/${config.ntfyTopic}` : "ntfy alerts: off (set NTFY_TOPIC)");
  runner.start();
});
