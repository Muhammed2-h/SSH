const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { Client } = require('ssh2');
const session = require('express-session');
const cookie = require('cookie');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { SocksClient } = require('socks');

// Load .env manually if not on Railway
try {
  const envFile = fs.readFileSync('.env', 'utf8');
  envFile.split('\n').forEach(line => {
    const match = line.match(/^([^=]+)=(.*)$/);
    if (match) {
      if (!process.env[match[1]]) process.env[match[1]] = match[2].trim();
    }
  });
} catch (e) {
  // Ignore error if .env doesn't exist
}

const APP_USER = process.env.APP_USER || 'admin';
const APP_PASS = process.env.APP_PASS || 'yourpassword';
const SESSION_SECRET = process.env.SESSION_SECRET || 'supersecretrandomstring';
let SSH_PRIVATE_KEY = process.env.SSH_PRIVATE_KEY || '';
const PORT = process.env.PORT || 3000;

if (SSH_PRIVATE_KEY) {
  SSH_PRIVATE_KEY = SSH_PRIVATE_KEY.replace(/\\n/g, '\n');
}

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const sessionMiddleware = session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true }
});

app.use(sessionMiddleware);
app.use(express.static(path.join(__dirname, 'public')));

function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) return next();
  res.redirect('/');
}

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.post('/login', (req, res) => {
  if (req.body.username === APP_USER && req.body.password === APP_PASS) {
    req.session.authenticated = true;
    res.redirect('/terminal');
  } else {
    res.redirect('/?error=1');
  }
});

app.get('/terminal', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'terminal.html'));
});

app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/');
});

app.post('/save-host', requireAuth, (req, res) => {
  req.session.lastHost = {
    host: req.body.host,
    port: req.body.port,
    username: req.body.username
  };
  res.json({ ok: true });
});

app.get('/last-host', requireAuth, (req, res) => {
  res.json(req.session.lastHost || {});
});

app.get('/has-key', requireAuth, (req, res) => {
  res.json({ hasKey: !!SSH_PRIVATE_KEY });
});

app.get('/ts-status', requireAuth, (req, res) => {
  const { exec } = require('child_process');
  exec('tailscale --socket=./tailscaled.sock status', (err, stdout, stderr) => {
    res.json({ status: stdout || stderr || err?.message || 'Unknown error' });
  });
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws, req) => {
  const fakeRes = { getHeader: () => {}, setHeader: () => {}, end: () => {} };
  sessionMiddleware(req, fakeRes, () => {
    if (!req.session || !req.session.authenticated) {
      ws.close(4401, 'Unauthorized');
      return;
    }
    handleSSHSession(ws, req);
  });
});

function handleSSHSession(ws, req) {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  const pingInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      if (ws.isAlive === false) return ws.terminate();
      ws.isAlive = false;
      ws.ping();
    }
  }, 30000);

  let conn = null;
  let stream = null;

  ws.on('message', (msg) => {
    if (!conn) {
      // Expect first message to be connect instructions
      try {
        const data = JSON.parse(msg);
        if (data.type === 'connect') {
          conn = new Client();
          
          const sshConfig = {
            host: data.host,
            port: parseInt(data.port) || 22,
            username: data.username,
            readyTimeout: 10000,
            keepaliveInterval: 5000
          };

          if (data.authMethod === 'serverkey') {
            sshConfig.privateKey = SSH_PRIVATE_KEY;
          } else if (data.authMethod === 'key') {
            sshConfig.privateKey = data.privateKey;
          } else if (data.authMethod === 'password') {
            sshConfig.password = data.password;
          }

          conn.on('ready', () => {
            conn.shell({ term: 'xterm-256color', rows: parseInt(data.rows) || 24, cols: parseInt(data.cols) || 80 }, (err, s) => {
              if (err) {
                if (ws.readyState === WebSocket.OPEN) {
                  ws.send(JSON.stringify({ type: 'error', message: err.message }));
                  ws.close();
                }
                return;
              }
              stream = s;
              
              stream.on('data', (d) => {
                if (ws.readyState === WebSocket.OPEN) ws.send(d);
              });
              
              stream.stderr.on('data', (d) => {
                if (ws.readyState === WebSocket.OPEN) ws.send(d);
              });
              
              stream.on('close', () => {
                if (ws.readyState === WebSocket.OPEN) {
                  ws.send(JSON.stringify({ type: 'disconnect', reason: 'stream closed' }));
                  ws.close();
                }
              });
            });
          });

          conn.on('error', (err) => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'error', message: err.message }));
              ws.close();
            }
          });

          if (data.host.startsWith('100.') || data.host.endsWith('.ts.net')) {
            SocksClient.createConnection({
              proxy: { ipaddress: '127.0.0.1', port: 1055, type: 5 },
              command: 'connect',
              destination: { host: sshConfig.host, port: sshConfig.port }
            }).then(info => {
              sshConfig.sock = info.socket;
              conn.connect(sshConfig);
            }).catch(err => {
              if (ws.readyState === WebSocket.OPEN) {
                let msg = 'Tailscale Proxy Error: ' + err.message;
                if (err.message.includes('rejected connection')) {
                  msg += '\r\n(Hint: Ensure Tailscale is connected properly on Railway, the target machine is online in your Tailnet, and port 22 is open)';
                }
                ws.send(JSON.stringify({ type: 'error', message: msg }));
                ws.close();
              }
            });
          } else {
            conn.connect(sshConfig);
          }
        }
      } catch (err) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'error', message: 'Invalid connect message' }));
          ws.close();
        }
      }
    } else if (stream) {
      try {
        const data = JSON.parse(msg);
        if (data.type === 'resize') {
          stream.setWindow(parseInt(data.rows), parseInt(data.cols), 0, 0);
        } else if (data.type === 'data') {
          stream.write(data.data);
        }
      } catch (err) {
        stream.write(msg);
      }
    }
  });

  ws.on('close', () => {
    clearInterval(pingInterval);
    if (conn) conn.end();
  });
}

server.listen(PORT, () => console.log('Listening on port ' + PORT));

process.on('SIGTERM', () => {
  server.close(() => {
    console.log('Process terminated');
  });
});
