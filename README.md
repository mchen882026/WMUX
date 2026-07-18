# wmux

Run several AI coding agents (Claude Code, Codex, Gemini CLI — anything that lives in a terminal) **in parallel on Windows**, each on its own task, without losing track of which one needs you. A Windows take on [cmux](https://cmux.com), which is macOS-only. Ships as a normal desktop app with a one-click installer.

One window, four ideas:

1. **A sidebar of workspaces.** Each workspace is one task running one agent, with its status dot, git branch, and the last line it printed.
2. **Attention rings.** When an agent finishes, fails, or waits on your input, its dot turns amber and rings, and a desktop notification fires. Work on something else; respond when pinged.
3. **Worktree isolation.** Each task gets its own copy of the repo (a *git worktree*) on branch `wmux/<task>`, so parallel agents never edit the same files. A **changes** button shows what each one touched before you merge.
4. **tmux optionality.** Native-mode agents stop when you quit the app. Flip a workspace to **tmux mode** and the session lives inside tmux (in WSL) instead — quit, reboot, come back, still running. wmux reattaches automatically on launch.

Closing the window hides wmux to the tray (by the clock); agents keep going. Quit from the tray menu. Workspaces persist across restarts — native ones come back as *stopped* with a **restart agent** button.

## For people installing it

Download `wmux Setup x.x.x.exe` from the Releases page and double-click. No other software to install — except the agent itself: wmux is the cockpit, not the pilot, so you need [Claude Code](https://claude.com/claude-code) (or another agent CLI) and [Git for Windows](https://git-scm.com) installed. The footer of the app shows a live ✓/✗ check for both.

**About the blue "Windows protected your PC" screen:** until the installer is code-signed (see below), Windows SmartScreen warns on any new unsigned program. Click **More info → Run anyway**. This is expected for unsigned software and goes away once signing is set up.

First run: click **+ new workspace**, type a task title, hit **Browse…** to pick your repo folder, leave the agent as `claude`, create. Type to the agent like a normal terminal.

## For the developer (building the installer)

You never build the installer here in a chat sandbox — you build it in one of two places:

**Option A — GitHub does it for you (recommended).** Push this folder to a GitHub repo. The included workflow (`.github/workflows/build-installer.yml`) runs on GitHub's cloud Windows machines: go to **Actions → Build Windows installer → Run workflow**, wait ~5 minutes, download the `.exe` from the run's artifacts. Tagging a version (`git tag v0.2.0 && git push --tags`) additionally publishes it to a GitHub Release.

**Option B — build on your own Windows PC.** With Node LTS installed:

```powershell
npm install
npm run dist
```

The installer lands in `dist\wmux Setup 0.2.0.exe`. (First build downloads Electron, ~100 MB — one time.) To just run the app during development: `npm start`. To run only the server and use it in a browser: `npm run server`.

## Going genuinely commercial: the checklist

**Code signing** (removes the SmartScreen warning; effectively required to distribute widely). Cheapest modern route: **Azure Trusted Signing** (~$10/month) or a standard OV certificate (~$100–400/yr). electron-builder signs automatically once you set the standard signing environment variables in the GitHub Actions workflow — see electron-builder's "Code Signing" docs. Unsigned is fine for you + friends; signed is table stakes for strangers.

**Auto-update.** Already wired via electron-updater: fill in your GitHub username in the `publish` block of `package.json`, publish releases via the tag workflow, and installed copies will self-update. Requires signing to work smoothly.

**Name.** "wmux" deliberately echoes cmux. Fine for a personal tool; if you ever charge money, pick a distinct name and swap `productName`/`appId` in `package.json` to avoid brand-confusion complaints. (No code was taken from cmux — only the concept — so its GPL license doesn't apply here.)

**A license decision.** Currently MIT (do-anything open source). Selling it usually means switching LICENSE to proprietary terms and adding an in-app EULA before v1.

## Jargon, in plain English

*Electron* — a framework that wraps a web app plus its own private copy of Node.js into a normal desktop program; VS Code and Slack are Electron apps. *NSIS installer* — the standard one-click Windows setup wizard electron-builder produces. *Code signing* — a paid certificate that cryptographically proves who published an app, which is what silences SmartScreen. *Tray* — the icon area by the Windows clock. *CI (GitHub Actions)* — cloud machines that build your software automatically on every push. *pty / ConPTY* — the plumbing that lets an app host a real terminal inside itself. *tmux* — a Linux tool that keeps terminal sessions alive in the background. *WSL* — a real Linux environment inside Windows. *git worktree* — a second working copy of the same repository in a different folder.

## Scripting it

The app is also an API on `http://localhost:7777` (falls back to a free port if busy):

```powershell
$repo = "C:\Users\you\code\myproject"
foreach ($t in "write tests","update readme","fix flaky login") {
  Invoke-RestMethod -Method Post -Uri http://localhost:7777/api/workspaces `
    -ContentType "application/json" `
    -Body (@{ title=$t; repo=$repo; agent="claude"; backend="tmux"; useWorktree=$true } | ConvertTo-Json)
}
(Invoke-RestMethod http://localhost:7777/api/workspaces) | Select-Object title, status, branch, lastLine
```

## Troubleshooting

Blank window on launch → the server likely failed; run `npm run server` in the folder to see the error. `npm install` fails on node-pty (dev builds only) → install "Visual Studio Build Tools" with the **Desktop development with C++** workload and retry; end users never face this because the installer ships it prebuilt. tmux mode blank → confirm `wsl -e tmux -V` works and the agent is installed *inside* WSL (it's a separate install from the Windows one). Status shows "needs you" during a long quiet build → that's the 6-second-silence heuristic; the terminal bell is the reliable signal. The server binds to 127.0.0.1 only — nothing else on your network can reach it.
