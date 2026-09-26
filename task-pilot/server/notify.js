// Phone alerts. Two independent channels, use either or both:
//  1. Web Push  - native notifications from the installed app (PWA).
//  2. ntfy.sh   - install the free "ntfy" app, subscribe to your topic. Most
//                 reliable option on iPhone and needs no HTTPS setup.
import fs from "node:fs";
import path from "node:path";
import webpush from "web-push";

export class Notifier {
  constructor({ store, dataDir, publicUrl, ntfyTopic, ntfyServer, vapidSubject, fetchImpl = fetch }) {
    this.store = store;
    this.publicUrl = publicUrl;
    this.ntfyTopic = ntfyTopic;
    this.ntfyServer = (ntfyServer || "https://ntfy.sh").replace(/\/$/, "");
    this.fetch = fetchImpl;
    this.vapid = loadOrCreateVapidKeys(dataDir);
    webpush.setVapidDetails(vapidSubject || "mailto:task-pilot@example.com", this.vapid.publicKey, this.vapid.privateKey);
  }

  get vapidPublicKey() {
    return this.vapid.publicKey;
  }

  /**
   * @param {{title: string, body: string, taskId?: string, urgent?: boolean, tag?: string}} msg
   */
  async send(msg) {
    const url = msg.taskId ? `${this.publicUrl || ""}/#/task/${msg.taskId}` : `${this.publicUrl || ""}/`;
    const jobs = [this.#sendWebPush({ ...msg, url })];
    if (this.ntfyTopic) jobs.push(this.#sendNtfy({ ...msg, url }));
    await Promise.allSettled(jobs);
  }

  async #sendWebPush(msg) {
    const payload = JSON.stringify({ title: msg.title, body: msg.body, url: msg.url, tag: msg.tag ?? msg.taskId });
    for (const sub of [...this.store.data.subscriptions]) {
      try {
        await webpush.sendNotification(sub, payload, { urgency: msg.urgent ? "high" : "normal", TTL: 24 * 3600 });
      } catch (err) {
        // 404/410 = the phone unsubscribed or the app was removed.
        if (err.statusCode === 404 || err.statusCode === 410) this.store.removeSubscription(sub.endpoint);
        else console.warn("[notify] web push failed:", err.statusCode ?? err.message);
      }
    }
  }

  async #sendNtfy(msg) {
    try {
      const headers = { Title: asciiHeader(msg.title), Priority: msg.urgent ? "high" : "default", Tags: "clipboard" };
      if (this.publicUrl) headers.Click = msg.url;
      const res = await this.fetch(`${this.ntfyServer}/${encodeURIComponent(this.ntfyTopic)}`, {
        method: "POST",
        headers,
        body: msg.body,
      });
      if (!res.ok) console.warn("[notify] ntfy responded", res.status);
    } catch (err) {
      console.warn("[notify] ntfy failed:", err.message);
    }
  }
}

// HTTP headers must be ASCII; ntfy also accepts the title in the body but this is simpler.
const asciiHeader = (s) => String(s).replace(/[^\x20-\x7E]/g, "?").slice(0, 200);

function loadOrCreateVapidKeys(dataDir) {
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    return { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
  }
  const file = path.join(dataDir, "vapid.json");
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
  const keys = webpush.generateVAPIDKeys();
  fs.writeFileSync(file, JSON.stringify(keys, null, 2), { mode: 0o600 });
  return keys;
}
