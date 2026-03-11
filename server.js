const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { Client } = require('ssh2');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const { SocksClient } = require('socks');
const { exec, spawn } = require('child_process');

// ─── Absolute path to tailscaled socket (must match start.sh) ────────────────
const TS_SOCKET = '/tmp/tailscaled.sock';

// ─── Load .env locally (not on Railway) ──────────────────────────────────────
try {
  const envFile = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
  envFile.split('\n').forEach(line => {
    const match = line.match(/^([^#][^=]*)=(.*)$/);
    if (match && !process.env[match[1].trim()]) {
      process.env[match[1].trim()] = match[2].trim();
    }
  });
} catch (_) { /* no .env in production */ }

const APP_USER = process.env.APP_USER || 'admin';
const APP_PASS = process.env.APP_PASS || 'yourpassword';
const SESSION_SECRET = process.env.SESSION_SECRET || 'supersecretrandomstring';
const PORT = parseInt(process.env.PORT || '3000', 10);
let SSH_PRIVATE_KEY = (process.env.SSH_PRIVATE_KEY || '').replace(/\\n/g, '\n');

// ─── Express app ──────────────────────────────────────────────────────────────
const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const sessionMiddleware = session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true },
});
app.use(sessionMiddleware);
app.use(express.static(path.join(__dirname, 'public')));

function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) return next();
  res.redirect('/');
}

// ─── Routes ───────────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.post('/login', (req, res) => {
  if (req.body.username === APP_USER && req.body.password === APP_PASS) {
    req.session.authenticated = true;
    return res.redirect('/terminal');
  }
  res.redirect('/?error=1');
});

app.get('/terminal', requireAuth, (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'terminal.html'))
);

app.get('/logout', (req, res) => { req.session.destroy(); res.redirect('/'); });

app.post('/save-host', requireAuth, (req, res) => {
  req.session.lastHost = { host: req.body.host, port: req.body.port, username: req.body.username };
  res.json({ ok: true });
});

app.get('/last-host', requireAuth, (req, res) => res.json(req.session.lastHost || {}));

app.get('/has-key', requireAuth, (req, res) => res.json({ hasKey: !!SSH_PRIVATE_KEY }));

// ─── Tailscale: status ────────────────────────────────────────────────────────
app.get('/ts-status', requireAuth, (req, res) => {
  exec(`tailscale --socket="${TS_SOCKET}" status`, (err, stdout, stderr) => {
    const out = stdout || stderr || (err && err.message) || 'No output';
    res.json({ status: out });
  });
});

// ─── Tailscale: trigger login URL ─────────────────────────────────────────────
// Uses `tailscale login` (not `tailscale up`) — this command exists solely to
// generate/return a login URL on stdout/stderr and exit cleanly.
app.get('/ts-login', requireAuth, (req, res) => {
  const args = ['--socket=' + TS_SOCKET, 'login', '--hostname=railway-terminal'];
  const child = spawn('tailscale', args, { env: { ...process.env } });

  let output = '';
  let responded = false;

  const handleChunk = (buf) => {
    const text = buf.toString();
    output += text;
    console.log('[ts-login]', text.replace(/\n/g, ' '));

    // Extract URL — use a broad pattern
    const m = output.match(/(https:\/\/login\.tailscale\.com\/[^\s\r\n]+)/);
    if (m && !responded) {
      responded = true;
      child.kill('SIGTERM');
      return res.json({ url: m[1].trim() });
    }
    // Detect already-authenticated
    if (/success|already logged in|already authenticated/i.test(text) && !responded) {
      responded = true;
      child.kill('SIGTERM');
      return res.json({ url: null, message: '✅ Already authenticated! Click TS Status to verify your peers.' });
    }
  };

  child.stdout.on('data', handleChunk);
  child.stderr.on('data', handleChunk);

  child.on('close', () => {
    if (!responded) {
      responded = true;
      res.json({ url: null, message: 'Output:\n' + (output || '(empty — socket may not be ready yet)') });
    }
  });

  child.on('error', (err) => {
    if (!responded) {
      responded = true;
      res.json({ url: null, message: 'spawn error: ' + err.message });
    }
  });

  // 30s timeout
  setTimeout(() => {
    if (!responded) {
      responded = true;
      child.kill('SIGTERM');
      res.json({ url: null, message: 'Timeout (30s).\nOutput:\n' + (output || '(empty)') });
    }
  }, 30000);
});

