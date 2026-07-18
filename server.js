/**
 * wmux — run multiple AI coding agents in parallel on Windows.
 *
 * One Node.js process that:
 *   1. Spawns each agent (Claude Code, Codex, etc.) inside its own real
 *      terminal session (a "pty" — pseudo-terminal — the same mechanism
 *      VS Code's built-in terminal uses; on Windows this rides on ConPTY).
 *   2. Serves a browser dashboard (public/index.html) showing every
 *      workspace in a sidebar with cmux-style status rings.
 *   3. Optionally isolates each task in its own git worktree (a second
 *      working copy of the same repo, so agents don't overwrite each other).
 *   4. Optionally runs each session inside tmux (via WSL) so agents keep
 *      running even if you close the app. That's the "tmux optionality."
 *
 * The workspace list is saved to disk (WMUX_DATA folder) and restored on
 * launch: tmux-backed workspaces reattach automatically; native ones come
 * back as "stopped" with a restart button.
 *
 * Runs two ways: embedded inside the Electron desktop app (electron/main.js
 * calls start()), or standalone via `npm run server`.
 */

const http = require("http");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { execFileSync, spawnSync, execFile } = require("child_process");

const express = require("express");
const { WebSocketServer } = require("ws");

// node-pty is a native module (it contains compiled C++). If the install
// step failed, give a plain-English pointer instead of a cryptic stack.
let pty;
try {
  pty = require("node-pty");
} catch (e) {
  console.error(
    "\n[wmux] Could not load node-pty (the terminal engine).\n" +
      "Run `npm install` in this folder first. If that fails on Windows,\n" +
      "install 'Visual Studio Build Tools' with the 'Desktop development\n" +
      "with C++' workload, then run `npm install` again.\n"
  );
  process.exit(1);
}

const IS_WIN = process.platform === "win32";
const PREFERRED_PORT = Number(process.env.WMUX_PORT || 7777);
const DATA_DIR = process.env.WMUX_DATA || __dirname;
const STATE_FILE = path.join(DATA_DIR, "wmux-state.json");
const SCROLLBACK_CAP = 200_000; // characters of terminal history kept per workspace

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Run a command, return trimmed stdout, or "" on failure. */
function run(cmd, args, opts = {}) {
  try {
    const out = execFileSync(cmd, args, { encoding: "utf8", ...opts });
    // wsl.exe sometimes emits UTF-16 / stray NULs when it prints its own
    // messages; strip NULs and carriage returns defensively.
    return out.replace(/\u0000/g, "").replace(/\r/g, "").trim();
  } catch {
    return "";
  }
}

/** True if an executable is on PATH. */
function has(cmd) {
  const probe = IS_WIN ? spawnSync("where.exe", [cmd]) : spawnSync("which", [cmd]);
  return probe.status === 0;
}

/** True if a tmux session of this name is alive inside WSL. */
function tmuxAlive(name) {
  if (!has("wsl")) return false;
  return spawnSync("wsl.exe", ["-e", "tmux", "has-session", "-t", name]).status === 0;
}

/** Turn "Fix login bug!" into "fix-login-bug". */
function slugify(s) {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "task"
  );
}

/** git in a specific directory; returns "" on error. */
function git(dir, args) {
  return run("git", ["-C", dir, ...args]);
}

/** Convert a Windows path (C:\...) to its WSL path (/mnt/c/...). */
function toWslPath(winPath) {
  return run("wsl.exe", ["-e", "wslpath", "-a", winPath]);
}

/** Strip ANSI color/control codes so we can show a clean "last line" preview. */
function stripAnsi(s) {
  return s
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "") // OSC sequences (titles, links)
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "") // CSI sequences (colors, cursor)
    .replace(/\x1b[@-_]/g, "") // other escapes
    .replace(/\r/g, "");
}

/** Pick the shell for the Windows-native backend. */
function nativeShell() {
  if (!IS_WIN) return { file: "bash", args: (cmd) => ["-lc", cmd] }; // dev fallback
  const file = has("pwsh") ? "pwsh.exe" : "powershell.exe";
  return { file, args: (cmd) => ["-NoLogo", "-NoExit", "-Command", cmd] };
}

