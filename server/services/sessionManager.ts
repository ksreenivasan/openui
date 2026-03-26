import { spawnSync } from "bun";
import { spawn as spawnPty } from "bun-pty";
import { existsSync, readdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type { Session } from "../types";
import { loadBuffer } from "./persistence";
import { enqueueSessionStart, signalSessionReady } from "./sessionStartQueue";

const QUIET = !!process.env.OPENUI_QUIET;
const log = QUIET ? () => {} : console.log.bind(console);
const logError = QUIET ? () => {} : console.error.bind(console);

// Kitty keyboard protocol support: Claude Code sends \x1b[?u to query
// whether the terminal supports the protocol, and \x1b[>Xu to enable it.
// xterm.js doesn't support kitty protocol natively, so we intercept the
// query in PTY output and respond on behalf of the terminal. This lets
// Claude Code detect Shift+Enter (\x1b[13;2u) sent by the client.
const KITTY_QUERY_RE = /\x1b\[\?u/;
const KITTY_ENABLE_RE = /\x1b\[>[0-9]*u/;

export function handleKittyProtocol(data: string, pty: any): string {
  // Log all escape sequences for debugging
  const escapes = data.match(/\x1b\[[^a-zA-Z]*[a-zA-Z]/g);
  if (escapes) {
    const interesting = escapes.filter(s => s.includes('u') || s.includes('?'));
    if (interesting.length > 0) {
      log(`\x1b[38;5;208m[kitty-debug]\x1b[0m Escape sequences: ${interesting.map(s => JSON.stringify(s)).join(", ")}`);
    }
  }
  // Respond to kitty keyboard protocol query with flags=1 (disambiguate)
  if (KITTY_QUERY_RE.test(data)) {
    log(`\x1b[38;5;208m[kitty]\x1b[0m Detected kitty protocol query, responding with flags=1`);
    pty.write("\x1b[?1u");
  }
  if (KITTY_ENABLE_RE.test(data)) {
    log(`\x1b[38;5;208m[kitty]\x1b[0m Detected kitty protocol enable request`);
  }
  // Strip kitty enable/query sequences from output so xterm.js doesn't
  // render them as garbage text
  return data.replace(KITTY_ENABLE_RE, "").replace(KITTY_QUERY_RE, "");
}

export const DEFAULT_CLAUDE_COMMAND = "claude";

// Resolve the correct cwd for resuming a Claude session.
// Claude stores sessions by project path (derived from cwd at creation time).
// The cwd in state.json can drift (e.g., agent cd'd into a subdirectory), so
// on resume the PTY cwd may not match where Claude stored the session.
// This reads the session's JSONL first line to get the original cwd.
export function resolveResumeCwd(sessionCwd: string, claudeSessionId: string | undefined): string {
  if (!claudeSessionId) return sessionCwd;
  const sessionFile = `${claudeSessionId}.jsonl`;
  const projectsDir = join(homedir(), ".claude", "projects");
  try {
    // Search project dirs for the session JSONL (typically <100 dirs, very fast)
    for (const dir of readdirSync(projectsDir)) {
      const filePath = join(projectsDir, dir, sessionFile);
      if (existsSync(filePath)) {
        // Read only first line (session JSONLs can be large, avoid reading entire file)
        const headResult = spawnSync(["head", "-1", filePath], { stdout: "pipe", stderr: "pipe" });
        if (headResult.exitCode !== 0) return sessionCwd;
        const firstLine = headResult.stdout.toString().trim();
        const meta = JSON.parse(firstLine);
        if (meta.cwd && meta.cwd !== sessionCwd) {
          log(`\x1b[38;5;141m[auto-resume]\x1b[0m cwd corrected: ${sessionCwd} → ${meta.cwd}`);
          return meta.cwd;
        }
        return sessionCwd;
      }
    }
  } catch {}
  return sessionCwd;
}

// Get the OpenUI plugin directory path
function getPluginDir(): string | null {
  // Check for plugin in ~/.openui/claude-code-plugin (installed via curl)
  const homePluginDir = join(homedir(), ".openui", "claude-code-plugin");
  const homePluginJson = join(homePluginDir, ".claude-plugin", "plugin.json");
  log(`\x1b[38;5;245m[plugin-check]\x1b[0m Checking home: ${homePluginJson} exists=${existsSync(homePluginJson)}`);
  if (existsSync(homePluginJson)) {
    return homePluginDir;
  }

  // Check for plugin in the openui repo (for development)
  // Use import.meta.dir for ESM compatibility
  const currentDir = import.meta.dir || __dirname;
  const repoPluginDir = join(currentDir, "..", "..", "claude-code-plugin");
  const repoPluginJson = join(repoPluginDir, ".claude-plugin", "plugin.json");
  log(`\x1b[38;5;245m[plugin-check]\x1b[0m Checking repo: ${repoPluginJson} exists=${existsSync(repoPluginJson)}`);
  if (existsSync(repoPluginJson)) {
    return repoPluginDir;
  }

  log(`\x1b[38;5;245m[plugin-check]\x1b[0m No plugin found`);
  return null;
}

// Inject --plugin-dir flag for Claude commands if plugin is available
export function injectPluginDir(command: string, agentId: string): string {
  if (agentId !== "claude") return command;

  const pluginDir = getPluginDir();
  if (!pluginDir) return command;

  // Check if command already has --plugin-dir
  if (command.includes("--plugin-dir")) return command;

  // Handle claude command format
  const parts = command.split(/\s+/);

  if (parts[0] === "claude") {
    parts.splice(1, 0, `--plugin-dir`, pluginDir);
    const finalCmd = parts.join(" ");
    log(`\x1b[38;5;141m[plugin]\x1b[0m Injecting plugin-dir: ${pluginDir}`);
    log(`\x1b[38;5;141m[plugin]\x1b[0m Final command: ${finalCmd}`);
    return finalCmd;
  }

  return command;
}

// Get git branch for a directory
export function getGitBranch(cwd: string): string | null {
  try {
    const result = spawnSync(["git", "rev-parse", "--abbrev-ref", "HEAD"], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (result.exitCode === 0) {
      return result.stdout.toString().trim();
    }
  } catch {
    // Not a git repo or git not available
  }
  return null;
}


// Create a git worktree for a branch
export function createWorktreeForBranch(cwd: string, branchName: string, baseBranch?: string): string | null {
  try {
    const topResult = spawnSync(["git", "rev-parse", "--show-toplevel"], {
      cwd, stdout: "pipe", stderr: "pipe",
    });
    if (topResult.exitCode !== 0) return null;
    const repoRoot = topResult.stdout.toString().trim();
    const repoName = repoRoot.split("/").pop() || "repo";
    const worktreePath = join(repoRoot, "..", `${repoName}-worktrees`, branchName.replace(/\//g, "-"));

    if (existsSync(worktreePath)) {
      log(`\x1b[38;5;141m[git]\x1b[0m Worktree already exists at ${worktreePath}`);
      return worktreePath;
    }

    const branchExists = spawnSync(["git", "rev-parse", "--verify", branchName], {
      cwd, stdout: "pipe", stderr: "pipe",
    }).exitCode === 0;

    if (branchExists) {
      const result = spawnSync(["git", "worktree", "add", worktreePath, branchName], {
        cwd, stdout: "pipe", stderr: "pipe",
      });
      if (result.exitCode !== 0) {
        log(`\x1b[38;5;208m[git]\x1b[0m Worktree add failed: ${result.stderr.toString()}`);
        return null;
      }
    } else {
      const base = baseBranch || "HEAD";
      const result = spawnSync(["git", "worktree", "add", "-b", branchName, worktreePath, base], {
        cwd, stdout: "pipe", stderr: "pipe",
      });
      if (result.exitCode !== 0) {
        log(`\x1b[38;5;208m[git]\x1b[0m Worktree add -b failed: ${result.stderr.toString()}`);
        return null;
      }
    }

    return worktreePath;
  } catch (e) {
    log(`\x1b[38;5;208m[git]\x1b[0m Worktree creation error: ${e}`);
    return null;
  }
}

export const MAX_BUFFER_SIZE = 5000;

/** Broadcast a message to all WebSocket clients of a session, with try-catch per client */
export function broadcastToSession(session: Session, message: object) {
  // Auto-attach outputSeq to output messages so clients can track position
  const msg = (message as any).type === "output" ? { ...message, seq: session.outputSeq } : message;
  const json = JSON.stringify(msg);
  for (const client of session.clients) {
    try {
      if (client.readyState === 1) {
        client.send(json);
      }
    } catch {
      session.clients.delete(client);
    }
  }
}

export const sessions = new Map<string, Session>();

export async function createSession(params: {
  sessionId: string;
  agentId: string;
  agentName: string;
  command: string;
  cwd: string;
  nodeId: string;
  customName?: string;
  customColor?: string;
  // Ticket and worktree options
  ticketId?: string;
  ticketTitle?: string;
  ticketUrl?: string;
  branchName?: string;
  baseBranch?: string;
  prNumber?: string;
  ticketPromptTemplate?: string;
}): Promise<{ session: Session; cwd: string; gitBranch?: string }> {
  const {
    sessionId,
    agentId,
    agentName,
    command,
    cwd: rawCwd,
    nodeId,
    customName,
    customColor,
    ticketId,
    ticketTitle,
    ticketUrl,
    branchName,
    baseBranch,
    prNumber,
    ticketPromptTemplate,
  } = params;

  // Expand ~ in cwd
  let originalCwd = rawCwd.replace(/^~(?=$|\/)/, homedir());

  // Set up worktree for branch isolation
  let gitBranch: string | null = null;
  if (agentId === "claude") {
    if (branchName) {
      // Check if the branch is already checked out in an existing worktree
      let existingWorktreePath: string | null = null;
      try {
        const wtResult = spawnSync(["git", "worktree", "list", "--porcelain"], {
          cwd: originalCwd, stdout: "pipe", stderr: "pipe",
        });
        if (wtResult.exitCode === 0) {
          const blocks = wtResult.stdout.toString().split("\n\n");
          for (const block of blocks) {
            if (block.includes(`branch refs/heads/${branchName}\n`) || block.endsWith(`branch refs/heads/${branchName}`)) {
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
        // Branch already checked out — start in that directory directly
        log(`\x1b[38;5;141m[git]\x1b[0m Branch "${branchName}" already at ${existingWorktreePath}`);
        originalCwd = existingWorktreePath;
      } else {
        // Create a new worktree for this branch
        try {
          const worktreeCwd = createWorktreeForBranch(originalCwd, branchName, baseBranch);
          if (worktreeCwd) {
            originalCwd = worktreeCwd;
            log(`\x1b[38;5;141m[git]\x1b[0m Using worktree at ${worktreeCwd} for branch "${branchName}"`);
          }
        } catch (e) {
          log(`\x1b[38;5;208m[git]\x1b[0m Failed to create worktree: ${e}`);
        }
      }
      gitBranch = branchName;
    }
    if (prNumber) {
      if (!gitBranch) gitBranch = `PR #${prNumber}`;
    }
  }

  // If not set from flags, detect git branch
  if (!gitBranch) {
    gitBranch = getGitBranch(originalCwd);
  }

  const now = Date.now();
  const session: Session = {
    pty: null as any,
    agentId,
    agentName,
    command,
    cwd: originalCwd,
    launchCwd: originalCwd,
    gitBranch: gitBranch || undefined,
    createdAt: new Date().toISOString(),
    clients: new Set(),
    outputBuffer: [],
    outputSeq: 0,
    status: "idle",
    lastOutputTime: now,
    lastInputTime: 0,
    recentOutputSize: 0,
    customName,
    customColor,
    nodeId,
    isRestored: false,
    ticketId,
    ticketTitle,
    ticketUrl,
  };

  sessions.set(sessionId, session);

  // Spawn PTY
  const ptyProcess = spawnPty("/bin/bash", [], {
    name: "xterm-256color",
    cwd: originalCwd,
    env: {
      ...process.env,
      TERM: "xterm-256color",
      OPENUI_SESSION_ID: sessionId,
    },
    rows: 30,
    cols: 120,
  });

  session.pty = ptyProcess;

  // Output decay
  const resetInterval = setInterval(() => {
    if (!sessions.has(sessionId) || !session.pty) {
      clearInterval(resetInterval);
      return;
    }
    session.recentOutputSize = Math.max(0, session.recentOutputSize - 50);
  }, 500);

  // PTY output handler
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

  // Run the command with plugin-dir
  const finalCommand = injectPluginDir(command, agentId);
  log(`\x1b[38;5;82m[pty-write]\x1b[0m Writing command: ${finalCommand}`);

  setTimeout(() => {
    ptyProcess.write(`${finalCommand}\r`);

    // If there's a ticket URL, send it to the agent after a delay
    if (ticketUrl) {
      setTimeout(() => {
        const defaultTemplate = "Here is the ticket for this session: {{url}}\n\nPlease fetch the URL to read the full ticket details before starting work.";
        const template = ticketPromptTemplate || defaultTemplate;
        const ticketPrompt = template
          .replace(/\{\{url\}\}/g, ticketUrl)
          .replace(/\{\{id\}\}/g, ticketId || "")
          .replace(/\{\{title\}\}/g, ticketTitle || "");
        ptyProcess.write(ticketPrompt + "\r");
      }, 2000);
    }
  }, 300);

  log(`\x1b[38;5;141m[session]\x1b[0m Created ${sessionId} for ${agentName}${ticketId ? ` (ticket: ${ticketId})` : ""}`);
  return { session, cwd: originalCwd, gitBranch: gitBranch || undefined };
}

export function deleteSession(sessionId: string) {
  const session = sessions.get(sessionId);
  if (!session) return false;

  if (session.pty) session.pty.kill();
  sessions.delete(sessionId);
  log(`\x1b[38;5;141m[session]\x1b[0m Killed ${sessionId}`);
  return true;
}

export function createShellSession(cwd: string, nodeId: string): { shellId: string; session: Session } {
  const shellId = `shell-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const userShell = process.env.SHELL || "/bin/bash";

  const session: Session = {
    pty: null as any,
    agentId: "shell",
    agentName: "Shell",
    command: "",
    cwd,
    createdAt: new Date().toISOString(),
    clients: new Set(),
    outputBuffer: [],
    outputSeq: 0,
    status: "idle",
    lastOutputTime: Date.now(),
    lastInputTime: 0,
    recentOutputSize: 0,
    nodeId,
    isRestored: false,
  };

  const ptyProcess = spawnPty(userShell, [], {
    name: "xterm-256color",
    cwd,
    env: {
      ...process.env,
      TERM: "xterm-256color",
    },
    rows: 30,
    cols: 120,
  });

  session.pty = ptyProcess;

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

  sessions.set(shellId, session);
  log(`\x1b[38;5;141m[shell]\x1b[0m Created shell ${shellId} at ${cwd}`);

  return { shellId, session };
}

export function restoreSessions() {
  const { loadState } = require("./persistence");
  const state = loadState();

  log(`\x1b[38;5;245m[restore]\x1b[0m Found ${state.nodes.length} saved sessions`);

  for (const node of state.nodes) {
    // Skip archived sessions - they should not be in the active sessions Map
    if (node.archived) {
      log(`[restore] Skipping archived session: ${node.sessionId} (${node.customName})`);
      continue;
    }

    console.log(`[restore] Loading session: ${node.sessionId} (${node.customName}) archived=${node.archived}`);

    const buffer = loadBuffer(node.sessionId);
    const gitBranch = getGitBranch(node.cwd);

    const session: Session = {
      pty: null,
      agentId: node.agentId,
      agentName: node.agentName,
      command: node.command,
      cwd: node.cwd,
      launchCwd: node.launchCwd || homedir(),
      gitBranch: gitBranch || node.gitBranch || undefined,
      createdAt: node.createdAt,
      clients: new Set(),
      outputBuffer: buffer,
      outputSeq: 0,
      status: "disconnected",
      lastOutputTime: 0,
      lastInputTime: 0,
      recentOutputSize: 0,
      customName: node.customName,
      customColor: node.customColor,
      notes: node.notes,
      nodeId: node.nodeId,
      isRestored: true,
      autoResumed: node.autoResumed || false,
      claudeSessionId: node.claudeSessionId,
      archived: false,
      canvasId: node.canvasId,
      ticketId: node.ticketId,
      ticketTitle: node.ticketTitle,
      ticketUrl: node.ticketUrl,
    };

    sessions.set(node.sessionId, session);
    log(`\x1b[38;5;245m[restore]\x1b[0m Restored ${node.sessionId} (${node.agentName}) branch: ${gitBranch || 'none'}`);
  }
}

/**
 * Auto-resume sessions on startup (resumes all non-archived sessions)
 */
export function autoResumeSessions() {
  const { getSessionsToResume, getAutoResumeConfig } = require("./autoResume");
  const { saveState } = require("./persistence");

  const config = getAutoResumeConfig();
  if (!config.enabled) {
    log(`\x1b[38;5;141m[auto-resume]\x1b[0m Auto-resume is disabled`);
    return;
  }

  const sessionsToResume = getSessionsToResume();

  if (sessionsToResume.length === 0) {
    log(`\x1b[38;5;141m[auto-resume]\x1b[0m No sessions to auto-resume`);
    return;
  }

  log(`\x1b[38;5;141m[auto-resume]\x1b[0m Auto-resuming ${sessionsToResume.length} sessions...`);

  for (const node of sessionsToResume) {
    const session = sessions.get(node.sessionId);
    if (!session) {
      log(`\x1b[38;5;245m[auto-resume]\x1b[0m Session not found: ${node.sessionId}`);
      continue;
    }

    // Skip if already has a PTY (already running)
    if (session.pty) {
      log(`\x1b[38;5;245m[auto-resume]\x1b[0m Skipping ${node.sessionId} (already running)`);
      continue;
    }

    const startFn = () => {
      try {
        // Resolve the correct cwd for Claude session discovery
        const resumeCwd = resolveResumeCwd(session.launchCwd || session.cwd, session.claudeSessionId);

        // Spawn a new PTY for this session (use launchCwd to avoid plugin-updated cwd issues)
        const ptyProcess = spawnPty("/bin/bash", [], {
          name: "xterm-256color",
          cwd: resumeCwd,
          env: {
            ...process.env,
            TERM: "xterm-256color",
            OPENUI_SESSION_ID: node.sessionId,
          },
          rows: 30,
          cols: 120,
        });

        session.pty = ptyProcess;
        session.status = "idle";
        session.isRestored = false;
        session.autoResumed = true;

        // Set up PTY data handler
        ptyProcess.onData((data: string) => {
          const filtered = handleKittyProtocol(data, ptyProcess);
          session.outputBuffer.push(filtered);
          session.outputSeq++;
          if (session.outputBuffer.length > MAX_BUFFER_SIZE) {
            session.outputBuffer.shift();
          }

          session.lastOutputTime = Date.now();
          session.recentOutputSize += filtered.length;

          // Broadcast to all connected clients
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
          log(`\x1b[38;5;141m[auto-resume]\x1b[0m Using existing --resume ${existingResume[1]} from command`);
        } else if (session.agentId === "claude" && session.claudeSessionId && UUID_RE.test(session.claudeSessionId)) {
          const resumeArg = `--resume ${session.claudeSessionId}`;
          if (finalCommand.startsWith("claude")) {
            finalCommand = finalCommand.replace(/^claude(\s|$)/, `claude ${resumeArg}$1`);
          }
          // Persist --resume into the command so future restarts use the correct ID
          session.command = session.command.replace(/^claude/, `claude ${resumeArg}`);
          log(`\x1b[38;5;141m[auto-resume]\x1b[0m Resuming Claude session: ${session.claudeSessionId} (persisted to command)`);
        }

        // Claude Code scopes --resume sessions to the directory they were created in.
        // The PTY may spawn in a worktree dir, but claude sessions are created from ~.
        // For resume: cd to ~ first. For fresh launches: use the PTY's cwd as-is.
        const hasResume = finalCommand.includes("--resume");
        setTimeout(() => {
          if (hasResume) {
            ptyProcess.write(`cd ~ && ${finalCommand}\r`);
          } else {
            ptyProcess.write(`${finalCommand}\r`);
          }
        }, 300);

        log(`\x1b[38;5;141m[auto-resume]\x1b[0m Resumed ${node.sessionId} (${node.agentName})`);
      } catch (error) {
        logError(`\x1b[38;5;141m[auto-resume]\x1b[0m Failed to resume ${node.sessionId}:`, error);
        // Signal ready on failure so the queue isn't blocked
        signalSessionReady(node.sessionId);
      }
    };

    // Claude agents go through the queue to prevent OAuth port contention
    if (session.agentId === "claude") {
      enqueueSessionStart(node.sessionId, startFn, () => session.outputBuffer);
    } else {
      // Non-Claude agents start immediately (no OAuth)
      startFn();
    }
  }

  // Save state to persist autoResumed flag
  saveState(sessions);
  log(`\x1b[38;5;141m[auto-resume]\x1b[0m Auto-resume complete`);
}
