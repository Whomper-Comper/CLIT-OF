/**
 * OpenFront Discord Bot - Remote Control Panel & SSH Deployment GUI
 * 100% Zero-Dependency Node.js Local App
 */

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { spawn, exec } = require("node:child_process");

const ROOT_DIR = path.resolve(__dirname, "..");
const CONFIG_FILE = path.join(ROOT_DIR, "control-panel-config.json");
const LOCAL_ENV_FILE = path.join(ROOT_DIR, ".env");
const DEFAULT_PORT = 4321;

// Load or initialize config
function loadConfig() {
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
    } catch {
      // Fall through to default
    }
  }
  return {
    host: "",
    username: "ubuntu",
    port: "22",
    keyPath: "",
    remoteDir: "~/discord-bot",
    githubToken: "",
  };
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), "utf-8");
}

// Build SSH command arguments for Windows OpenSSH
function getSshArgs(cfg, remoteCommand) {
  const cleanKey = (cfg.keyPath || "").replace(/^["']|["']$/g, "").trim();
  const cleanHost = (cfg.host || "").replace(/^["']|["']$/g, "").trim();
  const cleanUser = (cfg.username || "ubuntu").replace(/^["']|["']$/g, "").trim();

  const args = [
    "-p",
    cfg.port || "22",
    "-o",
    "StrictHostKeyChecking=no",
    "-o",
    "UserKnownHostsFile=NUL",
    "-o",
    "ConnectTimeout=60",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=4",
  ];

  if (cleanKey) {
    args.push("-i", cleanKey);
  }

  const destination = `${cleanUser}@${cleanHost}`;
  args.push(destination, remoteCommand);

  return args;
}

// Build SCP command arguments for file transfers
function getScpArgs(cfg, localPath, remotePath) {
  const cleanKey = (cfg.keyPath || "").replace(/^["']|["']$/g, "").trim();
  const cleanHost = (cfg.host || "").replace(/^["']|["']$/g, "").trim();
  const cleanUser = (cfg.username || "ubuntu").replace(/^["']|["']$/g, "").trim();

  const args = [
    "-P",
    cfg.port || "22",
    "-o",
    "StrictHostKeyChecking=no",
    "-o",
    "UserKnownHostsFile=NUL",
    "-o",
    "ConnectTimeout=60",
    "-r",
  ];

  if (cleanKey) {
    args.push("-i", cleanKey);
  }

  const destination = `${cleanUser}@${cleanHost}:${remotePath}`;
  args.push(localPath, destination);

  return args;
}

// HTML & Client-Side UI
const HTML_CONTENT = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>CLIT-OF Bot • Oracle Server Manager</title>
  <style>
    :root {
      --bg: #0b0f19;
      --card-bg: #131b2e;
      --card-border: #1e293b;
      --accent: #38bdf8;
      --accent-hover: #0284c7;
      --success: #22c55e;
      --warning: #f59e0b;
      --danger: #ef4444;
      --text: #f8fafc;
      --text-muted: #94a3b8;
      --terminal-bg: #030712;
      --font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      padding: 24px;
      line-height: 1.5;
    }
    .container { max-width: 1280px; margin: 0 auto; display: flex; flex-direction: column; gap: 20px; }
    
    /* Header */
    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding-bottom: 16px;
      border-bottom: 1px solid var(--card-border);
    }
    .brand { display: flex; align-items: center; gap: 12px; }
    .brand h1 { font-size: 1.5rem; font-weight: 700; letter-spacing: -0.5px; }
    .brand span { color: var(--accent); font-size: 0.9rem; background: rgba(56,189,248,0.1); padding: 2px 8px; border-radius: 999px; }
    .status-badge {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 0.85rem;
      background: #1e293b;
      padding: 6px 14px;
      border-radius: 999px;
      border: 1px solid #334155;
    }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: #64748b; }
    .dot.online { background: var(--success); box-shadow: 0 0 10px var(--success); }
    .dot.offline { background: var(--danger); }
    .dot.busy { background: var(--warning); animation: pulse 1s infinite; }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }

    /* Layout */
    .grid { display: grid; grid-template-columns: 340px 1fr; gap: 20px; }
    @media (max-width: 960px) { .grid { grid-template-columns: 1fr; } }

    /* Card */
    .card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 12px;
      padding: 20px;
    }
    .card h2 { font-size: 1.1rem; font-weight: 600; margin-bottom: 14px; display: flex; align-items: center; gap: 8px; }

    /* Forms */
    .form-group { margin-bottom: 12px; }
    .form-group label { display: block; font-size: 0.75rem; color: var(--text-muted); margin-bottom: 5px; text-transform: uppercase; letter-spacing: 0.5px; font-weight: 600; }
    .form-group input {
      width: 100%;
      background: #0f172a;
      border: 1px solid #334155;
      padding: 9px 12px;
      border-radius: 8px;
      color: #fff;
      font-size: 0.88rem;
      outline: none;
      transition: border-color 0.2s;
    }
    .form-group input:focus { border-color: var(--accent); }
    .form-row { display: grid; grid-template-columns: 1fr 90px; gap: 10px; }

    /* Buttons */
    button {
      cursor: pointer;
      font-size: 0.88rem;
      font-weight: 500;
      border-radius: 8px;
      border: none;
      padding: 10px 14px;
      transition: all 0.15s ease;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
    }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    .btn-primary { background: var(--accent); color: #0b0f19; font-weight: 600; width: 100%; }
    .btn-primary:hover:not(:disabled) { background: var(--accent-hover); }
    .btn-secondary { background: #1e293b; color: var(--text); border: 1px solid #334155; }
    .btn-secondary:hover:not(:disabled) { background: #334155; }

    /* Section Tabs / Headers */
    .section-title {
      font-size: 0.85rem;
      text-transform: uppercase;
      letter-spacing: 0.8px;
      font-weight: 700;
      color: var(--text-muted);
      margin: 16px 0 10px 0;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .section-title:first-child { margin-top: 0; }

    /* Actions Grid */
    .actions-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 10px; margin-bottom: 12px; }
    .action-btn {
      background: #182238;
      border: 1px solid var(--card-border);
      color: #fff;
      padding: 14px;
      border-radius: 10px;
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 5px;
      text-align: left;
    }
    .action-btn:hover:not(:disabled) {
      border-color: var(--accent);
      background: #1e2d4a;
      transform: translateY(-1px);
    }
    .action-btn span.title { font-weight: 600; font-size: 0.9rem; display: flex; align-items: center; gap: 8px; }
    .action-btn span.desc { font-size: 0.72rem; color: var(--text-muted); line-height: 1.3; }

    .action-btn.deploy { border-left: 4px solid var(--accent); }
    .action-btn.upload { border-left: 4px solid #a855f7; }
    .action-btn.start { border-left: 4px solid var(--success); }
    .action-btn.stop { border-left: 4px solid var(--danger); }
    .action-btn.restart { border-left: 4px solid var(--warning); }
    .action-btn.sync { border-left: 4px solid #06b6d4; }
    .action-btn.setup { border-left: 4px solid #f97316; }
    .action-btn.sys { border-left: 4px solid #10b981; }

    /* Terminal */
    .terminal-container {
      background: var(--terminal-bg);
      border: 1px solid var(--card-border);
      border-radius: 12px;
      overflow: hidden;
      display: flex;
      flex-direction: column;
      height: 440px;
    }
    .terminal-header {
      background: #0f172a;
      padding: 10px 16px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 1px solid var(--card-border);
      font-size: 0.85rem;
      color: var(--text-muted);
    }
    .terminal-header .title { display: flex; align-items: center; gap: 8px; font-family: var(--font-mono); }
    .terminal-body {
      flex: 1;
      padding: 14px;
      font-family: var(--font-mono);
      font-size: 0.82rem;
      color: #cbd5e1;
      overflow-y: auto;
      white-space: pre-wrap;
      word-break: break-all;
    }
    .terminal-input-bar {
      display: flex;
      background: #090d16;
      border-top: 1px solid var(--card-border);
      padding: 8px 12px;
      gap: 8px;
    }
    .terminal-input-bar input {
      flex: 1;
      background: transparent;
      border: none;
      color: #38bdf8;
      font-family: var(--font-mono);
      font-size: 0.85rem;
      outline: none;
    }
    .terminal-input-bar button { padding: 6px 14px; font-size: 0.8rem; }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div class="brand">
        <h1>CLIT-OF Bot</h1>
        <span>Oracle Cloud Manager</span>
      </div>
      <div class="status-badge">
        <div id="statusDot" class="dot"></div>
        <span id="statusText">Checking SSH...</span>
      </div>
    </header>

    <div class="grid">
      <!-- Left Column: Settings -->
      <div class="card">
        <h2>⚙️ Server Connection</h2>
        <div class="form-group">
          <label>Server IP / Host</label>
          <input type="text" id="host" placeholder="e.g. 150.136.x.x">
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>SSH User</label>
            <input type="text" id="username" placeholder="ubuntu">
          </div>
          <div class="form-group">
            <label>Port</label>
            <input type="text" id="port" placeholder="22">
          </div>
        </div>
        <div class="form-group">
          <label>SSH Key File Path (.key / .pem)</label>
          <input type="text" id="keyPath" placeholder="C:\\path\\to\\your-ssh-key.key">
        </div>
        <div class="form-group">
          <label>Remote Bot Directory</label>
          <input type="text" id="remoteDir" placeholder="~/discord-bot">
        </div>
        <div class="form-group">
          <label>GitHub Personal Access Token (for Private Repo)</label>
          <input type="password" id="githubToken" placeholder="ghp_xxxxxxxxxxxxxxxxxxxx">
        </div>

        <button class="btn-primary" id="saveAndTestBtn" onclick="saveAndTestConnection()">
          💾 Save & Test Connection
        </button>

        <div style="margin-top: 20px; padding-top: 16px; border-top: 1px solid var(--card-border);">
          <div class="section-title">🔑 Quick Config Sync</div>
          <button class="btn-secondary" style="width: 100%; justify-content: center;" onclick="runAction('upload_env')">
            📤 Upload Local .env to Server
          </button>
        </div>
      </div>

      <!-- Right Column: Operations -->
      <div style="display: flex; flex-direction: column; gap: 16px;">
        <div class="card">
          <!-- Section 1: Server Setup & Maintenance -->
          <div class="section-title">🛠️ Server Setup & System Updates</div>
          <div class="actions-grid">
            <button class="action-btn setup" onclick="runAction('initial_setup')">
              <span class="title">⚡ Initial Server Setup</span>
              <span class="desc">Installs Node 22 LTS, Git, build tools & PM2 on clean VM</span>
            </button>
            <button class="action-btn sys" onclick="runAction('apt_update')">
              <span class="title">🔄 Sudo Apt Update</span>
              <span class="desc">apt-get update & upgrade system packages</span>
            </button>
            <button class="action-btn" onclick="runAction('clone_repo')">
              <span class="title">🔗 Clone / Sync Repo</span>
              <span class="desc">Clone or refresh private repo with GitHub Token</span>
            </button>
            <button class="action-btn" onclick="runAction('npm_install')">
              <span class="title">📦 NPM Install/Update</span>
              <span class="desc">Run npm install & update dependencies</span>
            </button>
            <button class="action-btn sys" onclick="runAction('optimize_memory')">
              <span class="title">🧹 Free RAM & Swap</span>
              <span class="desc">Clear Linux OS page caches & activate 2GB swap</span>
            </button>
            <button class="action-btn" onclick="runAction('system_info')">
              <span class="title">ℹ️ Server Hardware Info</span>
              <span class="desc">Check RAM, disk space, CPU & uptime</span>
            </button>
          </div>

          <!-- Section 2: Bot Management -->
          <div class="section-title">🤖 Bot Management & Code Updates</div>
          <div class="actions-grid">
            <button class="action-btn deploy" onclick="runAction('deploy_git')">
              <span class="title">🚀 Git Pull & Deploy</span>
              <span class="desc">Pull main, build, sync slash commands & restart PM2</span>
            </button>
            <button class="action-btn upload" onclick="runAction('direct_upload')">
              <span class="title">📦 Direct Code Upload</span>
              <span class="desc">SCP local files directly to VM & restart (no git push needed)</span>
            </button>
            <button class="action-btn restart" onclick="runAction('restart')">
              <span class="title">🔄 Restart Bot</span>
              <span class="desc">pm2 restart clit-of-bot</span>
            </button>
            <button class="action-btn sync" onclick="runAction('commands_refresh')">
              <span class="title">🌐 Force Cmd Sync</span>
              <span class="desc">Re-register slash commands with Discord API</span>
            </button>
            <button class="action-btn start" onclick="runAction('start')">
              <span class="title">▶️ Start Bot</span>
              <span class="desc">pm2 start ecosystem.config.cjs</span>
            </button>
            <button class="action-btn stop" onclick="runAction('stop')">
              <span class="title">⏹️ Stop Bot</span>
              <span class="desc">pm2 stop clit-of-bot</span>
            </button>
            <button class="action-btn" onclick="runAction('status')">
              <span class="title">📊 PM2 Status</span>
              <span class="desc">Inspect RAM, CPU, PID & status</span>
            </button>
            <button class="action-btn" onclick="runAction('logs')">
              <span class="title">📜 View Logs (Recent)</span>
              <span class="desc">Show recent 60 lines of bot logs</span>
            </button>
            <button class="action-btn" style="border-left: 4px solid #ec4899;" onclick="runAction('advanced_logs')">
              <span class="title">🔬 Advanced Diagnostics</span>
              <span class="desc">PM2 stdout, stderr, error logs & memory health</span>
            </button>
            <button class="action-btn" style="border-left: 4px solid #6366f1;" onclick="runAction('test_discord_api')">
              <span class="title">🌐 Test Discord API</span>
              <span class="desc">Ping Discord Gateway & verify .env format</span>
            </button>
          </div>
        </div>

        <!-- Terminal Output -->
        <div class="terminal-container">
          <div class="terminal-header">
            <div class="title" style="display: flex; align-items: center; gap: 8px;">
              <span>💻 Live SSH Terminal Output</span>
              <span id="activityBadge" style="display:none; font-size:0.75rem; color:#38bdf8; background:rgba(56,189,248,0.15); padding:2px 8px; border-radius:12px; font-weight:normal;">
                ⏳ Working... <span id="timerText">0s</span>
              </span>
            </div>
            <div style="display: flex; align-items: center; gap: 10px;">
              <label style="font-size:0.75rem; color:var(--text-muted); display:inline-flex; align-items:center; gap:4px; cursor:pointer;">
                <input type="checkbox" id="timestampsToggle" checked> Timestamps
              </label>
              <button class="btn-secondary" style="padding: 4px 8px; font-size: 0.75rem;" onclick="clearTerminal()">Clear</button>
              <button class="btn-secondary" style="padding: 4px 8px; font-size: 0.75rem;" onclick="copyTerminal()">Copy</button>
            </div>
          </div>
          <div class="terminal-body" id="terminal">Welcome to OpenFront Bot Control Panel.\nClick '⚡ Initial Server Setup' if starting on a new VM, or 'Save & Test Connection' to verify SSH.</div>
          <div class="terminal-input-bar">
            <input type="text" id="customCmd" placeholder="Type custom SSH command (e.g. pm2 list, git status, htop) and press Enter..." onkeydown="handleKey(event)">
            <button class="btn-secondary" onclick="runCustomCommand()">Run Command</button>
          </div>
        </div>
      </div>
    </div>
  </div>

  <script>
    const term = document.getElementById('terminal');
    const dot = document.getElementById('statusDot');
    const statusText = document.getElementById('statusText');
    const badge = document.getElementById('activityBadge');
    const timerEl = document.getElementById('timerText');
    let timerInterval = null;
    let actionStart = null;

    // Load initial config
    fetch('/api/config')
      .then(res => res.json())
      .then(cfg => {
        document.getElementById('host').value = cfg.host || '';
        document.getElementById('username').value = cfg.username || 'ubuntu';
        document.getElementById('port').value = cfg.port || '22';
        document.getElementById('keyPath').value = cfg.keyPath || '';
        document.getElementById('remoteDir').value = cfg.remoteDir || '~/discord-bot';
        document.getElementById('githubToken').value = cfg.githubToken || '';
        if (cfg.host) testConnectionSilently();
      });

    function ts() {
      if (!document.getElementById('timestampsToggle').checked) return '';
      const d = new Date();
      return '[' + d.toLocaleTimeString() + '] ';
    }

    function log(msg) {
      term.textContent += msg;
      term.scrollTop = term.scrollHeight;
    }

    function logLine(msg) {
      log(ts() + msg + '\n');
    }

    function clearTerminal() { term.textContent = ''; }
    function copyTerminal() { navigator.clipboard.writeText(term.textContent); alert('Terminal copied to clipboard!'); }

    function startTimer() {
      actionStart = Date.now();
      badge.style.display = 'inline';
      timerEl.textContent = '0s';
      clearInterval(timerInterval);
      timerInterval = setInterval(() => {
        const elapsed = Math.floor((Date.now() - actionStart) / 1000);
        const m = Math.floor(elapsed / 60);
        const s = elapsed % 60;
        timerEl.textContent = m > 0 ? m + 'm ' + s + 's' : s + 's';
      }, 500);
    }

    function stopTimer() {
      clearInterval(timerInterval);
      const elapsed = actionStart ? ((Date.now() - actionStart) / 1000).toFixed(1) : '?';
      badge.style.display = 'none';
      actionStart = null;
      return elapsed;
    }

    function getConfig() {
      return {
        host: document.getElementById('host').value.trim(),
        username: document.getElementById('username').value.trim(),
        port: document.getElementById('port').value.trim(),
        keyPath: document.getElementById('keyPath').value.trim(),
        remoteDir: document.getElementById('remoteDir').value.trim(),
        githubToken: document.getElementById('githubToken').value.trim(),
      };
    }

    async function saveConfig() {
      const cfg = getConfig();
      await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cfg),
      });
    }

    async function testConnectionSilently() {
      try {
        const res = await fetch('/api/action', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'test_connection' }),
        });
        const text = await res.text();
        if (text.includes('SSH_OK')) {
          dot.className = 'dot online';
          statusText.textContent = 'Server Connected';
        } else {
          dot.className = 'dot offline';
          statusText.textContent = 'SSH Disconnected';
        }
      } catch {
        dot.className = 'dot offline';
        statusText.textContent = 'SSH Disconnected';
      }
    }

    async function saveAndTestConnection() {
      await saveConfig();
      dot.className = 'dot busy';
      statusText.textContent = 'Testing SSH...';
      logLine('--- Testing SSH Connection ---');
      await runAction('test_connection');
    }

    async function runAction(action) {
      await saveConfig();
      dot.className = 'dot busy';
      statusText.textContent = 'Executing...';
      startTimer();
      logLine('>>> Starting: ' + action);

      try {
        const response = await fetch('/api/action', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action }),
        });

        const reader = response.body.getReader();
        const decoder = new TextDecoder();

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          log(decoder.decode(value, { stream: true }));
        }

        const elapsed = stopTimer();
        logLine('\u2705 Completed: ' + action + ' (' + elapsed + 's)');
        dot.className = 'dot online';
        statusText.textContent = 'Done (' + elapsed + 's)';
      } catch (err) {
        const elapsed = stopTimer();
        logLine('\u274c Error: ' + err.message + ' (' + elapsed + 's)');
        dot.className = 'dot offline';
        statusText.textContent = 'Command Failed';
      }
    }

    function handleKey(e) {
      if (e.key === 'Enter') runCustomCommand();
    }

    function runCustomCommand() {
      const input = document.getElementById('customCmd');
      const cmd = input.value.trim();
      if (!cmd) return;
      input.value = '';
      logLine('$ ' + cmd);
      runActionCustom(cmd);
    }

    async function runActionCustom(cmd) {
      await saveConfig();
      dot.className = 'dot busy';
      statusText.textContent = 'Running command...';
      startTimer();

      try {
        const response = await fetch('/api/action', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'custom', command: cmd }),
        });

        const reader = response.body.getReader();
        const decoder = new TextDecoder();

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          log(decoder.decode(value, { stream: true }));
        }

        const elapsed = stopTimer();
        logLine('\u2705 Command finished (' + elapsed + 's)');
        dot.className = 'dot online';
        statusText.textContent = 'Done (' + elapsed + 's)';
      } catch (err) {
        const elapsed = stopTimer();
        logLine('\u274c Error: ' + err.message);
        dot.className = 'dot offline';
      }
    }
  </script>
</body>
</html>`;

// Server Request Handler
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // GET / -> Serve GUI HTML
  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(HTML_CONTENT);
  }

  // GET /api/config -> Read current config
  if (req.method === "GET" && url.pathname === "/api/config") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(loadConfig()));
  }

  // POST /api/config -> Save config
  if (req.method === "POST" && url.pathname === "/api/config") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        const cfg = JSON.parse(body);
        saveConfig(cfg);
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(400);
        return res.end(err.message);
      }
    });
    return;
  }

  // POST /api/action -> Execute command via SSH / SCP
  if (req.method === "POST" && url.pathname === "/api/action") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      const cfg = loadConfig();

      if (!cfg.host) {
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
        return res.end("❌ Error: Server Host/IP is not configured. Please enter your Oracle IP on the left.\n");
      }

      let payload = {};
      try {
        payload = JSON.parse(body);
      } catch {
        // empty
      }

      const action = payload.action;
      const remoteDir = cfg.remoteDir || "~/discord-bot";

      res.writeHead(200, {
        "Content-Type": "text/plain; charset=utf-8",
        "Transfer-Encoding": "chunked",
      });

      // Special action: Upload local .env file to remote server
      if (action === "upload_env") {
        if (!fs.existsSync(LOCAL_ENV_FILE)) {
          res.write("❌ Error: Local .env file does not exist in discord-bot folder!\n");
          res.write("Please create .env locally first (copy .env.example -> .env) with your DISCORD_TOKEN and CLIENT_ID.\n");
          return res.end();
        }

        res.write(`[1/3] Ensuring remote directory ${remoteDir} exists...\n`);
        const mkdirArgs = getSshArgs(cfg, `mkdir -p ${remoteDir}`);
        await new Promise((resolve) => {
          const p = spawn("ssh", mkdirArgs, { stdio: ["ignore", "pipe", "pipe"] });
          p.stdout.on("data", (d) => res.write(d));
          p.stderr.on("data", (d) => res.write(d));
          p.on("close", () => resolve());
        });

        res.write(`\n[2/3] Uploading local .env to ${cfg.host}:${remoteDir}/.env...\n`);

        await new Promise((resolve) => {
          const scpArgs = getScpArgs(cfg, LOCAL_ENV_FILE, `${remoteDir}/.env`);
          const p = spawn("scp", scpArgs, { stdio: ["ignore", "pipe", "pipe"] });

          p.stdout.on("data", (d) => res.write(d));
          p.stderr.on("data", (d) => res.write(d));
          p.on("close", (code) => {
            if (code === 0) {
              res.write("✅ .env uploaded successfully to the remote server!\n");
            } else {
              res.write(`\n❌ Failed to upload .env (exit code ${code}). Check if port 22 is open on your Oracle VM.\n`);
            }
            resolve();
          });
        });

        res.write("\n[3/3] Done!\n");
        return res.end();
      }

      // Special action: Direct SCP Code Upload (Syncs local files directly without git push!)
      if (action === "direct_upload") {
        res.write(`[1/3] Ensuring remote directory ${remoteDir} exists on server...\n`);
        const mkdirArgs = getSshArgs(cfg, `mkdir -p ${remoteDir}`);
        await new Promise((resolve) => {
          const p = spawn("ssh", mkdirArgs, { stdio: ["ignore", "pipe", "pipe"] });
          p.on("close", () => resolve());
        });

        res.write(`[2/3] Uploading local codebase to ${cfg.host}:${remoteDir} via SCP...\n`);

        const filesToUpload = [
          "src",
          "package.json",
          "package-lock.json",
          "tsconfig.json",
          "ecosystem.config.cjs",
          "deploy.sh",
        ];

        let hasError = false;

        for (const file of filesToUpload) {
          const localPath = path.join(ROOT_DIR, file);
          if (!fs.existsSync(localPath)) continue;

          res.write(`  -> Uploading ${file}...\n`);

          await new Promise((resolve) => {
            const scpArgs = getScpArgs(cfg, localPath, `${remoteDir}/`);
            const p = spawn("scp", scpArgs, { stdio: ["ignore", "pipe", "pipe"] });

            p.stdout.on("data", (d) => res.write(d));
            p.stderr.on("data", (d) => res.write(d));
            p.on("close", (code) => {
              if (code !== 0) hasError = true;
              resolve();
            });
          });
        }

        if (hasError) {
          res.write("\n⚠️ SCP encountered errors during upload.\n");
        } else {
          res.write("\n[2/3] Upload complete! Rebuilding on remote server...\n");
        }

        const buildAndRestartCmd = `cd ${remoteDir} && npm install && npm run build && npm run register-commands && pm2 restart ecosystem.config.cjs && pm2 status clit-of-bot`;
        const sshArgs = getSshArgs(cfg, buildAndRestartCmd);
        const sshProc = spawn("ssh", sshArgs, { stdio: ["ignore", "pipe", "pipe"] });

        sshProc.stdout.on("data", (d) => res.write(d));
        sshProc.stderr.on("data", (d) => res.write(d));
        sshProc.on("close", (code) => {
          res.write(`\n[3/3] Done with exit code ${code}!\n`);
          res.end();
        });
        return;
      }

      // Standard remote shell command mapping
      let remoteCmd = "";

      switch (action) {
        case "test_connection":
          remoteCmd = 'echo "SSH_OK: Connected to $(hostname) as $(whoami) [$(uname -srm)]" && echo "Memory:" && free -h | head -2 && echo "Disk:" && df -h / | tail -1 && echo "Uptime:" && uptime';
          break;

        case "initial_setup": {
          // Oracle Always Free = 1GB RAM. dnf/apt get OOM-killed without swap.
          // Step 1: Create 2GB swap FIRST, then install packages one-by-one.
          remoteCmd = [
            'echo "══════════════════════════════════════════════════════"',
            'echo "  ⚡ CLIT-OF Initial Server Setup"',
            'echo "══════════════════════════════════════════════════════"',
            'echo ""',

            // Step 1: Swap (critical for 1GB Oracle Always Free)
            'echo "▸ [1/6] Creating 2GB swap file (prevents OOM on 1GB VM)..."',
            'if [ ! -f /swapfile ]; then sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile && echo "/swapfile swap swap defaults 0 0" | sudo tee -a /etc/fstab && echo "  ✓ 2GB swap created and activated"; else echo "  ✓ Swap already exists"; fi',
            'free -h | grep -i swap',
            'echo ""',

            // Step 2: Detect OS + install system packages
            'echo "▸ [2/6] Installing system packages (git, curl, build tools)..."',
            'if command -v dnf >/dev/null 2>&1; then echo "  OS: Oracle Linux / RHEL (dnf)" && sudo dnf install -y git curl tar && echo "  ✓ System packages installed"; elif command -v apt-get >/dev/null 2>&1; then echo "  OS: Ubuntu / Debian (apt-get)" && sudo DEBIAN_FRONTEND=noninteractive apt-get update -y && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y curl git build-essential && echo "  ✓ System packages installed"; else echo "  ✗ Unsupported package manager" && exit 1; fi',
            'echo ""',

            // Step 3: Node.js 22 LTS
            'echo "▸ [3/6] Installing Node.js 22 LTS..."',
            'if command -v dnf >/dev/null 2>&1; then curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo bash - && sudo dnf install -y nodejs; else curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs; fi',
            'echo "  ✓ Node.js $(node -v) installed"',
            'echo "  ✓ npm $(npm -v) installed"',
            'echo ""',

            // Step 4: PM2
            'echo "▸ [4/6] Installing PM2 process manager..."',
            'sudo npm install -g pm2',
            'echo "  ✓ PM2 $(pm2 -v) installed"',
            'echo ""',

            // Step 5: Create bot directory
            'echo "▸ [5/6] Creating bot directory..."',
            `mkdir -p ${remoteDir}`,
            `echo "  ✓ ${remoteDir} ready"`,
            'echo ""',

            // Step 6: PM2 startup (auto-start on reboot)
            'echo "▸ [6/6] Configuring PM2 startup on reboot..."',
            'sudo env PATH=$PATH:/usr/bin pm2 startup systemd -u $(whoami) --hp $HOME 2>/dev/null || echo "  ⚠ PM2 startup already configured"',
            'echo ""',

            'echo "══════════════════════════════════════════════════════"',
            'echo "  ✅ Server setup complete!"',
            'echo "  Next: Click \'🔗 Clone / Sync Repo\' to pull your code"',
            'echo "══════════════════════════════════════════════════════"',
            'echo ""',
            'echo "Installed versions:"',
            'echo "  Node.js: $(node -v)"',
            'echo "  npm:     $(npm -v)"',
            'echo "  PM2:     $(pm2 -v)"',
            'echo "  Git:     $(git --version)"',
            'echo ""',
            'echo "Memory after setup:"',
            'free -h',
          ].join(" && ");
          break;
        }

        case "clone_repo": {
          const token = (cfg.githubToken || "").trim();
          const repoUrl = token
            ? `https://${token}@github.com/Whomper-Comper/CLIT-OF.git`
            : "https://github.com/Whomper-Comper/CLIT-OF.git";

          remoteCmd = [
            'echo "▸ Checking repository status..."',
            `if [ ! -d "${remoteDir}" ] || [ ! -d "${remoteDir}/.git" ]; then ` +
              `echo "  Cloning fresh copy of CLIT-OF..." && ` +
              `rm -rf ${remoteDir} && git clone ${repoUrl} ${remoteDir} && ` +
              `echo "  ✓ Repository cloned successfully"; ` +
            `else ` +
              `echo "  Updating existing repository..." && ` +
              `cd ${remoteDir} && git remote set-url origin ${repoUrl} && git fetch origin && git reset --hard origin/main && ` +
              `echo "  ✓ Repository updated to latest main"; ` +
            `fi`,
            `echo "" && echo "  Directory: ${remoteDir}" && ls -la ${remoteDir}/ | head -15`,
          ].join(" && ");
          break;
        }

        case "optimize_memory":
          remoteCmd = [
            'echo "▸ Current memory state:"',
            'free -h',
            'echo ""',

            'echo "▸ Clearing page cache, dentries and inodes..."',
            'sudo sh -c "sync && echo 3 > /proc/sys/vm/drop_caches"',
            'echo "  ✓ Caches cleared"',
            'echo ""',

            'echo "▸ Checking swap..."',
            'if [ ! -f /swapfile ]; then echo "  Creating 2GB swap..." && sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile && echo "/swapfile swap swap defaults 0 0" | sudo tee -a /etc/fstab && echo "  ✓ 2GB swap created"; else if ! swapon --show | grep -q swapfile; then sudo swapon /swapfile && echo "  ✓ Swap re-activated"; else echo "  ✓ Swap already active"; fi; fi',
            'echo ""',

            'echo "▸ Memory after optimization:"',
            'free -h',
          ].join(" && ");
          break;

        case "apt_update":
          remoteCmd = [
            'echo "▸ Detecting package manager..."',
            'if command -v dnf >/dev/null 2>&1; then echo "  Using dnf..." && sudo dnf update -y && echo "  ✓ System updated"; elif command -v apt-get >/dev/null 2>&1; then echo "  Using apt-get..." && sudo DEBIAN_FRONTEND=noninteractive apt-get update && sudo DEBIAN_FRONTEND=noninteractive apt-get upgrade -y && echo "  ✓ System updated"; fi',
          ].join(" && ");
          break;

        case "npm_install":
          remoteCmd = [
            `echo "▸ Changing to ${remoteDir}..."`,
            `cd ${remoteDir}`,
            'echo "▸ Running npm install..."',
            'npm install',
            'echo ""',
            'echo "▸ Running npm update..."',
            'npm update',
            'echo ""',
            'echo "▸ Installed packages:"',
            'npm list --depth=0',
            'echo ""',
            'echo "  ✓ Dependencies up to date"',
          ].join(" && ");
          break;

        case "system_info":
          remoteCmd = [
            'echo "══════════════════════════════════════"',
            'echo "         Server Diagnostics"',
            'echo "══════════════════════════════════════"',
            'echo ""',
            'echo "▸ OS & Kernel:" && uname -a',
            'echo "" && echo "▸ Uptime & Load:" && uptime',
            'echo "" && echo "▸ Memory:" && free -h',
            'echo "" && echo "▸ Swap:" && swapon --show 2>/dev/null || echo "  No swap configured"',
            'echo "" && echo "▸ Disk:" && df -h / | column -t',
            'echo "" && echo "▸ CPU:" && lscpu 2>/dev/null | grep -E "Model name|CPU\(s\):|Thread" || cat /proc/cpuinfo | grep "model name" | head -1',
            'echo "" && echo "▸ Top 5 memory-hungry processes:" && ps aux --sort=-%mem | head -6',
            'echo "" && echo "▸ Installed Runtimes:"',
            'echo "  Node.js: $(node -v 2>/dev/null || echo Not installed)"',
            'echo "  npm:     $(npm -v 2>/dev/null || echo Not installed)"',
            'echo "  PM2:     $(pm2 -v 2>/dev/null || echo Not installed)"',
            'echo "  Git:     $(git --version 2>/dev/null || echo Not installed)"',
          ].join(" && ");
          break;

        case "deploy_git": {
          const token = (cfg.githubToken || "").trim();
          const repoUrl = token
            ? `https://${token}@github.com/Whomper-Comper/CLIT-OF.git`
            : "https://github.com/Whomper-Comper/CLIT-OF.git";

          remoteCmd = [
            `if [ ! -d "${remoteDir}" ] || [ ! -d "${remoteDir}/.git" ]; then ` +
              `echo "▸ Cloning CLIT-OF repository..." && ` +
              `rm -rf ${remoteDir} && ` +
              `git clone ${repoUrl} ${remoteDir} && ` +
              `echo "  ✓ Cloned successfully"; ` +
            `else ` +
              `echo "▸ Updating remote URL..." && ` +
              `cd ${remoteDir} && git remote set-url origin ${repoUrl} && ` +
              `echo "  ✓ Remote URL updated"; ` +
            `fi`,
            `cd ${remoteDir} && chmod +x deploy.sh && echo "▸ Running deploy.sh..." && ./deploy.sh`,
          ].join(" && ");
          break;
        }

        case "start":
          remoteCmd = [
            `echo "▸ Starting bot under PM2..."`,
            `cd ${remoteDir} && pm2 start ecosystem.config.cjs`,
            'pm2 save',
            'echo "" && echo "▸ Current PM2 status:" && pm2 status clit-of-bot',
          ].join(" && ");
          break;

        case "stop":
          remoteCmd = 'echo "▸ Stopping bot..." && pm2 stop clit-of-bot && echo "" && echo "▸ PM2 status:" && pm2 status clit-of-bot';
          break;

        case "restart":
          remoteCmd = 'echo "▸ Restarting bot..." && pm2 restart clit-of-bot && echo "" && echo "▸ PM2 status:" && pm2 status clit-of-bot';
          break;

        case "status":
          remoteCmd = 'echo "▸ PM2 Process List:" && pm2 status && echo "" && echo "▸ Memory:" && free -h | head -2';
          break;

        case "logs":
          remoteCmd = 'echo "▸ Last 60 lines of bot output:" && echo "" && pm2 logs clit-of-bot --lines 60 --nostream';
          break;

        case "advanced_logs":
          remoteCmd = [
            'echo "══════════════════════════════════════"',
            'echo "       Advanced Bot Diagnostics"',
            'echo "══════════════════════════════════════"',
            'echo ""',

            'echo "▸ PM2 Process Details:" && pm2 describe clit-of-bot 2>/dev/null || echo "  Bot is not registered in PM2"',
            'echo ""',

            'echo "▸ Last 30 lines of STDOUT:" && echo "─────────────────────────────" && pm2 logs clit-of-bot --out --lines 30 --nostream 2>/dev/null || echo "  No stdout logs"',
            'echo ""',

            'echo "▸ Last 30 lines of STDERR:" && echo "─────────────────────────────" && pm2 logs clit-of-bot --err --lines 30 --nostream 2>/dev/null || echo "  No stderr logs"',
            'echo ""',

            'echo "▸ Node.js process memory (if running):" && ps aux | grep -E "node.*clit|node.*dist" | grep -v grep || echo "  Bot process not found"',
            'echo ""',

            'echo "▸ System memory health:" && free -h',
            'echo "" && echo "▸ Swap usage:" && swapon --show 2>/dev/null || echo "  No swap"',
            'echo "" && echo "▸ OOM Killer events (last 10):" && sudo dmesg 2>/dev/null | grep -i "oom\|killed process" | tail -10 || echo "  No OOM events found"',
            'echo "" && echo "▸ Disk usage:" && df -h / | column -t',
            `echo "" && echo "▸ .env file check:" && if [ -f "${remoteDir}/.env" ]; then echo "  ✓ .env exists ($(wc -l < ${remoteDir}/.env) lines)"; else echo "  ✗ .env NOT found - upload it!"; fi`,
            `echo "" && echo "▸ Bot directory:" && ls -la ${remoteDir}/ 2>/dev/null | head -20 || echo "  Directory does not exist"`,
          ].join(" && ");
          break;

        case "test_discord_api":
          remoteCmd = [
            'echo "▸ Testing Discord API Gateway..."',
            'GATEWAY=$(curl -sf https://discord.com/api/v10/gateway 2>&1)',
            'if echo "$GATEWAY" | grep -q "wss://"; then echo "  ✓ Discord API reachable: $GATEWAY"; else echo "  ✗ Discord API unreachable: $GATEWAY"; fi',
            'echo ""',

            `echo "▸ Checking .env configuration..."`,
            `if [ -f "${remoteDir}/.env" ]; then ` +
              `echo "  ✓ .env file found" && ` +
              `if grep -q "DISCORD_TOKEN=" ${remoteDir}/.env; then echo "  ✓ DISCORD_TOKEN is set"; else echo "  ✗ DISCORD_TOKEN missing!"; fi && ` +
              `if grep -q "CLIENT_ID=" ${remoteDir}/.env; then echo "  ✓ CLIENT_ID is set"; else echo "  ✗ CLIENT_ID missing!"; fi; ` +
            `else echo "  ✗ .env file NOT found - upload it first!"; fi`,
            'echo ""',

            'echo "▸ Testing outbound HTTPS..."',
            'curl -sf -o /dev/null -w "  ✓ HTTPS works (HTTP %{http_code}, %{time_total}s)" https://discord.com/api/v10/gateway || echo "  ✗ HTTPS failed - check firewall"',
            'echo ""',

            'echo "▸ DNS resolution test..."',
            'host discord.com 2>/dev/null && echo "  ✓ DNS working" || (nslookup discord.com 2>/dev/null && echo "  ✓ DNS working" || echo "  ✗ DNS resolution failed")',
          ].join(" && ");
          break;

        case "commands_refresh":
          remoteCmd = `echo "▸ Re-registering Discord slash commands..." && cd ${remoteDir} && npm run register-commands && echo "" && echo "  ✓ Slash commands synced with Discord API"`;
          break;

        case "custom":
          remoteCmd = payload.command || 'echo "No command provided"';
          break;

        default:
          remoteCmd = 'echo "Unknown action"';
      }

      const args = getSshArgs(cfg, remoteCmd);
      const proc = spawn("ssh", args, { stdio: ["ignore", "pipe", "pipe"] });

      proc.stdout.on("data", (data) => res.write(data));
      proc.stderr.on("data", (data) => res.write(data));

      proc.on("error", (err) => {
        res.write(`\n❌ Failed to launch ssh.exe: ${err.message}\n`);
        res.end();
      });

      proc.on("close", (code) => {
        res.write(`\n--- [Process completed with exit code ${code}] ---\n`);
        res.end();
      });
    });
    return;
  }

  res.writeHead(404);
  res.end("Not Found");
});

// Try binding to port, if busy try next port
function startServer(port) {
  server.listen(port, "127.0.0.1", () => {
    const url = `http://localhost:${port}`;
    console.log("=================================================");
    console.log(` 🚀 CLIT-OF Control Panel is live at: ${url}`);
    console.log(" Opening your web browser automatically...");
    console.log(" Press Ctrl+C in this terminal window to close.");
    console.log("=================================================");

    // Open browser automatically on Windows
    exec(`start ${url}`);
  });

  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      startServer(port + 1);
    } else {
      console.error("Server error:", err);
    }
  });
}

startServer(DEFAULT_PORT);