// ---------------------------------------------------------------------------
// Workspaces
// ---------------------------------------------------------------------------

/**
 * A workspace = one task = one terminal running one agent.
 * status: running | attention | done | error | stopped
 * The restorable fields below are written to WMUX_DATA/wmux-state.json.
 */
const workspaces = new Map();

function restorable(w) {
  return {
    id: w.id,
    title: w.title,
    slug: w.slug,
    repo: w.repo,
    dir: w.dir,
    agent: w.agent,
    backend: w.backend,
    isWorktree: w.isWorktree,
    baseRef: w.baseRef,
    tmuxSession: w.tmuxSession,
    createdAt: w.createdAt,
  };
}

function saveState() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(
      STATE_FILE,
      JSON.stringify([...workspaces.values()].map(restorable), null, 2)
    );
  } catch (e) {
    console.error("[wmux] could not save state:", e.message);
  }
}

function loadState() {
  let specs = [];
  try {
    specs = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return; // first run
  }
  for (const s of specs) {
    if (!s.dir || !fs.existsSync(s.dir)) continue; // folder gone — drop it
    const w = {
      ...s,
      status: "stopped",
      ring: false,
      lastLine: "",
      lastActive: Date.now(),
      buffer: "",
      sockets: new Set(),
      alive: false,
      proc: null,
    };
    // A tmux session may have kept working the whole time — reattach quietly.
    if (w.backend === "tmux" && w.tmuxSession && tmuxAlive(w.tmuxSession)) {
      try {
        spawnProc(w);
      } catch {}
    }
    workspaces.set(w.id, w);
  }
}

function publicView(w) {
  return {
    id: w.id,
    title: w.title,
    slug: w.slug,
    dir: w.dir,
    repo: w.repo,
    branch: git(w.dir, ["rev-parse", "--abbrev-ref", "HEAD"]) || "?",
    backend: w.backend,
    agent: w.agent,
    status: w.status,
    ring: w.ring, // true => the UI should "ring" (pulse) for attention
    lastLine: w.lastLine,
    tmuxSession: w.tmuxSession || null,
    isWorktree: w.isWorktree,
    baseRef: w.baseRef,
    createdAt: w.createdAt,
    alive: w.alive,
  };
}

/** Spawn (or respawn) the terminal process for a workspace. */
function spawnProc(w) {
  if (w.backend === "tmux") {
    if (!has("wsl")) throw new Error("WSL not found. Install WSL, or use the native backend.");
    const wslDir = toWslPath(w.dir);
    if (!wslDir) throw new Error("Could not translate the folder path for WSL.");
    w.tmuxSession = w.tmuxSession || `wmux-${w.slug}`;
    // -A = attach if the session already exists, otherwise create it and run
    // the agent. On reattach the agent command is ignored, which is exactly
    // what we want: the old session (and agent) is still there.
    const args = ["-e", "tmux", "new-session", "-A", "-s", w.tmuxSession, "-c", wslDir];
    if (w.agent) args.push(w.agent);
    w.proc = pty.spawn("wsl.exe", args, ptyOpts(w.dir));
  } else {
    const sh = nativeShell();
    w.proc = pty.spawn(sh.file, sh.args(w.agent || ""), ptyOpts(w.dir));
  }
  w.alive = true;
  w.status = "running";
  w.ring = false;
  w.lastActive = Date.now();
  wireProc(w);
}

