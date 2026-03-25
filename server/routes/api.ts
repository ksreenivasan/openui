import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { Agent } from "../types";
import { sessions, createSession, deleteSession, injectPluginDir, broadcastToSession, MAX_BUFFER_SIZE, getGitBranch, DEFAULT_CLAUDE_COMMAND, resolveResumeCwd, handleKittyProtocol } from "../services/sessionManager";
import { loadState, saveState, savePositions, getDataDir, loadCanvases, saveCanvases, migrateCategoriesToCanvases, atomicWriteJson, loadBuffer } from "../services/persistence";
import { signalSessionReady, getQueueProgress } from "../services/sessionStartQueue";
import { getTokensForSession } from "../services/costCache";
import { spawnSync } from "bun";
import { join, dirname } from "path";
import { homedir } from "os";
import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync } from "fs";

const LAUNCH_CWD = process.env.LAUNCH_CWD || process.cwd();
const QUIET = !!process.env.OPENUI_QUIET;
const log = QUIET ? () => {} : console.log.bind(console);
const logError = QUIET ? () => {} : console.error.bind(console);

export const apiRoutes = new Hono();

apiRoutes.get("/config", (c) => {
  return c.json({ launchCwd: LAUNCH_CWD, dataDir: getDataDir(), homeDir: homedir() });
});

// Get auto-resume configuration and status
apiRoutes.get("/auto-resume/config", (c) => {
  const { getAutoResumeConfig, getSessionsToResume } = require("../services/autoResume");
  const config = getAutoResumeConfig();
  const sessionsToResume = getSessionsToResume();

  return c.json({
    config,
    sessionsToResumeCount: sessionsToResume.length,
    sessions: sessionsToResume.map((s: any) => ({
      sessionId: s.sessionId,
      nodeId: s.nodeId,
      agentName: s.agentName,
      canvasId: s.canvasId,
    })),
  });
});

// Get auto-resume queue progress
apiRoutes.get("/auto-resume/progress", (c) => {
  return c.json(getQueueProgress());
});

