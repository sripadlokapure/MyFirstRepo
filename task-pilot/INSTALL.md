# Install Task Pilot on your desktop

This guide sets up the Task Pilot server on your own Windows PC or Mac and connects your phone to it. You don't need to be a programmer. It takes about 20 minutes, and you only do it once.

**What you'll end up with**
- The Task Pilot server running on your computer. You start it by double-clicking a file, and it can start by itself when you log in.
- Task Pilot as an app on your computer and your phone, each with its own icon and window and no browser bars.
- Phone alerts for approvals, questions, and due dates.

**What it costs**

| Item | Cost |
| --- | --- |
| Everything in this guide | Free |
| Claude assistant (optional) | Pay per use, capped at $10/month by default. See [README → Cost](README.md#cost). |

---

## Contents
1. [Install Node.js](#1-install-nodejs)
2. [Download Task Pilot](#2-download-task-pilot)
3. [First start and settings](#3-first-start-and-settings)
4. [Open it on this computer as an app](#4-open-it-on-this-computer-as-an-app)
5. [Connect your phone with Tailscale](#5-connect-your-phone-with-tailscale)
6. [Install on your phone and turn on alerts](#6-install-on-your-phone-and-turn-on-alerts)
7. [Start automatically and keep it awake](#7-start-automatically-and-keep-it-awake)
8. [Everyday use, updating, backup](#8-everyday-use-updating-backup)
9. [Troubleshooting](#9-troubleshooting)

---

## 1. Install Node.js

Node.js is the free program that runs the Task Pilot server.

1. Go to **https://nodejs.org**.
2. Download the version marked **LTS**.
3. Run the installer and accept the defaults (keep clicking **Next** or **Continue**).
4. Restart your computer. This makes sure the start scripts can find Node.js.

---

## 2. Download Task Pilot

1. Go to **https://github.com/sripadlokapure/MyFirstRepo**.
2. Click the green **Code** button, then **Download ZIP**.
3. Unzip it:
   - **Windows:** right-click the ZIP → **Extract All…** → choose `Documents` → **Extract**. Don't run anything from inside the ZIP without extracting it first.
   - **Mac:** double-click the ZIP in Downloads, then drag the new folder into `Documents`.
4. Open the folder `MyFirstRepo-master` → `task-pilot`. Everything below happens in this **task-pilot** folder.

> Know git? You can run `git clone https://github.com/sripadlokapure/MyFirstRepo.git` instead. That makes updating easier (see [section 8](#8-everyday-use-updating-backup)).

---

## 3. First start and settings

### Start it

- **Windows:** double-click **`start-windows.bat`**.
  - If Windows shows *"Windows protected your PC"*, click **More info** → **Run anyway**.
- **Mac:** double-click **`start-mac.command`**.
  - If macOS says it *"cannot be opened because it is from an unidentified developer"*, open **System Settings → Privacy & Security**, scroll down, and click **Open Anyway** next to `start-mac.command`. On older macOS, right-click the file → **Open** → **Open**.

The first time, the script does two things:
1. It installs what Task Pilot needs. This takes about a minute.
2. It creates your settings file, **`.env`**, and opens it in Notepad (Windows) or TextEdit (Mac).

### Fill in the settings

Each setting goes right after its `=` sign, with no spaces or quotes. Lines starting with `#` are optional.

| Setting | What to put | Needed? |
| --- | --- | --- |
| `ANTHROPIC_API_KEY=` | Your Claude API key. Create one at **https://console.anthropic.com** → API Keys. You'll need to add a payment method there, and it's a good idea to also set a monthly spend limit under Settings → Limits. | Only for the assistant. Leave it empty to use Task Pilot as a to-do list with reminders. |
| `NTFY_TOPIC=` | A long made-up name for phone alerts, e.g. `sripad-tasks-8f3k2x9q7m`. Treat it like a password. | Recommended; it's the simplest way to get alerts |
| `MONTHLY_BUDGET_USD=` / `TASK_BUDGET_USD=` | Spending caps for the assistant (already set to 10 and 2) | Already set |
| `APP_TOKEN=` | **Leave empty.** A strong password is generated for you. | No |
| `PUBLIC_URL=` | Fill in later, in [step 5](#5-connect-your-phone-with-tailscale). | Later |

Save the file (**Ctrl+S** or **⌘S**) and close the editor.

### Start it for real

Double-click **`start-windows.bat`** or **`start-mac.command`** again. A window appears showing something like:

```
Task Pilot running on http://127.0.0.1:3000
App token (enter it on your phone): sb_z2rzmWBE...
Agent: on (claude-opus-5)
Spend caps: $10.00/month, $2.00/task
```

**Copy the app token and keep it safe.** It's the password for your Task Pilot. It's also saved in `task-pilot/data/app-token.txt` if you need it again.

Keep this window open. You can minimise it. Closing it stops Task Pilot.

---

## 4. Open it on this computer as an app

1. Open **Google Chrome** or **Microsoft Edge** and go to **http://localhost:3000**.
2. Enter your app token.
3. Click the **Install** icon at the right end of the address bar (a screen with a down-arrow). You can also use the menu: **⋮ → Cast, save and share → Install page as app** in Chrome, or **… → Apps → Install this site as an app** in Edge.

Task Pilot now has its own window and its own icon in the Start menu (Windows) or Launchpad/Dock (Mac). From now on, open it like any other app.

> Safari on Mac: use **File → Add to Dock** instead.

---

## 5. Connect your phone with Tailscale

For safety, Task Pilot only accepts connections from the computer it runs on. **Tailscale** creates a private, encrypted link between your own devices, so your phone can reach it without exposing it to the internet. The personal plan is free.

1. **Install Tailscale on your computer:** https://tailscale.com/download. Sign in with Google, Microsoft, or Apple.
2. **Install Tailscale on your phone** from the App Store or Play Store, and sign in with **the same account**. Switch it **on**.
3. **Share Task Pilot with your devices.** Open a terminal (see the note below) and run the command for your computer:
   - **Windows (PowerShell):**
     ```powershell
     tailscale serve --bg 3000
     ```
     If it says *"tailscale is not recognized"*, run this instead:
     ```powershell
     & "C:\Program Files\Tailscale\tailscale.exe" serve --bg 3000
     ```
   - **Mac (Terminal):**
     ```bash
     /Applications/Tailscale.app/Contents/MacOS/Tailscale serve --bg 3000
     ```

   The first time you do this, Tailscale may show a link asking you to **enable HTTPS** for your account. Open it, click **Enable**, and run the command again.

   It then prints your private address, something like:
   ```
   https://your-computer.tail1234.ts.net
   ```
   `--bg` makes Tailscale remember this setting after restarts, so you only do it once.

4. **Tell Task Pilot its address.** Open `.env` again (Notepad: right-click → Open with → Notepad; Mac: right-click → Open With → TextEdit). Set:
   ```
   PUBLIC_URL=https://your-computer.tail1234.ts.net
   ```
   Save the file. Then close the Task Pilot window and double-click the start file again.

> **How to open a terminal:** On **Windows**, press the Windows key, type `PowerShell`, and press Enter. On a **Mac**, press ⌘+Space, type `Terminal`, and press Enter.

---

## 6. Install on your phone and turn on alerts

Tailscale must be switched **on** on your phone.

**iPhone (iOS 16.4 or later)**
1. Open your `https://…ts.net` address in **Safari** and enter the app token.
2. Tap **Share** (the square with an arrow) → **Add to Home Screen** → **Add**.
3. Open **Task Pilot from the home screen** (not from Safari), then tap **⚙︎ → Enable notifications** → **Allow**.

**Android**
1. Open your `https://…ts.net` address in **Chrome** and enter the app token.
2. Tap **Install app** when prompted, or **⋮ → Add to Home screen → Install**.
3. Open Task Pilot, then tap **⚙︎ → Enable notifications** → **Allow**.

**ntfy alerts (recommended backup, works on any phone)**
1. Install the free **ntfy** app from the App Store or Play Store.
2. Tap **+** (Subscribe to topic) and enter the exact `NTFY_TOPIC` name from your `.env`.

**Test it:** in Task Pilot tap **⚙︎ → Send test**. You should get a notification within a few seconds.

---

## 7. Start automatically and keep it awake

Task Pilot can only work, send reminders, and answer your phone while your computer is **on, awake, and running the start script**.

### Start when you log in

- **Windows**
  1. Press **Windows + R**, type `shell:startup`, and press Enter. A folder opens.
  2. In another window, right-click **`start-windows.bat`** → **Show more options** → **Create shortcut**.
  3. Drag the new shortcut into the Startup folder.
- **Mac**
  1. Open **System Settings → General → Login Items**.
  2. Under *Open at Login*, click **+** and choose **`start-mac.command`**.

Tailscale starts with your computer by default, so there's nothing more to set up for it.

### Stop the computer from sleeping

- **Windows:** go to Settings → System → **Power & battery** → **Screen and sleep**, and set *"When plugged in, put my device to sleep after"* to **Never**. The screen can still turn off; that's fine.
- **Mac:** the start script already keeps the Mac awake while it runs. For a MacBook, keep it plugged in. Closing the lid still puts it to sleep unless it's connected to an external display.

---

## 8. Everyday use, updating, backup

- **Use it:** open the Task Pilot app on your computer or phone. The server window just needs to be running, and it can stay minimised.
- **Stop it:** close the server window.
- **Your data** lives in `task-pilot/data/`. That folder holds your tasks, your app token, and the notification keys.
- **Back up** by copying the `data` folder and your `.env` file somewhere safe now and then.
- **Update to a newer version:**
  1. Close the server window.
  2. Download the new ZIP (as in [step 2](#2-download-task-pilot)) and extract it.
  3. Copy your old **`data`** folder and **`.env`** into the new `task-pilot` folder.
  4. Delete the new folder's `node_modules` folder, if there is one, so the script reinstalls cleanly.
  5. Start it with the new start file. If you set up auto-start, update the shortcut or login item to point at the new file.

  If you used git, just run `git pull` inside the folder, then delete `node_modules` and start again.
- **Lost your phone?** Delete `data/app-token.txt` (or set a new `APP_TOKEN`) and restart. That signs out every device, and you sign in again with the new token. Also remove the lost phone from your Tailscale account at https://login.tailscale.com.

---

## 9. Troubleshooting

| Problem | Fix |
| --- | --- |
| *"Node.js is not installed"*, but you installed it | Restart the computer, then try again. |
| The window flashes and closes (Windows) | Right-click `start-windows.bat` → **Edit** to check it's the right file. Or open PowerShell in the `task-pilot` folder (Shift + right-click the folder → **Open in Terminal**) and run `.\start-windows.bat` to see the error. |
| Mac: `start-mac.command` opens in a text editor, or says you don't have permission | In Terminal, type `chmod +x ` (with a space at the end), drag `start-mac.command` into the Terminal window, and press Enter. Then double-click it again. |
| *"APP_TOKEN must be at least 20 characters"* | Make `APP_TOKEN=` empty in `.env` and restart. |
| *"address already in use"* | Task Pilot is already running in another window. Close the extra one. You can also change `PORT=` in `.env`, but then use the new number in the `tailscale serve` command too. |
| Phone can't open the `ts.net` address | Make sure Tailscale is **on** on the phone and the computer, the computer is awake, and the server window is open. Run `tailscale serve status` on the computer; it should list port 3000. |
| No notifications on iPhone | You must open Task Pilot **from the home screen icon**, not Safari, before enabling notifications. Also check iPhone Settings → Notifications → Task Pilot. Or use ntfy. |
| *"Too many failed sign-in attempts"* | Wait 15 minutes, then enter the token carefully. If you didn't cause it, someone else tried, and that attempt was blocked. |
| The assistant says the budget has been reached | Raise `MONTHLY_BUDGET_USD` or `TASK_BUDGET_USD` in `.env` and restart. Or wait for next month. |
| *"The assistant is off"* banner | `ANTHROPIC_API_KEY` is empty or missing in `.env`. Add it and restart. |

Still stuck? Copy the text from the server window and ask for help. Remove your app token and API key before sharing it.
