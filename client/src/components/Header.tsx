import { useState, useMemo, useEffect, useCallback } from "react";
import { Plus, Folder, Settings, Archive, Loader2, Search, HelpCircle, GitBranch } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { useStore } from "../stores/useStore";
import { SettingsModal } from "./SettingsModal";
import { ConversationSearchModal } from "./ConversationSearchModal";
import { HelpModal } from "./HelpModal";
import { changelog, type ChangelogEntry } from "../data/changelog";

const MAX_DISPLAY = 10;

export function Header() {
  const { setAddAgentModalOpen, sessions, launchCwd, showArchived, setShowArchived, autoResumeProgress, selectedNodeId, activeCanvasId, nodes } = useStore();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [cursorLoading, setCursorLoading] = useState(false);
  const [cursorStatus, setCursorStatus] = useState("");
  const [cursorResult, setCursorResult] = useState<{ curatedDirs: string[]; rawDirCount: number } | null>(null);

  // Detect remote SSH environment
  const isRemote = useMemo(() => window.location.hostname !== "localhost" && window.location.hostname !== "127.0.0.1", []);

  // Shorten long paths for display
  const shortenPath = useCallback((p: string) => {
    const home = p.replace(/^\/home\/[^/]+/, "~");
    if (home.length <= 50) return home;
    const parts = home.split("/");
    if (parts.length <= 3) return home;
    const prefix = parts.slice(0, 2).join("/");
    const suffix = parts.slice(-2).join("/");
    return `${prefix}/.../${suffix}`;
  }, []);

  // Derive displayed cwd, gitBranch, and sessionId: selected session > first session on active canvas > launchCwd
  const { displayCwd, displayBranch, displaySessionId } = useMemo(() => {
    // 1. If a node is selected, use its session's cwd/branch
    if (selectedNodeId) {
      const session = sessions.get(selectedNodeId);
      if (session?.cwd) return { displayCwd: session.cwd, displayBranch: session.gitBranch, displaySessionId: session.sessionId || selectedNodeId };
    }
    // 2. Use the cwd from the first session on the active canvas
    if (activeCanvasId) {
      const canvasNodeIds = nodes
        .filter((n: any) => n.data?.canvasId === activeCanvasId)
        .map((n) => n.id);
      for (const nodeId of canvasNodeIds) {
        const session = sessions.get(nodeId);
        if (session?.cwd) return { displayCwd: session.cwd, displayBranch: session.gitBranch, displaySessionId: session.sessionId || nodeId };
      }
    }
    // 3. Fallback to launchCwd
    return { displayCwd: launchCwd, displayBranch: undefined, displaySessionId: undefined };
  }, [selectedNodeId, activeCanvasId, nodes, sessions, launchCwd]);

  // "What's New" state
  const [seenIds, setSeenIds] = useState<Set<string>>(new Set());
  const [firstSeenAt, setFirstSeenAt] = useState<string | null>(null);

  // Fetch seen state from server on mount
  useEffect(() => {
    fetch("/api/settings")
      .then((res) => res.json())
      .then((config) => {
        setSeenIds(new Set(config.seenUpdateIds || []));
        setFirstSeenAt(config.firstSeenAt || null);
      })
      .catch(() => {});
  }, []);

  // Compute unseen / older updates (capped to MAX_DISPLAY total)
  const { unseenUpdates, olderUpdates } = useMemo(() => {
    // Filter to entries the user should see (only those after their first visit)
    const visible = firstSeenAt
      ? changelog.filter((e) => e.date >= firstSeenAt)
      : [];
    const capped = visible.slice(0, MAX_DISPLAY);
    const unseen: ChangelogEntry[] = [];
    const older: ChangelogEntry[] = [];
    for (const entry of capped) {
      if (seenIds.has(entry.id)) {
        older.push(entry);
      } else {
        unseen.push(entry);
      }
    }
    return { unseenUpdates: unseen, olderUpdates: older };
  }, [seenIds, firstSeenAt]);

  const markAsSeen = useCallback(() => {
    // Mark all visible entries as seen
    const allIds = changelog.slice(0, MAX_DISPLAY).map((e) => e.id);
    const merged = new Set([...seenIds, ...allIds]);
    setSeenIds(merged);
    fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ seenUpdateIds: [...merged] }),
    }).catch(() => {});
  }, [seenIds]);

  // Listen for Cmd+K toggle event from App.tsx keyboard handler
  useEffect(() => {
    const handler = () => setSearchOpen((prev) => !prev);
    window.addEventListener("openui:toggle-search", handler);
    return () => window.removeEventListener("openui:toggle-search", handler);
  }, []);

  // Listen for help toggle event from App.tsx keyboard handler
  useEffect(() => {
    const handler = () => setHelpOpen((prev) => !prev);
    window.addEventListener("openui:toggle-help", handler);
    return () => window.removeEventListener("openui:toggle-help", handler);
  }, []);

  // Count active (non-archived) sessions by status
  const statusCounts = useMemo(() => {
    const activeSessions = Array.from(sessions.values()).filter(s => !s.archived);

    return {
      working: activeSessions.filter(s =>
        s.status === "running" || s.status === "tool_calling"
      ).length,
      waiting: activeSessions.filter(s =>
        s.status === "waiting"
      ).length,
      needsInput: activeSessions.filter(s =>
        s.status === "waiting_input"
      ).length,
      idle: activeSessions.filter(s =>
        s.status === "idle"
      ).length,
    };
  }, [sessions]);

  const showProgress = autoResumeProgress?.isActive && autoResumeProgress.total > 0;
  const progressPct = autoResumeProgress
    ? Math.round((autoResumeProgress.completed / Math.max(autoResumeProgress.total, 1)) * 100)
    : 0;

  return (
    <header className="h-14 px-4 flex items-center justify-between border-b border-border bg-canvas-dark overflow-visible">
      {/* Logo */}
      <div className="flex items-center gap-3 relative">
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded-md bg-gradient-to-br from-violet-500 to-orange-500 flex items-center justify-center">
            <div className="w-2 h-2 rounded-full bg-white" />
          </div>
          <span className="text-sm font-semibold text-white">OpenUI</span>
        </div>

        <div className="h-4 w-px bg-border mx-2" />

        <button
          disabled={cursorLoading}
          onClick={async () => {
            if (!displayCwd || cursorLoading) return;
            setCursorLoading(true);
            setCursorResult(null);
            setCursorStatus("Resolving...");

            const params = new URLSearchParams();
            if (displayBranch) params.set("branch", displayBranch);
            if (displaySessionId) params.set("sessionId", displaySessionId);
            params.set("cwd", displayCwd);

            // TODO: Store EventSource in a ref and close on unmount to prevent leaked connections
            const es = new EventSource(`/api/cursor-workspace?${params}`);
            es.onmessage = (e) => {
              try {
                const data = JSON.parse(e.data);
                if (data.type === "status") {
                  setCursorStatus(data.message);
                } else if (data.type === "claude_stderr" || data.type === "claude_output") {
                  setCursorStatus(data.text.slice(0, 80));
                } else if (data.type === "result") {
                  es.close();
                  setCursorLoading(false);
                  setCursorStatus("");

                  // Open in Cursor
                  const openPath = data.path || displayCwd;
                  const sshHost = window.location.hostname;
                  const uri = isRemote
                    ? `cursor://vscode-remote/ssh-remote+${sshHost}${openPath}`
                    : `cursor://file${openPath}`;
                  const iframe = document.createElement("iframe");
                  iframe.style.display = "none";
                  iframe.src = uri;
                  document.body.appendChild(iframe);
                  setTimeout(() => iframe.remove(), 1000);

                  // Show results toast
                  if (data.curatedDirs?.length) {
                    setCursorResult({ curatedDirs: data.curatedDirs, rawDirCount: data.rawDirCount || 0 });
                    setTimeout(() => setCursorResult(null), 8000);
                  }
                }
              } catch {}
            };
            es.onerror = () => {
              es.close();
              setCursorLoading(false);
              setCursorStatus("");
              // Fallback to direct cwd open
              const sshHost = window.location.hostname;
              const uri = isRemote
                ? `cursor://vscode-remote/ssh-remote+${sshHost}${displayCwd}`
                : `cursor://file${displayCwd}`;
              const iframe = document.createElement("iframe");
              iframe.style.display = "none";
              iframe.src = uri;
              document.body.appendChild(iframe);
              setTimeout(() => iframe.remove(), 1000);
            };
          }}
          className={`h-6 px-2 rounded-full flex items-center gap-1.5 bg-white/5 hover:bg-white/10 border border-white/5 hover:border-white/10 transition-colors text-[11px] ${cursorLoading ? "text-zinc-600 cursor-wait" : "text-zinc-400 hover:text-white"}`}
          title={displayBranch ? `Open workspace for ${displayBranch}` : "Open in Cursor"}
        >
          {cursorLoading ? (
            <Loader2 className="w-3 h-3 animate-spin" />
          ) : (
            <svg width="12" height="12" viewBox="675 357 250 286" fill="none">
              <path d="M800 500L923.821 571.486C923.061 572.804 921.957 573.929 920.591 574.716L804.863 641.531C801.858 643.266 798.151 643.266 795.146 641.531L679.417 574.716C678.052 573.929 676.948 572.804 676.188 571.486L800 500Z" fill="currentColor" opacity="0.5"/>
              <path d="M800 357.168V500L676.188 571.486C675.427 570.168 675.004 568.647 675.004 567.072V432.928C675.004 429.774 676.686 426.865 679.418 425.285L795.141 358.47C796.646 357.602 798.323 357.168 800 357.168Z" fill="currentColor" opacity="0.7"/>
              <path d="M923.815 428.515C923.055 427.197 921.951 426.072 920.586 425.285L804.857 358.47C803.357 357.602 801.68 357.168 800 357.168V500L923.821 571.486C924.581 570.168 925.005 568.647 925.005 567.072V432.928C925.005 431.348 924.587 429.838 923.821 428.515Z" fill="currentColor"/>
            </svg>
          )}
          {cursorLoading ? "..." : "Cursor"}
        </button>
        <div className="h-4 w-px bg-border mx-2" />
        <span className="font-mono text-xs text-zinc-600 max-w-[400px] truncate whitespace-nowrap" title={displayCwd?.replace(/^\/home\/[^/]+/, "~") || "~"}>
          cwd: {shortenPath(displayCwd || "")}
        </span>
        {/* Cursor workspace progress + result toast */}
        {(cursorLoading || cursorResult) && (
          <div className="absolute top-full left-0 mt-1 z-50 bg-zinc-800 border border-zinc-700 rounded-md px-3 py-2 shadow-lg max-w-md min-w-[280px]">
            {cursorLoading && (
              <div className="flex items-center gap-2">
                <Loader2 className="w-3 h-3 animate-spin text-violet-400 flex-shrink-0" />
                <span className="text-[11px] text-zinc-300 truncate">{cursorStatus || "Starting..."}</span>
              </div>
            )}
            {cursorResult && (
              <>
                <div className="text-[10px] text-zinc-400 mb-1">
                  Curated {cursorResult.rawDirCount} dirs &rarr; {cursorResult.curatedDirs.length} folders:
                </div>
                {cursorResult.curatedDirs.map((dir, i) => (
                  <div key={i} className="text-[11px] text-green-400 font-mono truncate">
                    {dir}
                  </div>
                ))}
                <button
                  onClick={() => setCursorResult(null)}
                  className="absolute top-1 right-1.5 text-zinc-500 hover:text-white text-xs"
                >
                  x
                </button>
              </>
            )}
          </div>
        )}
      </div>

      {/* Center - Status counts or auto-resume progress */}
      <div className="absolute left-1/2 -translate-x-1/2">
        <AnimatePresence mode="wait">
          {showProgress ? (
            <motion.div
              key="progress"
              initial={{ opacity: 0, y: -10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 10 }}
              className="flex items-center gap-2 px-3 py-1 rounded-full bg-surface text-xs"
            >
              <Loader2 className="w-3 h-3 text-violet-400 animate-spin" />
              <span className="text-zinc-400">
                Restoring agents... {autoResumeProgress!.completed}/{autoResumeProgress!.total}
              </span>
              <div className="w-20 h-1.5 rounded-full bg-zinc-700 overflow-hidden">
                <motion.div
                  className="h-full rounded-full bg-violet-500"
                  initial={{ width: 0 }}
                  animate={{ width: `${progressPct}%` }}
                  transition={{ duration: 0.3 }}
                />
              </div>
            </motion.div>
          ) : (
            <motion.div
              key="status"
              initial={{ opacity: 0, y: -10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 10 }}
              className="flex items-center gap-3 px-3 py-1 rounded-full bg-surface text-xs"
              data-tour="status-badges"
            >
              {/* Working agents */}
              <div className="flex items-center gap-1.5">
                <div className="w-1.5 h-1.5 rounded-full bg-green-500" />
                <span className="text-zinc-400">{statusCounts.working}</span>
              </div>
              {/* Waiting agents (only shown when > 0) */}
              {statusCounts.waiting > 0 && (
                <div className="flex items-center gap-1.5">
                  <div className="w-1.5 h-1.5 rounded-full bg-indigo-400" />
                  <span className="text-zinc-400">{statusCounts.waiting}</span>
                </div>
              )}
              {/* Needs input agents */}
              <div className="flex items-center gap-1.5">
                <div className="w-1.5 h-1.5 rounded-full bg-orange-400" />
                <span className="text-zinc-400">{statusCounts.needsInput}</span>
              </div>
              {/* Idle agents */}
              <div className="flex items-center gap-1.5">
                <div className="w-1.5 h-1.5 rounded-full bg-yellow-400" />
                <span className="text-zinc-400">{statusCounts.idle}</span>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Right side buttons */}
      <div className="flex items-center gap-2">
        <button
          onClick={() => setHelpOpen(true)}
          className="relative p-2 rounded-md text-zinc-400 hover:text-white hover:bg-surface-active transition-colors"
          title="Help & Shortcuts (?)"
        >
          <HelpCircle className="w-4 h-4" />
          {unseenUpdates.length > 0 && (
            <span className="absolute top-1 right-1 w-2 h-2 rounded-full bg-blue-500" />
          )}
        </button>
        <button
          onClick={() => setSearchOpen(true)}
          className="p-2 rounded-md text-zinc-400 hover:text-white hover:bg-surface-active transition-colors"
          title="Search Conversations (Cmd+K)"
        >
          <Search className="w-4 h-4" />
        </button>
        <button
          onClick={() => setShowArchived(!showArchived)}
          className={`p-2 rounded-md transition-colors ${
            showArchived
              ? "text-orange-400 bg-orange-500/10 hover:bg-orange-500/20"
              : "text-zinc-400 hover:text-white hover:bg-surface-active"
          }`}
          title={showArchived ? "Hide Archived" : "Show Archived"}
        >
          <Archive className="w-4 h-4" />
        </button>
        <button
          onClick={() => setSettingsOpen(true)}
          className="p-2 rounded-md text-zinc-400 hover:text-white hover:bg-surface-active transition-colors"
          title="Settings"
        >
          <Settings className="w-4 h-4" />
        </button>
        <motion.button
          data-tour="new-agent"
          onClick={() => setAddAgentModalOpen(true)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-white text-canvas text-sm font-medium hover:bg-zinc-100 transition-colors"
          whileHover={{ scale: 1.02 }}
          whileTap={{ scale: 0.98 }}
        >
          <Plus className="w-4 h-4" />
          New Agent
        </motion.button>
      </div>

      <HelpModal
        open={helpOpen}
        onClose={() => setHelpOpen(false)}
        unseenUpdates={unseenUpdates}
        olderUpdates={olderUpdates}
        onMarkAsSeen={markAsSeen}
        onRestartTour={() => {
          fetch("/api/settings", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ tourCompleted: false }),
          })
            .then(() => window.dispatchEvent(new CustomEvent("openui:restart-tour")))
            .catch(() => {});
        }}
      />
      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <ConversationSearchModal
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        onResume={(conv) => {
          setSearchOpen(false);
          // Store the conversation to resume, then open the new agent modal
          useStore.getState().setPendingResumeConversation(conv);
          setAddAgentModalOpen(true);
        }}
      />
    </header>
  );
}
