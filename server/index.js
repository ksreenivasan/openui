import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import cors from 'cors';
import pty from 'node-pty';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 6969;

// Store active PTY sessions
const sessions = new Map();

app.use(cors());
app.use(express.json());

// Serve static files from the built client
app.use(express.static(join(__dirname, '../client/dist')));

// API endpoint to list available agents
app.get('/api/agents', (req, res) => {
  res.json([
    { 
      id: 'claude', 
      name: 'Claude Code', 
      command: 'claude',
      description: 'Anthropic\'s official CLI for Claude',
      color: '#D97706',
      icon: 'sparkles'
    },
    { 
      id: 'opencode', 
      name: 'OpenCode', 
      command: 'opencode',
      description: 'Open source AI coding assistant',
      color: '#10B981',
      icon: 'code'
    }
  ]);
});

// API endpoint to get session info
app.get('/api/sessions', (req, res) => {
  const sessionList = [];
  for (const [id, session] of sessions) {
    sessionList.push({
      id,
      agentId: session.agentId,
      agentName: session.agentName,
      createdAt: session.createdAt,
      cwd: session.cwd
    });
  }
  res.json(sessionList);
});

// API endpoint to create a new session
app.post('/api/sessions', (req, res) => {
  const { agentId, agentName, command, cwd } = req.body;
  const sessionId = `session-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  
  // Create PTY process
  const shell = process.platform === 'win32' ? 'powershell.exe' : 'bash';
  const ptyProcess = pty.spawn(shell, [], {
    name: 'xterm-256color',
    cols: 120,
    rows: 30,
    cwd: cwd || process.env.HOME,
    env: { ...process.env, TERM: 'xterm-256color' }
  });

  sessions.set(sessionId, {
    pty: ptyProcess,
    agentId,
    agentName,
    command,
    cwd: cwd || process.env.HOME,
    createdAt: new Date().toISOString(),
    clients: new Set()
  });

  // After a short delay, send the agent command
  setTimeout(() => {
    ptyProcess.write(`${command}\r`);
  }, 500);

  console.log(`Created session ${sessionId} for ${agentName}`);
  res.json({ sessionId });
});

// API endpoint to kill a session
app.delete('/api/sessions/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  const session = sessions.get(sessionId);
  
  if (session) {
    session.pty.kill();
    sessions.delete(sessionId);
    console.log(`Killed session ${sessionId}`);
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'Session not found' });
  }
});

// WebSocket handling
wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const sessionId = url.searchParams.get('sessionId');

  if (!sessionId) {
    ws.close(1008, 'Session ID required');
    return;
  }

  const session = sessions.get(sessionId);
  if (!session) {
    ws.close(1008, 'Session not found');
    return;
  }

  console.log(`WebSocket connected to session ${sessionId}`);
  session.clients.add(ws);

  // Send PTY output to WebSocket
  const dataHandler = (data) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: 'output', data }));
    }
  };
  session.pty.onData(dataHandler);

  // Handle incoming messages from WebSocket
  ws.on('message', (message) => {
    try {
      const msg = JSON.parse(message.toString());
      
      switch (msg.type) {
        case 'input':
          session.pty.write(msg.data);
          break;
        case 'resize':
          session.pty.resize(msg.cols, msg.rows);
          break;
      }
    } catch (e) {
      console.error('Error processing message:', e);
    }
  });

  ws.on('close', () => {
    console.log(`WebSocket disconnected from session ${sessionId}`);
    session.clients.delete(ws);
  });
});

// Serve the React app for all other routes
app.get('*', (req, res) => {
  res.sendFile(join(__dirname, '../client/dist/index.html'));
});

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

// Cleanup on exit
process.on('SIGINT', () => {
  for (const [id, session] of sessions) {
    session.pty.kill();
  }
  process.exit(0);
});