// ─── WebSocket + HTTP server ──────────────────────────────────────────────────
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws, req) => {
  const fakeRes = { getHeader: () => {}, setHeader: () => {}, end: () => {} };
  sessionMiddleware(req, fakeRes, () => {
    if (!req.session || !req.session.authenticated) {
      ws.close(4401, 'Unauthorized');
      return;
    }
    handleSSHSession(ws);
  });
});

// ─── SSH session handler ──────────────────────────────────────────────────────
function handleSSHSession(ws) {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  const ping = setInterval(() => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  }, 30000);

  let conn = null;
  let stream = null;
  let connected = false;

  ws.on('message', (raw) => {
    // ── Pre-connection: expect the first JSON 'connect' message ──────────────
    if (!connected) {
      let msg;
      try { msg = JSON.parse(raw); } catch (_) { return; }
      if (msg.type !== 'connect') return;
      connected = true;

      const { host, port, username, authMethod, password, privateKey, rows, cols } = msg;

      const sshCfg = {
        host,
        port: parseInt(port) || 22,
        username,
        readyTimeout: 30000,
        keepaliveInterval: 15000,
      };

      if (authMethod === 'password') {
        sshCfg.password = password;
        sshCfg.tryKeyboard = true;
        sshCfg.authHandler = ['password', 'keyboard-interactive'];
      } else if (authMethod === 'key') {
        sshCfg.privateKey = privateKey;
      } else if (authMethod === 'serverkey') {
        sshCfg.privateKey = SSH_PRIVATE_KEY;
      }

      // Create client FIRST, then attach all handlers
      conn = new Client();

      // keyboard-interactive: auto-reply to any "Password:" prompts
      conn.on('keyboard-interactive', (name, instructions, il, prompts, finish) => {
        finish(prompts.map(() => password || ''));
      });

      conn.on('ready', () => {
        conn.shell(
          { term: 'xterm-256color', rows: parseInt(rows) || 24, cols: parseInt(cols) || 80 },
          (err, s) => {
            if (err) return wsSend(ws, { type: 'error', message: err.message });
            stream = s;
            stream.on('data', (d) => { if (ws.readyState === WebSocket.OPEN) ws.send(d); });
            stream.stderr.on('data', (d) => { if (ws.readyState === WebSocket.OPEN) ws.send(d); });
            stream.on('close', () => {
              wsSend(ws, { type: 'disconnect', reason: 'stream closed' });
              ws.close();
            });
          }
        );
      });

      conn.on('error', (err) => {
        wsSend(ws, { type: 'error', message: err.message });
        ws.close();
      });

      // Route Tailscale IPs through local SOCKS5 proxy
      const isTailscale = /^100\./.test(host) || host.endsWith('.ts.net');
      if (isTailscale) {
        SocksClient.createConnection({
          proxy: { ipaddress: '127.0.0.1', port: 1055, type: 5 },
          command: 'connect',
          destination: { host: sshCfg.host, port: sshCfg.port },
        }).then(({ socket }) => {
          sshCfg.sock = socket;
          conn.connect(sshCfg);
        }).catch((err) => {
          wsSend(ws, { type: 'error', message: 'SOCKS error: ' + err.message + '\n\nIs Tailscale connected? Run TS Status to check.' });
          ws.close();
        });
      } else {
        conn.connect(sshCfg);
      }
      return;
    }

    // ── Post-connection: forward data / resize ───────────────────────────────
    if (!stream) return;
    let msg;
    try { msg = JSON.parse(raw); } catch (_) { stream.write(raw); return; }
    if (msg.type === 'data')   stream.write(msg.data);
    if (msg.type === 'resize') stream.setWindow(parseInt(msg.rows), parseInt(msg.cols), 0, 0);
  });

  ws.on('close', () => {
    clearInterval(ping);
    if (conn) conn.end();
  });
}

function wsSend(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

// ─── Start ────────────────────────────────────────────────────────────────────
server.listen(PORT, () => console.log(`[server] Listening on port ${PORT}`));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