// Browse directories for file picker
apiRoutes.get("/browse", async (c) => {
  const { readdirSync, statSync } = await import("fs");
  const { join, resolve } = await import("path");
  const { homedir } = await import("os");

  let path = c.req.query("path") || LAUNCH_CWD;

  // Handle ~ for home directory
  if (path.startsWith("~")) {
    path = path.replace("~", homedir());
  }

  // Resolve to absolute path
  path = resolve(path);

  try {
    const entries = readdirSync(path, { withFileTypes: true });
    const directories = entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => ({
        name: entry.name,
        path: join(path, entry.name),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    // Get parent directory
    const parentPath = resolve(path, "..");

    return c.json({
      current: path,
      parent: parentPath !== path ? parentPath : null,
      directories,
    });
  } catch (e: any) {
    return c.json({ error: e.message, current: path }, 400);
  }
});

apiRoutes.get("/agents", (c) => {
  const agents: Agent[] = [
    {
      id: "claude",
      name: "Claude Code",
      command: DEFAULT_CLAUDE_COMMAND,
      description: "Anthropic's official CLI for Claude",
      color: "#F97316",
      icon: "sparkles",
    },
    {
      id: "opencode",
      name: "OpenCode",
      command: "opencode",
      description: "Open source AI coding assistant",
      color: "#22C55E",
      icon: "code",
    },
    {
      id: "ralph",
      name: "Ralph",
      command: "",
      description: "Autonomous dev loop (ralph, ralph-setup, ralph-import)",
      color: "#8B5CF6",
      icon: "brain",
    },
  ];
  return c.json(agents);
});

apiRoutes.get("/sessions", (c) => {
  const showArchived = c.req.query("archived") === "true";

  // For archived sessions, load from state.json since they're not in sessions Map
  if (showArchived) {
    const state = loadState();
    const archivedSessions = state.nodes
      .filter(node => node.archived)
      .map(node => ({
        sessionId: node.sessionId,
        nodeId: node.nodeId,
        agentId: node.agentId,
        agentName: node.agentName,
        command: node.command,
        createdAt: node.createdAt,
        cwd: node.cwd,
        gitBranch: node.gitBranch,
        status: "disconnected",
        customName: node.customName,
        customColor: node.customColor,
        notes: node.notes,
        isRestored: false,
        ticketId: node.ticketId,
        ticketTitle: node.ticketTitle,
        canvasId: node.canvasId,
      }));
    return c.json(archivedSessions);
  }

  // For active sessions, get from sessions Map
  const sessionList = Array.from(sessions.entries())
    .filter(([, session]) => !session.archived)
    .map(([id, session]) => {
      // Compute effective status: if stuck in waiting_input but user already approved
      // a sleep command, flip to "waiting" (no hook events arrive during the sleep).
      // Recalculate sleepEndTime from approval time since the sleep doesn't start
      // until the user approves the permission prompt.
      let effectiveStatus = session.status;
      if (
        session.status === "waiting_input" &&
        session.sleepEndTime &&
        session.sleepDuration &&
        session.needsInputSince &&
        session.lastInputTime > session.needsInputSince
      ) {
        session.sleepEndTime = session.lastInputTime + session.sleepDuration * 1000;
        effectiveStatus = "waiting";
        session.status = "waiting";
        session.needsInputSince = undefined;
      }

      return {
        sessionId: id,
        nodeId: session.nodeId,
        agentId: session.agentId,
        agentName: session.agentName,
        command: session.command,
        createdAt: session.createdAt,
        cwd: session.cwd,
        gitBranch: session.gitBranch,
        status: effectiveStatus,
        customName: session.customName,
        customColor: session.customColor,
        notes: session.notes,
        isRestored: session.isRestored,
        ticketId: session.ticketId,
        ticketTitle: session.ticketTitle,
        canvasId: session.canvasId, // Canvas/tab this agent belongs to
        longRunningTool: session.longRunningTool || false,
        tokens: getTokensForSession(session.claudeSessionId) ?? session.tokens,
        model: session.model,
        sleepEndTime: session.sleepEndTime,
      };
    });
  return c.json(sessionList);
});

apiRoutes.get("/sessions/:sessionId/status", (c) => {
  const sessionId = c.req.param("sessionId");
  const session = sessions.get(sessionId);
  if (!session) return c.json({ error: "Session not found" }, 404);

  return c.json({ status: session.status, isRestored: session.isRestored });
});

apiRoutes.get("/state", (c) => {
  const state = loadState();
  const showArchived = c.req.query("archived") === "true";

  const nodes = state.nodes
    .filter(node => showArchived ? node.archived : !node.archived)
    .map(node => {
      const session = sessions.get(node.sessionId);
      return {
        ...node,
        status: session?.status || "disconnected",
        isAlive: !!session,
        isRestored: session?.isRestored,
      };
    })
    // For archived view, show all archived sessions even if not alive
    // For active view, only show sessions that are currently running
    .filter(n => showArchived || n.isAlive);

  return c.json({ nodes });
});

apiRoutes.post("/state/positions", async (c) => {
  const { positions } = await c.req.json();

  // Also update session positions and canvasId in memory
  for (const [nodeId, pos] of Object.entries(positions)) {
    for (const [, session] of sessions) {
      if (session.nodeId === nodeId) {
        const posData = pos as { x: number; y: number; canvasId?: string };
        session.position = { x: posData.x, y: posData.y };
        session.canvasId = posData.canvasId || session.canvasId;
        break;
      }
    }
  }

  // Save to disk
  savePositions(positions);
  return c.json({ success: true });
});

apiRoutes.post("/sessions", async (c) => {
  const body = await c.req.json();
  const {
    agentId,
    agentName,
    command,
    cwd,
    nodeId,
    customName,
    customColor,
    // Ticket and worktree options
    ticketId,
    ticketTitle,
    ticketUrl,
    branchName,
    baseBranch,
    prNumber,
  } = body;

  const sessionId = `session-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  let rawCwd = cwd ? cwd.replace(/^~(?=$|\/)/, homedir()) : LAUNCH_CWD;

  // When resuming a session, resolve the correct cwd.
  // First check state.json, then verify against Claude's JSONL to handle cwd drift.
  const resumeMatch = command?.match(/--resume\s+([\w-]+)/);
  if (resumeMatch) {
    const claudeSessionId = resumeMatch[1];
    const state = loadState();
    const matchingNode = state.nodes.find(n =>
      n.claudeSessionId === claudeSessionId ||
      n.command?.includes(`--resume ${claudeSessionId}`)
    );
    if (matchingNode?.cwd) {
      log(`\x1b[38;5;141m[session]\x1b[0m Resume: using archived cwd ${matchingNode.cwd}`);
      rawCwd = matchingNode.cwd;
    }
    // Verify against Claude's session JSONL (cwd in state.json may have drifted)
    rawCwd = resolveResumeCwd(rawCwd, claudeSessionId);
  }

  const workingDir = rawCwd;

  try {
    const result = await createSession({
      sessionId,
      agentId,
      agentName,
      command,
      cwd: workingDir,
      nodeId,
      customName,
      customColor,
      ticketId,
      ticketTitle,
      ticketUrl,
      branchName,
      baseBranch,
      prNumber,
      ticketPromptTemplate: undefined,
    });

    saveState(sessions);
    return c.json({
      sessionId,
      nodeId,
      cwd: result.cwd,
      gitBranch: result.gitBranch,
    });
  } catch (error) {
    console.error("[session creation error]", error);
    return c.json({ error: String(error) }, 500);
  }
});

apiRoutes.post("/sessions/:sessionId/restart", async (c) => {
  const sessionId = c.req.param("sessionId");
  let session = sessions.get(sessionId);

  // If not in active sessions, check archived sessions in state.json
  if (!session) {
    const state = loadState();
    const archivedNode = state.nodes.find(n => n.sessionId === sessionId && n.archived);
    if (!archivedNode) return c.json({ error: "Session not found" }, 404);

    // Restore archived session into the sessions Map
    const buffer = loadBuffer(sessionId);

    session = {
      pty: null,
      agentId: archivedNode.agentId,
      agentName: archivedNode.agentName,
      command: archivedNode.command,
      cwd: archivedNode.cwd,
      launchCwd: archivedNode.launchCwd || homedir(),
      gitBranch: archivedNode.gitBranch || getGitBranch(archivedNode.cwd) || undefined,
      createdAt: archivedNode.createdAt,
      clients: new Set(),
      outputBuffer: buffer,
      outputSeq: 0,
      status: "disconnected",
      lastOutputTime: 0,
      lastInputTime: 0,
      recentOutputSize: 0,
      customName: archivedNode.customName,
      customColor: archivedNode.customColor,
      notes: archivedNode.notes,
      nodeId: archivedNode.nodeId,
      isRestored: true,
      claudeSessionId: archivedNode.claudeSessionId,
      archived: false,
      canvasId: archivedNode.canvasId,
      ticketId: archivedNode.ticketId,
      ticketTitle: archivedNode.ticketTitle,
      ticketUrl: archivedNode.ticketUrl,
    };
    sessions.set(sessionId, session);
    log(`\x1b[38;5;141m[restart]\x1b[0m Restored archived session ${sessionId} into sessions Map`);
  }

  if (session.pty) return c.json({ error: "Session already running" }, 400);

  const startFn = async () => {
    const { spawn } = await import("bun-pty");
    const ptyProcess = spawn("/bin/bash", [], {
      name: "xterm-256color",
      cwd: session.launchCwd || session.cwd,
      env: {
        ...process.env,
        TERM: "xterm-256color",
        OPENUI_SESSION_ID: sessionId,
      },
      rows: 30,
      cols: 120,
    });

    session.pty = ptyProcess;
    session.isRestored = false;
    session.status = "running";
    session.lastOutputTime = Date.now();

    const resetInterval = setInterval(() => {
      if (!sessions.has(sessionId) || !session.pty) {
        clearInterval(resetInterval);
        return;
      }
      session.recentOutputSize = Math.max(0, session.recentOutputSize - 50);
    }, 500);

    ptyProcess.onData((data: string) => {
      const filtered = handleKittyProtocol(data, ptyProcess);
      session.outputBuffer.push(filtered);
      session.outputSeq++;
      if (session.outputBuffer.length > MAX_BUFFER_SIZE) {
        session.outputBuffer.shift();
      }

      session.lastOutputTime = Date.now();
      session.recentOutputSize += filtered.length;

      broadcastToSession(session, { type: "output", data: filtered });
    });

    // Build the command with resume flag if we have a Claude session ID
    let finalCommand = injectPluginDir(session.command, session.agentId);

    // For Claude sessions, use --resume to restore the specific session.
    // If the command already has --resume, that's the canonical ID — use it as-is.
    // Only inject from claudeSessionId when there's no --resume yet (first resume).
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const existingResume = session.command.match(/--resume\s+([\w-]+)/);
    if (existingResume) {
      log(`\x1b[38;5;141m[session]\x1b[0m Using existing --resume ${existingResume[1]} from command`);
    } else if (session.agentId === "claude" && session.claudeSessionId && UUID_RE.test(session.claudeSessionId)) {
      const resumeArg = `--resume ${session.claudeSessionId}`;
      if (finalCommand.startsWith("claude")) {
        finalCommand = finalCommand.replace(/^claude(\s|$)/, `claude ${resumeArg}$1`);
      }
      // Persist --resume into the command so future restarts use the correct ID
      session.command = session.command.replace(/^claude/, `claude ${resumeArg}`);
      log(`\x1b[38;5;141m[session]\x1b[0m Resuming Claude session: ${session.claudeSessionId} (persisted to command)`);
    }

    // Claude Code scopes --resume sessions to the directory they were created in.
    // The PTY spawns in session.launchCwd (which may be a worktree), but claude
    // sessions are typically created from the home directory.
    // For resume: cd to ~ first. For fresh launches: use the PTY's cwd as-is.
    const hasResume = finalCommand.includes("--resume");
    setTimeout(() => {
      if (hasResume) {
        ptyProcess.write(`cd ~ && ${finalCommand}\r`);
      } else {
        ptyProcess.write(`${finalCommand}\r`);
      }
    }, 300);

    log(`\x1b[38;5;141m[session]\x1b[0m Restarted ${sessionId}`);
  };

  // Start immediately -- the queue is only for mass auto-resume at startup
  startFn();

  return c.json({ success: true });
});

// Fork a Claude session (creates new node with --fork-session)
apiRoutes.post("/sessions/:sessionId/fork", async (c) => {
  const sessionId = c.req.param("sessionId");
  const session = sessions.get(sessionId);
  if (!session) return c.json({ error: "Session not found" }, 404);

  // Only Claude sessions with a known claudeSessionId can be forked
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (session.agentId !== "claude" || !session.claudeSessionId || !UUID_RE.test(session.claudeSessionId)) {
    return c.json({ error: "Session cannot be forked (not a Claude session or no session ID yet)" }, 400);
  }

  const body = await c.req.json().catch(() => ({}));
  const position = body.position || { x: 0, y: 0 };
  const canvasId = body.canvasId || session.canvasId;

  // Generate new IDs
  const now = Date.now();
  const newSessionId = `session-${now}-${Math.random().toString(36).slice(2, 8)}`;
  const newNodeId = `node-${now}-0`;

  const parentName = session.customName || session.agentName || "Agent";
  const customName = body.customName || `${parentName} (fork)`;
  const customColor = body.customColor || session.customColor;

  let effectiveCwd = (body.cwd ? body.cwd.replace(/^~(?=$|\/)/, homedir()) : null) || session.cwd;
  let gitBranch = session.gitBranch;

  // Set up worktree for branch isolation
  if (body.branchName) {
    // Check if the branch is already checked out in an existing worktree
    let existingWorktreePath: string | null = null;
    try {
      const wtResult = spawnSync(["git", "worktree", "list", "--porcelain"], {
        cwd: effectiveCwd, stdout: "pipe", stderr: "pipe",
      });
      if (wtResult.exitCode === 0) {
        const blocks = wtResult.stdout.toString().split("\n\n");
        for (const block of blocks) {
          if (block.includes(`branch refs/heads/${body.branchName}\n`) || block.endsWith(`branch refs/heads/${body.branchName}`)) {
            const pathMatch = block.match(/^worktree (.+)$/m);
            if (pathMatch) {
              existingWorktreePath = pathMatch[1];
              break;
            }
          }
        }
      }
    } catch {}

    if (existingWorktreePath) {
      log(`\x1b[38;5;141m[git]\x1b[0m Branch "${body.branchName}" already at ${existingWorktreePath}`);
      effectiveCwd = existingWorktreePath;
    } else {
      const { createWorktreeForBranch } = await import("../services/sessionManager");
      const worktreeCwd = createWorktreeForBranch(effectiveCwd, body.branchName, body.baseBranch);
      if (worktreeCwd) {
        effectiveCwd = worktreeCwd;
        log(`\x1b[38;5;141m[git]\x1b[0m Using worktree at ${worktreeCwd} for branch "${body.branchName}"`);
      }
    }
    gitBranch = body.branchName;
  }
  if (body.prNumber) {
    if (!gitBranch) gitBranch = `PR #${body.prNumber}`;
  }

  if (body.cwd && !body.branchName) {
    // Custom directory without worktree — detect git branch
    gitBranch = getGitBranch(effectiveCwd) || undefined;
  }

  const { spawn } = await import("bun-pty");
  const ptyProcess = spawn("/bin/bash", [], {
    name: "xterm-256color",
    cwd: effectiveCwd,
    env: {
      ...process.env,
      TERM: "xterm-256color",
      OPENUI_SESSION_ID: newSessionId,
    },
    rows: 30,
    cols: 120,
  });

  const newSession = {
    pty: ptyProcess,
    agentId: session.agentId,
    agentName: session.agentName,
    command: session.command,
    cwd: effectiveCwd,
    gitBranch,
    createdAt: new Date().toISOString(),
    clients: new Set() as any,
    outputBuffer: [] as string[],
    outputSeq: 0,
    status: "running" as const,
    lastOutputTime: Date.now(),
    lastInputTime: 0,
    recentOutputSize: 0,
    customName,
    customColor,
    nodeId: newNodeId,
    isRestored: false,
    autoResumed: false,
    claudeSessionId: undefined,
    archived: false,
    canvasId,
    position,
    ticketId: session.ticketId,
    ticketTitle: session.ticketTitle,
    ticketUrl: session.ticketUrl,
  };

  sessions.set(newSessionId, newSession);

  const resetInterval = setInterval(() => {
    if (!sessions.has(newSessionId) || !newSession.pty) {
      clearInterval(resetInterval);
      return;
    }
    newSession.recentOutputSize = Math.max(0, newSession.recentOutputSize - 50);
  }, 500);

  ptyProcess.onData((data: string) => {
    const filtered = handleKittyProtocol(data, ptyProcess);
    newSession.outputBuffer.push(filtered);
    newSession.outputSeq++;
    if (newSession.outputBuffer.length > MAX_BUFFER_SIZE) {
      newSession.outputBuffer.shift();
    }
    newSession.lastOutputTime = Date.now();
    newSession.recentOutputSize += filtered.length;
    broadcastToSession(newSession, { type: "output", data: filtered });
  });

  // Build the fork command: inject plugin-dir, then --resume <id> --fork-session
  let finalCommand = injectPluginDir(session.command, session.agentId);
  finalCommand = finalCommand.replace(/--resume\s+[\w-]+/g, '').replace(/--resume(?=\s|$)/g, '').trim();
  const forkArg = `--resume ${session.claudeSessionId} --fork-session`;
  if (finalCommand.startsWith("claude")) {
    finalCommand = finalCommand.replace(/^claude(\s|$)/, `claude ${forkArg}$1`);
  }

  setTimeout(() => {
    ptyProcess.write(`${finalCommand}\r`);
  }, 300);

  saveState(sessions);

  log(`\x1b[38;5;141m[session]\x1b[0m Forked ${sessionId} -> ${newSessionId} (claude session: ${session.claudeSessionId})`);

  return c.json({
    sessionId: newSessionId,
    nodeId: newNodeId,
    cwd: effectiveCwd,
    gitBranch,
    canvasId,
    customName,
    agentId: session.agentId,
    agentName: session.agentName,
    customColor,
  });
});

apiRoutes.patch("/sessions/:sessionId", async (c) => {
  const sessionId = c.req.param("sessionId");
  const session = sessions.get(sessionId);
  if (!session) return c.json({ error: "Session not found" }, 404);

  const updates = await c.req.json();
  if (updates.customName !== undefined) session.customName = updates.customName;
  if (updates.customColor !== undefined) session.customColor = updates.customColor;
  if (updates.icon !== undefined) session.icon = updates.icon;
  if (updates.notes !== undefined) session.notes = updates.notes;

  saveState(sessions);
  return c.json({ success: true });
});

apiRoutes.delete("/sessions/:sessionId", (c) => {
  const sessionId = c.req.param("sessionId");

  // Remove from sessions Map if present (kills PTY)
  deleteSession(sessionId);

  // Also remove directly from state.json (handles archived/disk-only sessions)
  const state = loadState();
  const before = state.nodes.length;
  state.nodes = state.nodes.filter(n => n.sessionId !== sessionId);

  if (state.nodes.length < before) {
    const stateFile = join(homedir(), ".openui", "state.json");
    atomicWriteJson(stateFile, state);
    return c.json({ success: true });
  }

  return c.json({ error: "Session not found" }, 404);
});

// Archive/unarchive session
apiRoutes.patch("/sessions/:sessionId/archive", async (c) => {
  const sessionId = c.req.param("sessionId");
  const { archived } = await c.req.json();

  const session = sessions.get(sessionId);

  if (session) {
    // Session is active (in sessions Map) - update it directly
    console.log(`[archive] Updating active session ${sessionId} archived=${archived}`);
    session.archived = archived;
    saveState(sessions);
  } else {
    // Session is not active (archived) - update state.json directly
    console.log(`[archive] Session ${sessionId} not in Map, updating state.json directly`);
    const state = loadState();
    const node = state.nodes?.find(n => n.sessionId === sessionId);
    if (!node) {
      console.log(`[archive] ERROR: Session ${sessionId} not found in state.json`);
      return c.json({ error: "Session not found" }, 404);
    }

    console.log(`[archive] Found node, updating archived from ${node.archived} to ${archived}`);
    // Update archived status
    node.archived = archived;

    // Write state back atomically
    const stateFile = join(homedir(), ".openui", "state.json");
    atomicWriteJson(stateFile, state);
    console.log(`[archive] Wrote updated state to ${stateFile}`);
  }

  return c.json({ success: true });
});

// Session context endpoint for plugin hook systemMessage injection
apiRoutes.get("/sessions/:sessionId/context", (c) => {
  const sessionId = c.req.param("sessionId");
  const session = sessions.get(sessionId);
  if (!session) {
    return c.json({ error: "Session not found" }, 404);
  }

  return c.json({
    customName: session.customName || null,
    notes: session.notes || null,
    ticketId: session.ticketId || null,
    ticketTitle: session.ticketTitle || null,
    ticketUrl: session.ticketUrl || null,
  });
});

// ============ Config helpers (hoisted for use by working dir tracking) ============

const configPath = join(getDataDir(), "config.json");

function loadConfig(): Record<string, any> {
  try {
    if (existsSync(configPath)) {
      return JSON.parse(readFileSync(configPath, "utf8"));
    }
  } catch {}
  return {};
}

function saveConfig(config: Record<string, any>) {
  atomicWriteJson(configPath, config);
}

// ============ Working Dir Tracking ============

const FILE_TOOLS = new Set(["Read", "Edit", "Write", "Grep", "Glob"]);

function sanitizeSessionId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function trackWorkingDir(sessionId: string, filePath: string) {
  if (!filePath || !filePath.startsWith("/")) return;
  const dir = dirname(filePath);
  // Skip temp/build/node_modules dirs
  if (dir.includes("/node_modules/") || dir.includes("/tmp/") || dir.startsWith("/tmp")) return;
  const workspacesDir = join(getDataDir(), "workspaces");
  if (!existsSync(workspacesDir)) mkdirSync(workspacesDir, { recursive: true });
  const dirsFile = join(workspacesDir, `${sanitizeSessionId(sessionId)}-dirs.txt`);
  try {
    appendFileSync(dirsFile, dir + "\n");
  } catch {}
}

function seedWorkingDirs(sessionId: string, worktreeRoot: string) {
  const workspacesDir = join(getDataDir(), "workspaces");
  if (!existsSync(workspacesDir)) mkdirSync(workspacesDir, { recursive: true });
  const dirsFile = join(workspacesDir, `${sanitizeSessionId(sessionId)}-dirs.txt`);
  if (existsSync(dirsFile)) return; // Already seeded
  // Read template
  const config = loadConfig();
  const templatePath = config.cursorWorkspaceTemplate;
  if (!templatePath || !existsSync(templatePath)) return;
  try {
    const template = JSON.parse(readFileSync(templatePath, "utf8"));
    const lines = (template.folders || [])
      .map((f: { path: string }) => join(worktreeRoot, f.path))
      .join("\n") + "\n";
    writeFileSync(dirsFile, lines);
  } catch {}
}

// Status update endpoint for Claude Code plugin
apiRoutes.post("/status-update", async (c) => {
  const body = await c.req.json();
  const { status, openuiSessionId, claudeSessionId, cwd, hookEvent, toolName, stopReason, model, toolInput } = body;

  // Log the full raw payload for debugging
  log(`\x1b[38;5;82m[plugin-hook]\x1b[0m ${hookEvent || 'unknown'}: status=${status} tool=${toolName || 'none'} openui=${openuiSessionId || 'none'}`);
  log(`\x1b[38;5;245m[plugin-raw]\x1b[0m ${JSON.stringify(body, null, 2)}`);

  if (!status) {
    return c.json({ error: "status is required" }, 400);
  }

  let session = null;

  // Primary: Use OpenUI session ID if provided (this is definitive)
  if (openuiSessionId) {
    session = sessions.get(openuiSessionId);
  }

  // Fallback: Try to match by Claude session ID (for older plugin versions)
  if (!session && claudeSessionId) {
    for (const [id, s] of sessions) {
      if (s.claudeSessionId === claudeSessionId) {
        session = s;
        break;
      }
    }
  }

  if (session) {
    // Always update Claude session ID — Claude may issue a new ID on resume
    if (claudeSessionId) {
      session.claudeSessionId = claudeSessionId;
    }

    // Update cwd from hook input (agent may move to a worktree directory)
    if (cwd && cwd !== session.cwd) {
      session.cwd = cwd;
    }

    // Refresh token count from cost cache
    const tokens = getTokensForSession(session.claudeSessionId);
    if (tokens != null) session.tokens = tokens;

    // Store model name when reported
    if (model) session.model = model;

    // Signal the start queue that this session has completed OAuth/initialization
    if (hookEvent === "SessionStart" && openuiSessionId) {
      signalSessionReady(openuiSessionId);
    }

    // Handle pre_tool/post_tool/permission_request for status detection
    let effectiveStatus = status;

    if (status === "permission_request") {
      // PermissionRequest hook — definitive signal that the agent needs user approval.
      // Works for all tools including Bash/Task where timeout-based detection can't.
      effectiveStatus = "waiting_input";
      session.needsInputSince = Date.now();
      session.preToolTime = undefined;
      if (session.permissionTimeout) {
        clearTimeout(session.permissionTimeout);
        session.permissionTimeout = undefined;
      }
    } else if (status === "pre_tool") {
      // AskUserQuestion means the agent needs user input, not "working"
      // (Both the specific AskUserQuestion matcher and wildcard * fire in parallel,
      // so this server-side check ensures the correct status regardless of arrival order)
      if (toolName === "AskUserQuestion") {
        effectiveStatus = "waiting_input";
        session.needsInputSince = Date.now();
        session.currentTool = toolName;
        if (session.permissionTimeout) {
          clearTimeout(session.permissionTimeout);
          session.permissionTimeout = undefined;
        }
      } else {
        // PreToolUse fired - tool is about to run (or waiting for permission)
        effectiveStatus = "running";
        session.currentTool = toolName;
        session.preToolTime = Date.now();

        // Track working directories from file tool inputs
        if (FILE_TOOLS.has(toolName) && toolInput && openuiSessionId) {
          const filePath = toolInput.file_path || toolInput.path;
          if (filePath) trackWorkingDir(openuiSessionId, filePath);
        }

        // Sleep detection: if Bash command starts with "sleep N", set waiting status + timer.
        // Only clear sleepEndTime for new Bash commands — parallel non-Bash tools (Read, Grep, etc.)
        // should not disrupt an active sleep timer since they're separate tool invocations.
        if (toolName === "Bash") {
          if (toolInput?.command) {
            const sleepMatch = toolInput.command.match(/^sleep\s+(\d+)/);
            if (sleepMatch) {
              const secs = parseInt(sleepMatch[1], 10);
              session.sleepDuration = secs;
              session.sleepEndTime = Date.now() + secs * 1000;
              effectiveStatus = "waiting";
            } else {
              session.sleepEndTime = undefined;
              session.sleepDuration = undefined;
            }
          } else {
            session.sleepEndTime = undefined;
            session.sleepDuration = undefined;
          }
        }

        // Clear any existing permission timeout
        if (session.permissionTimeout) {
          clearTimeout(session.permissionTimeout);
        }

        // Timeout-based permission detection as fallback for non-Bash/Task tools.
        // Bash/Task are excluded since they can run for a long time — the PermissionRequest
        // hook handles permission detection for those definitively.
        const longRunningTools = ["Bash", "Task", "TaskOutput"];
        if (!longRunningTools.includes(toolName)) {
          session.permissionTimeout = setTimeout(() => {
            if (session.preToolTime) {
              session.status = "waiting_input";
              session.needsInputSince = Date.now();
              broadcastToSession(session, {
                type: "status",
                status: "waiting_input",
                isRestored: session.isRestored,
                currentTool: session.currentTool,
                hookEvent: "permission_timeout",
              });
            }
          }, 2500);
        } else {
          session.permissionTimeout = undefined;
        }

        // Long-running tool detection: if a single tool runs > 5 min, flag it
        if (session.longRunningTimeout) {
          clearTimeout(session.longRunningTimeout);
        }
        session.longRunningTool = false;
        session.longRunningTimeout = setTimeout(() => {
          if (session.preToolTime) {
            session.longRunningTool = true;
            broadcastToSession(session, {
              type: "status",
              status: session.status,
              isRestored: session.isRestored,
              currentTool: session.currentTool,
              hookEvent: "long_running_tool",
              gitBranch: session.gitBranch,
              longRunningTool: true,
            });
          }
        }, 5 * 60 * 1000);
      }
    } else if (status === "post_tool") {
      // PostToolUse fired - tool completed, clear the permission timeout
      // If session is already idle (Stop fired), don't flip back to running
      effectiveStatus = session.status === "idle" ? "idle" : "running";
      // AskUserQuestion PostToolUse means the user answered — clear input protection
      if (toolName === "AskUserQuestion") {
        session.needsInputSince = undefined;
      }
      session.preToolTime = undefined;
      session.sleepEndTime = undefined;
      session.sleepDuration = undefined;
      if (session.permissionTimeout) {
        clearTimeout(session.permissionTimeout);
        session.permissionTimeout = undefined;
      }
      session.longRunningTool = false;
      if (session.longRunningTimeout) {
        clearTimeout(session.longRunningTimeout);
        session.longRunningTimeout = undefined;
      }
      // Keep currentTool to show what just ran
    } else if (status === "compacting") {
      // PreCompact hook — agent is compacting its conversation context.
      // Show a calm "Compacting" status. Don't clear tool tracking.
      effectiveStatus = "compacting";
      session.preToolTime = undefined;
      if (session.permissionTimeout) {
        clearTimeout(session.permissionTimeout);
        session.permissionTimeout = undefined;
      }
      // Compaction timeout: if no new events arrive within 60s, revert to idle.
      // This handles the case where compaction was triggered while idle (e.g. /compact).
      // If the agent continues working, the next PreToolUse/UserPromptSubmit clears this.
      if (session.compactingTimeout) clearTimeout(session.compactingTimeout);
      session.compactingTimeout = setTimeout(() => {
        if (session.status === "compacting") {
          session.status = "idle";
          broadcastToSession(session, {
            type: "status",
            status: "idle",
            isRestored: session.isRestored,
            currentTool: session.currentTool,
            hookEvent: "compacting_timeout",
            gitBranch: session.gitBranch,
            longRunningTool: false,
            model: session.model,
            sleepEndTime: undefined,
          });
        }
      }, 60_000);
    } else {
      // For other statuses, clear tool tracking if not actively using tools
      if (status !== "tool_calling" && status !== "running") {
        session.currentTool = undefined;
      }
      // UserPromptSubmit / Stop / idle — user is actively engaged, clear input protection
      if (hookEvent === "UserPromptSubmit" || hookEvent === "Stop") {
        session.needsInputSince = undefined;
      }
      session.preToolTime = undefined;
      session.sleepEndTime = undefined;
      session.sleepDuration = undefined;
      if (session.permissionTimeout) {
        clearTimeout(session.permissionTimeout);
        session.permissionTimeout = undefined;
      }
      session.longRunningTool = false;
      if (session.longRunningTimeout) {
        clearTimeout(session.longRunningTimeout);
        session.longRunningTimeout = undefined;
      }
    }

    // Clear compacting timeout when any non-compacting event arrives
    if (status !== "compacting" && session.compactingTimeout) {
      clearTimeout(session.compactingTimeout);
      session.compactingTimeout = undefined;
    }

    // Once Stop fires (idle), only a new user message (UserPromptSubmit) should
    // flip status back to running. Late events like SubagentStop or missing
    // PostToolUse for parallel calls should not override idle.
    if (session.status === "idle" && effectiveStatus === "running" && hookEvent !== "UserPromptSubmit") {
      effectiveStatus = "idle";
    }

    // Protect "waiting" (sleep) from being overridden by running events from subagents.
    // Only post_tool (which clears sleepEndTime) or Stop should break out of waiting.
    if (session.status === "waiting" && session.sleepEndTime && effectiveStatus === "running") {
      effectiveStatus = "waiting";
    }

    // Protect waiting_input from being overwritten by running events from other subagents.
    // Clear when user provides terminal input (e.g., approving a permission prompt).
    if (session.needsInputSince && effectiveStatus === "running") {
      if (session.lastInputTime > session.needsInputSince) {
        session.needsInputSince = undefined;  // User responded via terminal
        // If a sleep is active, the user just approved the permission — go to "waiting" not "running".
        // Recalculate sleepEndTime from approval time since sleep doesn't start until approved.
        if (session.sleepEndTime && session.sleepDuration) {
          session.sleepEndTime = session.lastInputTime + session.sleepDuration * 1000;
          effectiveStatus = "waiting";
        }
      } else {
        effectiveStatus = "waiting_input";  // Still waiting, protect from override
      }
    }

    session.status = effectiveStatus;
    session.pluginReportedStatus = true;
    session.lastPluginStatusTime = Date.now();
    session.lastHookEvent = hookEvent;

    // Dynamic branch detection: check if branch changed (throttled to every 5s)
    const now = Date.now();
    if (!session._lastBranchCheck || (now - session._lastBranchCheck) > 5000) {
      session._lastBranchCheck = now;
      const currentBranch = getGitBranch(session.cwd);
      if (currentBranch && currentBranch !== session.gitBranch) {
        session.gitBranch = currentBranch;
      }
    }

    // Broadcast status change to connected clients
    broadcastToSession(session, {
      type: "status",
      status: session.status,
      isRestored: session.isRestored,
      currentTool: session.currentTool,
      hookEvent: hookEvent,
      gitBranch: session.gitBranch,
      longRunningTool: session.longRunningTool || false,
      model: session.model,
      sleepEndTime: session.sleepEndTime,
    });

    return c.json({ success: true });
  }

  // No session found
  log(`\x1b[38;5;141m[plugin]\x1b[0m Status update (no session): ${status} for openui:${openuiSessionId} claude:${claudeSessionId}`);
  return c.json({ success: true, warning: "No matching session found" });
});

// ============ Canvas (Tab) Management ============

// Get all canvases
apiRoutes.get("/canvases", (c) => {
  const state = loadState();
  return c.json(state.canvases || []);
});

// Create new canvas
apiRoutes.post("/canvases", async (c) => {
  const canvas = await c.req.json();
  const state = loadState();

  if (!state.canvases) state.canvases = [];
  state.canvases.push(canvas);

  saveCanvases(state.canvases);
  return c.json({ success: true, canvas });
});

// Update canvas
apiRoutes.patch("/canvases/:canvasId", async (c) => {
  const canvasId = c.req.param("canvasId");
  const updates = await c.req.json();
  const state = loadState();

  const canvas = state.canvases?.find(c => c.id === canvasId);
  if (!canvas) return c.json({ error: "Canvas not found" }, 404);

  Object.assign(canvas, updates);
  saveCanvases(state.canvases!);

  return c.json({ success: true });
});

// Delete canvas (only if empty)
apiRoutes.delete("/canvases/:canvasId", async (c) => {
  const canvasId = c.req.param("canvasId");
  const state = loadState();

  // Check if canvas has nodes
  const hasNodes = state.nodes.some(n => n.canvasId === canvasId);
  if (hasNodes) {
    return c.json({
      error: "Cannot delete canvas with agents. Move agents first."
    }, 400);
  }

  const index = state.canvases?.findIndex(c => c.id === canvasId);
  if (index === undefined || index === -1) {
    return c.json({ error: "Canvas not found" }, 404);
  }

  state.canvases!.splice(index, 1);
  saveCanvases(state.canvases!);

  return c.json({ success: true });
});

// Reorder canvases
apiRoutes.post("/canvases/reorder", async (c) => {
  const { canvasIds } = await c.req.json();
  const state = loadState();

  if (!state.canvases) return c.json({ error: "No canvases" }, 400);

  // Only update order for canvases in the list — don't drop missing ones
  const orderMap = new Map(canvasIds.map((id: string, i: number) => [id, i]));
  for (const canvas of state.canvases!) {
    if (orderMap.has(canvas.id)) {
      canvas.order = orderMap.get(canvas.id)!;
    }
  }
  state.canvases!.sort((a, b) => a.order - b.order);
  saveCanvases(state.canvases!);

  return c.json({ success: true });
});

// Migration trigger endpoint
apiRoutes.post("/migrate/canvases", (c) => {
  const result = migrateCategoriesToCanvases();
  return c.json(result);
});

// ============ GitHub Integration ============
import {
  fetchGitHubIssues,
  fetchGitHubIssue,
  searchGitHubIssues,
  parseGitHubUrl,
} from "../services/github";
import {
  searchConversations,
  getClaudeProjects,
} from "../services/conversationIndex";

// Get issues from a GitHub repo (no auth needed for public repos)
apiRoutes.get("/github/issues", async (c) => {
  const owner = c.req.query("owner");
  const repo = c.req.query("repo");
  const repoUrl = c.req.query("repoUrl");

  let resolvedOwner = owner;
  let resolvedRepo = repo;

  // If repoUrl provided, parse it
  if (repoUrl && !owner && !repo) {
    const parsed = parseGitHubUrl(repoUrl);
    if (!parsed) {
      return c.json({ error: "Invalid GitHub URL" }, 400);
    }
    resolvedOwner = parsed.owner;
    resolvedRepo = parsed.repo;
  }

  if (!resolvedOwner || !resolvedRepo) {
    return c.json({ error: "owner and repo are required (or provide repoUrl)" }, 400);
  }

  try {
    const issues = await fetchGitHubIssues(resolvedOwner, resolvedRepo);
    return c.json(issues);
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// Search GitHub issues
apiRoutes.get("/github/search", async (c) => {
  const owner = c.req.query("owner");
  const repo = c.req.query("repo");
  const q = c.req.query("q");

  if (!owner || !repo) {
    return c.json({ error: "owner and repo are required" }, 400);
  }
  if (!q) {
    return c.json({ error: "Search query (q) is required" }, 400);
  }

  try {
    const issues = await searchGitHubIssues(owner, repo, q);
    return c.json(issues);
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// Get single GitHub issue
apiRoutes.get("/github/issue/:owner/:repo/:number", async (c) => {
  const owner = c.req.param("owner");
  const repo = c.req.param("repo");
  const number = parseInt(c.req.param("number"), 10);

  if (isNaN(number)) {
    return c.json({ error: "Invalid issue number" }, 400);
  }

  try {
    const issue = await fetchGitHubIssue(owner, repo, number);
    if (!issue) return c.json({ error: "Issue not found" }, 404);
    return c.json(issue);
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// ============ Claude Conversation Search ============

// Search/list Claude Code conversations (FTS5 full-text search)
apiRoutes.get("/claude/conversations", (c) => {
  const query = c.req.query("q");
  const projectPath = c.req.query("projectPath");
  const limit = parseInt(c.req.query("limit") || "30", 10);

  try {
    const conversations = searchConversations({
      query: query || undefined,
      projectPath: projectPath || undefined,
      limit,
    });
    return c.json({ conversations });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// List available Claude Code projects
apiRoutes.get("/claude/projects", (c) => {
  try {
    const projects = getClaudeProjects();
    return c.json(projects);
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// ============ Cursor Workspace ============

// Resolve gitBranch -> worktree root (shared helper)
function resolveWorktreeRoot(branch: string, fallbackCwd: string): string | null {
  const candidates = [
    fallbackCwd,
    LAUNCH_CWD,
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const r = spawnSync(["git", "worktree", "list"], {
      cwd: candidate,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (r.exitCode !== 0 || !r.stdout.toString().trim()) continue;

    const lines = r.stdout.toString().trim().split("\n");
    for (const line of lines) {
      const match = line.match(/^(\S+)\s+\S+\s+\[(.+)\]$/);
      if (match && match[2] === branch) {
        return match[1];
      }
    }
  }
  return null;
}

// Generate a curated .code-workspace file using Claude to intelligently deduplicate dirs
// Streams progress via SSE so the UI can show real-time Claude output
apiRoutes.get("/cursor-workspace", async (c) => {
  const branch = c.req.query("branch");
  const sessionId = c.req.query("sessionId");
  const fallbackCwd = c.req.query("cwd") || LAUNCH_CWD;
  const home = homedir();
  const shorten = (p: string) => p.startsWith(home) ? "~" + p.slice(home.length) : p;

  return streamSSE(c, async (stream) => {
    try {
      await stream.writeSSE({ data: JSON.stringify({ type: "status", message: "Resolving worktree..." }) });

      const worktreeRoot = branch ? resolveWorktreeRoot(branch, fallbackCwd) : null;

      if (sessionId && worktreeRoot) {
        seedWorkingDirs(sessionId, worktreeRoot);
      }

      const workspacesDir = join(getDataDir(), "workspaces");
      const dirsFile = sessionId ? join(workspacesDir, `${sanitizeSessionId(sessionId)}-dirs.txt`) : null;
      let rawDirs: string[] = [];
      if (dirsFile && existsSync(dirsFile)) {
        rawDirs = [...new Set(readFileSync(dirsFile, "utf8").split("\n").filter(Boolean))];
      }

      if (rawDirs.length === 0) {
        await stream.writeSSE({ data: JSON.stringify({ type: "result", path: worktreeRoot || fallbackCwd, curatedDirs: [], rawDirCount: 0 }) });
        return;
      }

      await stream.writeSSE({ data: JSON.stringify({ type: "status", message: `Curating ${rawDirs.length} directories with Claude...` }) });

      const prompt = `You are given a list of directories that a coding agent has been working in. Produce a clean, minimal list of workspace folders for a VS Code workspace file.

Rules:
- Remove exact duplicates
- If a parent directory and its child are both listed, keep ONLY the parent (e.g., if both /a/b and /a/b/c exist, keep only /a/b)
- Drop directories under /tmp, node_modules, .git, dist, build, or __pycache__
- Keep the list focused — aim for 3-8 folders max
- If there are many scattered subdirs under a common parent, consolidate to the parent
- Output ONLY absolute paths, one per line, no explanations, no markdown

Directories:
${rawDirs.join("\n")}`;

      log(`[cursor-workspace] Curating ${rawDirs.length} dirs with Claude for session ${sessionId}`);

      // Use async spawn so we can stream output
      const proc = Bun.spawn(["claude", "-p", prompt], {
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, ANTHROPIC_MODEL: "haiku" },
      });

      // Stream stderr (Claude's thinking/progress) to the client
      const stderrReader = proc.stderr.getReader();
      const decoder = new TextDecoder();
      (async () => {
        try {
          while (true) {
            const { done, value } = await stderrReader.read();
            if (done) break;
            const text = decoder.decode(value, { stream: true });
            if (text.trim()) {
              await stream.writeSSE({ data: JSON.stringify({ type: "claude_stderr", text: text.trim() }) });
            }
          }
        } catch {}
      })();

      // Collect stdout (the actual result)
      let stdoutChunks: string[] = [];
      const stdoutReader = proc.stdout.getReader();
      while (true) {
        const { done, value } = await stdoutReader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        stdoutChunks.push(text);
        // Stream partial output to show Claude is working
        if (text.trim()) {
          await stream.writeSSE({ data: JSON.stringify({ type: "claude_output", text: text.trim() }) });
        }
      }

      const exitCode = await proc.exited;
      const claudeOutput = stdoutChunks.join("").trim();

      let curatedDirs: string[];
      if (exitCode === 0 && claudeOutput) {
        curatedDirs = claudeOutput.split("\n")
          .map(l => l.trim())
          .filter(d => d.startsWith("/"));
        log(`[cursor-workspace] Claude curated to ${curatedDirs.length} dirs`);
      } else {
        log(`[cursor-workspace] Claude failed (exit ${exitCode}), using raw dirs`);
        curatedDirs = rawDirs;
      }

      // Write .code-workspace file
      if (!existsSync(workspacesDir)) mkdirSync(workspacesDir, { recursive: true });
      const safeName = sessionId || branch?.replace(/[^a-zA-Z0-9_-]/g, "_") || "default";
      const workspacePath = join(workspacesDir, `${safeName}.code-workspace`);

      const workspace = {
        folders: curatedDirs.map(d => ({ path: d })),
        settings: {},
      };
      writeFileSync(workspacePath, JSON.stringify(workspace, null, 2));

      await stream.writeSSE({ data: JSON.stringify({
        type: "result",
        path: workspacePath,
        worktreeRoot,
        rawDirCount: rawDirs.length,
        curatedDirs: curatedDirs.map(shorten),
      }) });
    } catch (e: any) {
      log(`[cursor-workspace] Error: ${e.message}`);
      await stream.writeSSE({ data: JSON.stringify({ type: "result", path: fallbackCwd }) });
    }
  });
});

// ============ Config (Settings) ============

// GET /api/settings — read all user settings
apiRoutes.get("/settings", (c) => {
  const config = loadConfig();
  // Auto-set firstSeenAt for new users so they don't see a backlog of "What's New" entries
  if (!config.firstSeenAt) {
    config.firstSeenAt = new Date().toISOString().slice(0, 10); // "2026-02-25"
    saveConfig(config);
  }
  return c.json(config);
});

// PUT /api/settings — merge user settings
apiRoutes.put("/settings", async (c) => {
  const updates = await c.req.json();
  const config = loadConfig();
  Object.assign(config, updates);
  saveConfig(config);
  return c.json(config);
});