function createWorkspace(opts) {
  const { title, repo, agent, backend, useWorktree, base } = opts;

  if (!repo || !fs.existsSync(repo)) {
    throw new Error(`Folder not found: ${repo}`);
  }
  if (git(repo, ["rev-parse", "--is-inside-work-tree"]) !== "true") {
    throw new Error(`Not a git repository: ${repo}`);
  }

  const slug = slugify(title);
  const id = crypto.randomBytes(5).toString("hex");
  const baseRef = git(repo, ["rev-parse", "--short", "HEAD"]) || "HEAD";

  // 1. Decide where the agent works.
  let dir = repo;
  let isWorktree = false;
  if (useWorktree) {
    const nest = path.join(path.dirname(repo), path.basename(repo) + ".wmux");
    fs.mkdirSync(nest, { recursive: true });
    dir = path.join(nest, slug);
    if (fs.existsSync(dir)) {
      // Reuse an existing worktree of the same name (e.g. recreating a
      // task) instead of erroring.
      isWorktree = true;
    } else {
      try {
        execFileSync(
          "git",
          ["-C", repo, "worktree", "add", "-b", `wmux/${slug}`, dir, base || "HEAD"],
          { encoding: "utf8" }
        );
        isWorktree = true;
      } catch (e) {
        throw new Error(
          `git worktree failed: ${String(e.stderr || e.message).trim()}`
        );
      }
    }
  }

  // 2. Spawn the terminal.
  const w = {
    id,
    title,
    slug,
    repo,
    dir,
    agent,
    backend,
    isWorktree,
    baseRef,
    createdAt: Date.now(),
    status: "running",
    ring: false,
    lastLine: "",
    lastActive: Date.now(),
    buffer: "",
    sockets: new Set(),
    alive: true,
    proc: null,
    tmuxSession: null,
  };

  spawnProc(w);
  workspaces.set(id, w);
  saveState();
  return w;
}

function ptyOpts(cwd) {
  return {
    name: "xterm-256color",
    cols: 120,
    rows: 32,
    cwd,
    env: process.env,
  };
}

function wireProc(w) {
  w.proc.onData((data) => {
    // Keep history so the screen restores when you switch tabs / reconnect.
    w.buffer += data;
    if (w.buffer.length > SCROLLBACK_CAP) w.buffer = w.buffer.slice(-SCROLLBACK_CAP);

    // Sidebar preview: last non-empty, de-ANSI'd line.
    const clean = stripAnsi(data);
    const lines = clean.split("\n").map((l) => l.trim()).filter(Boolean);
    if (lines.length) w.lastLine = lines[lines.length - 1].slice(0, 80);

    // Bell (\x07 outside of title sequences) = the agent is asking for you.
    if (clean.includes("\x07")) {
      w.status = "attention";
      w.ring = true;
    } else if (w.status !== "attention") {
      w.status = "running";
    }
    w.lastActive = Date.now();

    for (const ws of w.sockets) {
      if (ws.readyState === 1) ws.send(JSON.stringify({ t: "d", d: data }));
    }
  });

  w.proc.onExit(({ exitCode }) => {
    w.alive = false;
    w.status = exitCode === 0 ? "done" : "error";
    w.ring = true;
    for (const ws of w.sockets) {
      if (ws.readyState === 1)
        ws.send(JSON.stringify({ t: "exit", code: exitCode }));
    }
  });
}

// If an agent has been silent for a while, it's usually sitting at a prompt
// waiting for you — flag it. (Heuristic; the bell above is the reliable signal.)
setInterval(() => {
  for (const w of workspaces.values()) {
    if (w.alive && w.status === "running" && Date.now() - w.lastActive > 6000) {
      w.status = "attention";
    }
  }
}, 2000);

// ---------------------------------------------------------------------------
// HTTP API
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    platform: process.platform,
    git: has("git"),
    claude: has("claude"),
    wsl: has("wsl"),
    tmuxInWsl: has("wsl") ? run("wsl.exe", ["-e", "which", "tmux"]) !== "" : false,
  });
});

app.get("/api/workspaces", (_req, res) => {
  res.json([...workspaces.values()].map(publicView));
});

