import { loadConfig } from "./config.js";
import { Store } from "./db.js";
import { Notifier } from "./notify.js";
import { Agent } from "./agent.js";
import { Runner } from "./runner.js";
import { createApp } from "./app.js";

const config = loadConfig();
const store = new Store(config.dataDir);
const notifier = new Notifier({ store, ...config });
const agent = new Agent({ config, notifier });
const runner = new Runner({ store, agent, notifier });
const app = createApp({ config, store, runner, notifier, agent });

app.listen(config.port, () => {
  console.log(`Task Pilot running on http://localhost:${config.port}`);
  console.log(`App token (enter it on your phone): ${config.appToken}`);
  console.log(agent.enabled ? `Agent: on (${config.model})` : "Agent: OFF - set ANTHROPIC_API_KEY to let Claude plan and run tasks");
  console.log(config.ntfyTopic ? `ntfy alerts: ${config.ntfyServer}/${config.ntfyTopic}` : "ntfy alerts: off (set NTFY_TOPIC)");
  runner.start();
});