app.post("/api/workspaces", (req, res) => {
  try {
    const b = req.body || {};
    const w = createWorkspace({
      title: (b.title || "task").trim(),
      repo: (b.repo || "").trim(),
      agent: (b.agent || "claude").trim(),
      backend: b.backend === "tmux" ? "tmux" : "native",
      useWorktree: !!b.useWorktree,
      base: (b.base || "").trim(),
    });
    res.json(publicView(w));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Bring a stopped/finished workspace back to life (re-runs the agent;
// for tmux workspaces this reattaches to the surviving session).
app.post("/api/workspaces/:id/restart", (req, res) => {
  const w = workspaces.get(req.params.id);
  if (!w) return res.status(404).json({ error: "No such workspace" });
  if (w.alive) return res.status(400).json({ error: "Already running" });
  try {
    w.buffer += "\r\n\x1b[2m[wmux] restarting agent…\x1b[0m\r\n";
    spawnProc(w);
    saveState();
    res.json(publicView(w));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Uncommitted + committed changes vs. where the task started.
app.get("/api/workspaces/:id/diff", (req, res) => {
  const w = workspaces.get(req.params.id);
  if (!w) return res.status(404).json({ error: "No such workspace" });
  const stat = git(w.dir, ["diff", "--stat", w.baseRef]) || "(no changes yet)";
  const untracked = git(w.dir, ["ls-files", "--others", "--exclude-standard"]);
  res.json({ baseRef: w.baseRef, stat, untracked });
});

// Open the workspace folder in Explorer or VS Code.
app.post("/api/workspaces/:id/open", (req, res) => {
  const w = workspaces.get(req.params.id);
  if (!w) return res.status(404).json({ error: "No such workspace" });
  const appName = req.body && req.body.app === "code" ? "code" : "explorer";
  if (appName === "code") {
    execFile(IS_WIN ? "cmd.exe" : "sh", IS_WIN ? ["/c", "code", "."] : ["-c", "code ."], {
      cwd: w.dir,
    });
  } else if (IS_WIN) {
    execFile("explorer.exe", [w.dir]);
  }
  res.json({ ok: true });
});

// User acknowledged the ring (clicked the workspace).
app.post("/api/workspaces/:id/ack", (req, res) => {
  const w = workspaces.get(req.params.id);
  if (w) w.ring = false;
  res.json({ ok: true });
});

app.delete("/api/workspaces/:id", (req, res) => {
  const w = workspaces.get(req.params.id);
  if (!w) return res.status(404).json({ error: "No such workspace" });
  try {
    if (w.alive) w.proc.kill();
  } catch {}
  if (req.query.killTmux === "1" && w.tmuxSession) {
    run("wsl.exe", ["-e", "tmux", "kill-session", "-t", w.tmuxSession]);
  }
  if (req.query.removeWorktree === "1" && w.isWorktree) {
    run("git", ["-C", w.repo, "worktree", "remove", "--force", w.dir]);
    run("git", ["-C", w.repo, "branch", "-D", `wmux/${w.slug}`]);
  }
  workspaces.delete(w.id);
  saveState();
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// WebSocket: the live terminal stream
// ---------------------------------------------------------------------------

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/term" });

wss.on("connection", (ws, req) => {
  const id = new URL(req.url, "http://x").searchParams.get("id");
  const w = workspaces.get(id);
  if (!w) return ws.close();

  w.sockets.add(ws);
  // Replay history so the screen looks like you never left.
  if (w.buffer) ws.send(JSON.stringify({ t: "d", d: w.buffer }));

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (!w.alive) return;
    if (msg.t === "in") {
      // The human replied — the agent has what it needs.
      w.status = "running";
      w.ring = false;
      w.lastActive = Date.now();
      w.proc.write(msg.d);
    } else if (msg.t === "rs" && msg.c > 0 && msg.r > 0) {
      try {
        w.proc.resize(msg.c, msg.r);
      } catch {}
    }
  });

  ws.on("close", () => w.sockets.delete(ws));
});

// ---------------------------------------------------------------------------
// Startup — embeddable (Electron) or standalone (`npm run server`)
// ---------------------------------------------------------------------------

/**
 * Start the server. Tries the preferred port; if something already has it,
 * falls back to any free port. Resolves with the actual port.
 */
function start() {
  loadState();
  return new Promise((resolve) => {
    server.once("error", (e) => {
      if (e.code === "EADDRINUSE") {
        server.listen(0, "127.0.0.1"); // any free port
      } else {
        throw e;
      }
    });
    server.on("listening", () => {
      const port = server.address().port;
      console.log(`\n  wmux is running  →  http://localhost:${port}\n`);
      if (IS_WIN && !has("wsl")) {
        console.log("  (tmux backend unavailable: WSL not detected — native mode still works)\n");
      }
      resolve(port);
    });
    // Localhost only — nothing on your network can reach this.
    server.listen(PREFERRED_PORT, "127.0.0.1");
  });
}

module.exports = { start };

if (require.main === module) start();
