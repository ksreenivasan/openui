/**
 * Conversation Index Service
 *
 * Indexes Claude Code conversations into SQLite with FTS5 full-text search.
 * Scans JSONL conversation files directly from ~/.claude/projects/ (since
 * sessions-index.json is no longer maintained by Claude Code after v2.1.31).
 * Falls back to sessions-index.json for enriched metadata when available.
 *
 * Modeled after https://github.com/akatz-ai/cc-conversation-search
 */

import { Database } from "bun:sqlite";
import { readdirSync, readFileSync, existsSync, statSync, unlinkSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { getDataDir } from "./persistence";

const CLAUDE_PROJECTS_DIR = join(homedir(), ".claude", "projects");
const DB_PATH = join(getDataDir(), "conversation-index.db");

// Default: index conversations from last 90 days
const DEFAULT_DAYS_BACK = 90;

// UUID pattern for JSONL filenames
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/;

const QUIET = !!process.env.OPENUI_QUIET;
const log = QUIET ? (..._args: any[]) => {} : console.log.bind(console);

// ---------- Types ----------

export interface ConversationSearchResult {
  sessionId: string;
  slug: string;
  summary: string;
  firstPrompt: string;
  messageCount: number;
  created: string;
  modified: string;
  gitBranch: string;
  projectPath: string;
  matchSnippet?: string;
  fileExists: boolean;
}

interface SessionsIndex {
  version: number;
  entries: SessionsIndexEntry[];
  originalPath: string;
}

interface SessionsIndexEntry {
  sessionId: string;
  fullPath: string;
  fileMtime: number;
  firstPrompt: string;
  summary: string;
  messageCount: number;
  created: string;
  modified: string;
  gitBranch: string;
  projectPath: string;
  isSidechain: boolean;
}

// Metadata extracted from a JSONL file when sessions-index.json doesn't have it
interface JnlMetadata {
  slug: string;
  gitBranch: string;
  projectPath: string;
  firstPrompt: string;
  created: string;
  modified: string;
  isSidechain: boolean;
  messageCount: number;
  hasContent: boolean; // true if file has at least one user/assistant message
}

// ---------- Database ----------

let db: Database | null = null;

function getDb(): Database {
  if (db) return db;

  try {
    db = new Database(DB_PATH);
    db.exec("PRAGMA journal_mode=WAL");
    db.exec("PRAGMA synchronous=NORMAL");
    db.exec("PRAGMA busy_timeout=30000");
    initSchema(db);
    return db;
  } catch (e) {
    // If database is corrupted, delete and recreate
    log(`\x1b[38;5;208m[conv-index]\x1b[0m Database error, recreating:`, e);
    try { unlinkSync(DB_PATH); } catch (_) {}
    db = new Database(DB_PATH);
    db.exec("PRAGMA journal_mode=WAL");
    db.exec("PRAGMA synchronous=NORMAL");
    db.exec("PRAGMA busy_timeout=30000");
    initSchema(db);
    return db;
  }
}

function initSchema(database: Database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      session_id TEXT PRIMARY KEY,
      project_path TEXT NOT NULL,
      slug TEXT DEFAULT '',
      summary TEXT,
      first_prompt TEXT,
      message_count INTEGER DEFAULT 0,
      created TEXT,
      modified TEXT,
      git_branch TEXT,
      is_sidechain INTEGER DEFAULT 0,
      file_mtime INTEGER DEFAULT 0,
      full_path TEXT DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS messages (
      uuid TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      message_type TEXT NOT NULL,
      content TEXT NOT NULL,
      timestamp TEXT,
      is_tool_noise INTEGER DEFAULT 0,
      FOREIGN KEY (session_id) REFERENCES conversations(session_id)
    );

    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
    CREATE INDEX IF NOT EXISTS idx_conversations_modified ON conversations(modified DESC);
    CREATE INDEX IF NOT EXISTS idx_conversations_project ON conversations(project_path);
  `);

  // Add slug column if missing (migration from old schema)
  try { database.exec("ALTER TABLE conversations ADD COLUMN slug TEXT DEFAULT ''"); } catch (_) {}
  try { database.exec("ALTER TABLE conversations ADD COLUMN full_path TEXT DEFAULT ''"); } catch (_) {}

  // Standalone FTS5 table (stores its own content so snippet() works)
  try {
    database.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS message_fts USING fts5(
        session_id UNINDEXED,
        content
      );
    `);
  } catch (e) {
    // FTS table might already exist
  }
}

// ---------- Indexer ----------

let lastIndexTime = 0;
const INDEX_COOLDOWN_MS = 10_000; // Don't re-index more often than every 10s

export function ensureIndex(options?: { daysBack?: number }): void {
  const now = Date.now();
  if (now - lastIndexTime < INDEX_COOLDOWN_MS) return;
  lastIndexTime = now;

  const daysBack = options?.daysBack ?? DEFAULT_DAYS_BACK;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - daysBack);
  const cutoffMs = cutoff.getTime();

  if (!existsSync(CLAUDE_PROJECTS_DIR)) return;

  const database = getDb();
  let totalIndexed = 0;
  let totalSkipped = 0;

  let projectDirs: string[];
  try {
    projectDirs = readdirSync(CLAUDE_PROJECTS_DIR);
  } catch {
    return;
  }

  for (const dirName of projectDirs) {
    if (dirName.startsWith(".")) continue;

    const projectDir = join(CLAUDE_PROJECTS_DIR, dirName);

    // Build lookup map from sessions-index.json (may be incomplete or absent)
    const indexMetadata = new Map<string, SessionsIndexEntry>();
    let originalPath = "";
    const indexPath = join(projectDir, "sessions-index.json");
    if (existsSync(indexPath)) {
      try {
        const index: SessionsIndex = JSON.parse(readFileSync(indexPath, "utf-8"));
        originalPath = index.originalPath || "";
        if (index.entries && Array.isArray(index.entries)) {
          for (const entry of index.entries) {
            indexMetadata.set(entry.sessionId, entry);
          }
        }
      } catch {
        // Corrupt index file, continue with JSONL scanning
      }
    }

    // Scan for JSONL files directly (the primary discovery method)
    let files: string[];
    try {
      files = readdirSync(projectDir);
    } catch {
      continue;
    }

    for (const fileName of files) {
      if (!UUID_RE.test(fileName)) continue;

      const sessionId = fileName.replace(".jsonl", "");
      const filePath = join(projectDir, fileName);

      // Check file mtime
      let fileMtime: number;
      try {
        fileMtime = statSync(filePath).mtimeMs;
      } catch {
        continue;
      }

      // Skip old files
      if (fileMtime < cutoffMs) {
        totalSkipped++;
        continue;
      }

      // Check if already indexed with same mtime
      const existing = database
        .prepare("SELECT file_mtime FROM conversations WHERE session_id = ?")
        .get(sessionId) as { file_mtime: number } | null;

      if (existing && Math.abs(existing.file_mtime - fileMtime) < 1000) {
        totalSkipped++;
        continue;
      }

      // Check sessions-index.json for enriched metadata
      const indexEntry = indexMetadata.get(sessionId);

      if (indexEntry && indexEntry.isSidechain) {
        continue; // Skip sidechains
      }

      try {
        indexConversation(database, {
          sessionId,
          filePath,
          fileMtime,
          indexEntry,
          originalPath,
        });
        totalIndexed++;
      } catch (e) {
        log(`\x1b[38;5;208m[conv-index]\x1b[0m Failed to index ${sessionId}:`, e);
      }
    }
  }

  if (totalIndexed > 0) {
    log(`\x1b[38;5;82m[conv-index]\x1b[0m Indexed ${totalIndexed} conversations (${totalSkipped} skipped)`);
  }
}

function indexConversation(database: Database, params: {
  sessionId: string;
  filePath: string;
  fileMtime: number;
  indexEntry?: SessionsIndexEntry;
  originalPath: string;
}): void {
  const { sessionId, filePath, fileMtime, indexEntry, originalPath } = params;

  let fileContent: string;
  try {
    fileContent = readFileSync(filePath, "utf-8");
  } catch {
    return;
  }

  const lines = fileContent.split("\n").filter((l) => l.trim());

  // Parse messages and extract metadata from JSONL
  const messages: { uuid: string; messageType: string; content: string; timestamp: string; isToolNoise: number }[] = [];
  const meta: JnlMetadata = {
    slug: "",
    gitBranch: "",
    projectPath: originalPath,
    firstPrompt: "",
    created: "",
    modified: "",
    isSidechain: false,
    messageCount: 0,
    hasContent: false,
  };

  let firstTimestamp = "";
  let lastTimestamp = "";

  for (const line of lines) {
    let parsed: any;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }

    // Extract metadata from any message type (slug, branch, etc.)
    if (!meta.slug && parsed.slug) meta.slug = parsed.slug;
    if (!meta.gitBranch && parsed.gitBranch) meta.gitBranch = parsed.gitBranch;
    if (!meta.projectPath && parsed.cwd) meta.projectPath = parsed.cwd;
    if (parsed.isSidechain) meta.isSidechain = true;
    if (parsed.timestamp) {
      if (!firstTimestamp) firstTimestamp = parsed.timestamp;
      lastTimestamp = parsed.timestamp;
    }

    // Only index user and assistant messages
    if (parsed.type !== "user" && parsed.type !== "assistant") continue;
    if (!parsed.uuid || !parsed.message) continue;

    meta.messageCount++;
    meta.hasContent = true;

    // Extract firstPrompt from the first real user message (string content, not tool results)
    if (!meta.firstPrompt && parsed.type === "user" && typeof parsed.message?.content === "string") {
      meta.firstPrompt = parsed.message.content.slice(0, 200);
    }

    const content = extractContent(parsed);
    if (!content || content.length < 5) continue;

    const isToolNoise = detectToolNoise(content) ? 1 : 0;

    messages.push({
      uuid: parsed.uuid,
      messageType: parsed.type,
      content,
      timestamp: parsed.timestamp || "",
      isToolNoise,
    });
  }

  meta.created = firstTimestamp;
  meta.modified = lastTimestamp;

  // Skip files with no real content (file-history-only files)
  if (!meta.hasContent) return;

  // Skip sidechains
  if (meta.isSidechain) return;

  // Use sessions-index.json metadata when available (it has better summaries)
  const summary = indexEntry?.summary || "";
  const firstPrompt = indexEntry?.firstPrompt || meta.firstPrompt || "";
  const created = indexEntry?.created || meta.created || "";
  const modified = indexEntry?.modified || meta.modified || "";
  const gitBranch = indexEntry?.gitBranch || meta.gitBranch || "";
  const projectPath = indexEntry?.projectPath || meta.projectPath || "";
  const messageCount = indexEntry?.messageCount || meta.messageCount;

  // Upsert in a transaction
  const txn = database.transaction(() => {
    // Delete old data for this conversation (for re-indexing)
    database.prepare("DELETE FROM messages WHERE session_id = ?").run(sessionId);
    database.prepare("DELETE FROM message_fts WHERE session_id = ?").run(sessionId);

    // Upsert conversation metadata
    database
      .prepare(
        `INSERT OR REPLACE INTO conversations
         (session_id, project_path, slug, summary, first_prompt, message_count, created, modified, git_branch, is_sidechain, file_mtime, full_path)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        sessionId,
        projectPath,
        meta.slug,
        summary,
        firstPrompt,
        messageCount,
        created,
        modified,
        gitBranch,
        0, // not sidechain (we skip sidechains above)
        fileMtime,
        filePath
      );

    // Insert messages
    const insertMsg = database.prepare(
      `INSERT OR IGNORE INTO messages (uuid, session_id, message_type, content, timestamp, is_tool_noise)
       VALUES (?, ?, ?, ?, ?, ?)`
    );

    // Insert into FTS (only non-tool-noise messages)
    const insertFts = database.prepare(
      `INSERT INTO message_fts (session_id, content) VALUES (?, ?)`
    );

    for (const msg of messages) {
      insertMsg.run(msg.uuid, sessionId, msg.messageType, msg.content, msg.timestamp, msg.isToolNoise);
      if (!msg.isToolNoise) {
        insertFts.run(sessionId, msg.content);
      }
    }
  });

  txn();
}

// ---------- Content Extraction ----------

function extractContent(parsed: any): string {
  const msg = parsed.message;
  if (!msg) return "";

  if (parsed.type === "user") {
    // User messages: content is a string (real user input)
    if (typeof msg.content === "string") return msg.content;
    // Tool result arrays -- extract text parts only
    if (Array.isArray(msg.content)) {
      return msg.content
        .filter((block: any) => block.type === "text")
        .map((block: any) => block.text)
        .join("\n");
    }
    return "";
  }

  if (parsed.type === "assistant") {
    // Assistant messages: content is an array of blocks
    if (!Array.isArray(msg.content)) return typeof msg.content === "string" ? msg.content : "";

    const textParts = msg.content
      .filter((block: any) => block.type === "text")
      .map((block: any) => block.text || "");

    const fullText = textParts.join("\n");

    // Smart extraction: first 500 + last 200 chars for long messages
    if (fullText.length > 800) {
      const first = fullText.slice(0, 500);
      const last = fullText.slice(-200);
      return `${first}\n...\n${last}`;
    }

    return fullText;
  }

  return "";
}

function detectToolNoise(content: string): boolean {
  // Skip very short messages
  if (content.length < 50) return true;

  // Detect pure tool markers
  const toolPatterns = [
    /^\[Tool: \w+\]/,
    /^Let me (?:read|check|look|search|find)/i,
    /^I'll (?:read|check|look|search|find)/i,
  ];

  const stripped = content.replace(/\[Tool: \w+\]/g, "").trim();
  if (stripped.length < 50) return true;

  for (const pattern of toolPatterns) {
    if (pattern.test(content) && content.length < 100) return true;
  }

  return false;
}

// ---------- Search ----------

export function searchConversations(params: {
  query?: string;
  projectPath?: string;
  limit?: number;
}): ConversationSearchResult[] {
  const { query, projectPath, limit = 30 } = params;

  ensureIndex();
  const database = getDb();

  if (query && query.trim()) {
    return searchWithFts(database, query.trim(), projectPath, limit);
  }

  return listRecent(database, projectPath, limit);
}

function searchWithFts(
  database: Database,
  query: string,
  projectPath: string | undefined,
  limit: number
): ConversationSearchResult[] {
  // Sanitize query for FTS5: escape special chars and add wildcards
  const ftsQuery = sanitizeFtsQuery(query);

  // Step 1: Find matching session_ids via FTS
  const matchingIds = database
    .prepare("SELECT DISTINCT session_id FROM message_fts WHERE message_fts MATCH ?")
    .all(ftsQuery) as { session_id: string }[];

  if (matchingIds.length === 0) return [];

  const idList = matchingIds.map((r) => r.session_id);

  // Step 2: Get conversation details for matching sessions
  const placeholders = idList.map(() => "?").join(",");
  let sql = `
    SELECT
      session_id,
      slug,
      summary,
      first_prompt,
      message_count,
      created,
      modified,
      git_branch,
      project_path,
      full_path,
      NULL AS match_snippet
    FROM conversations
    WHERE session_id IN (${placeholders})
      AND is_sidechain = 0
  `;

  const sqlParams: any[] = [...idList];

  if (projectPath) {
    sql += " AND project_path = ?";
    sqlParams.push(projectPath);
  }

  sql += `
    ORDER BY modified DESC
    LIMIT ?
  `;
  sqlParams.push(limit);

  try {
    const rows = database.prepare(sql).all(...sqlParams) as any[];

    // Step 3: Get one snippet per conversation
    const results = rows.map(mapRow);
    for (const result of results) {
      try {
        const snippetRow = database
          .prepare(
            "SELECT snippet(message_fts, 1, '>>>', '<<<', '...', 30) AS snip FROM message_fts WHERE message_fts MATCH ? AND session_id = ? LIMIT 1"
          )
          .get(ftsQuery, result.sessionId) as { snip: string } | null;
        if (snippetRow?.snip) {
          result.matchSnippet = snippetRow.snip;
        }
      } catch {
        // Snippet extraction failed for this row, skip
      }
    }

    return results;
  } catch (e) {
    log(`\x1b[38;5;208m[conv-index]\x1b[0m FTS search failed, falling back to LIKE:`, e);
    return searchWithLike(database, query, projectPath, limit);
  }
}

function searchWithLike(
  database: Database,
  query: string,
  projectPath: string | undefined,
  limit: number
): ConversationSearchResult[] {
  let sql = `
    SELECT DISTINCT
      c.session_id,
      c.slug,
      c.summary,
      c.first_prompt,
      c.message_count,
      c.created,
      c.modified,
      c.git_branch,
      c.project_path,
      c.full_path,
      NULL AS match_snippet
    FROM conversations c
    LEFT JOIN messages m ON m.session_id = c.session_id
    WHERE (c.summary LIKE ? OR c.first_prompt LIKE ? OR c.slug LIKE ? OR m.content LIKE ?)
      AND c.is_sidechain = 0
  `;

  const likePattern = `%${query}%`;
  const sqlParams: any[] = [likePattern, likePattern, likePattern, likePattern];

  if (projectPath) {
    sql += " AND c.project_path = ?";
    sqlParams.push(projectPath);
  }

  sql += `
    ORDER BY c.modified DESC
    LIMIT ?
  `;
  sqlParams.push(limit);

  const rows = database.prepare(sql).all(...sqlParams) as any[];
  return rows.map(mapRow);
}

function listRecent(
  database: Database,
  projectPath: string | undefined,
  limit: number
): ConversationSearchResult[] {
  let sql = `
    SELECT
      session_id,
      slug,
      summary,
      first_prompt,
      message_count,
      created,
      modified,
      git_branch,
      project_path,
      full_path,
      NULL AS match_snippet
    FROM conversations
    WHERE is_sidechain = 0
  `;

  const sqlParams: any[] = [];

  if (projectPath) {
    sql += " AND project_path = ?";
    sqlParams.push(projectPath);
  }

  sql += `
    ORDER BY modified DESC
    LIMIT ?
  `;
  sqlParams.push(limit);

  const rows = database.prepare(sql).all(...sqlParams) as any[];
  return rows.map(mapRow);
}

function mapRow(row: any): ConversationSearchResult {
  // Check if the JSONL file still exists on disk
  const fullPath = row.full_path || "";
  const fileExists = fullPath ? existsSync(fullPath) : false;

  return {
    sessionId: row.session_id,
    slug: row.slug || "",
    summary: row.summary || "",
    firstPrompt: row.first_prompt || "",
    messageCount: row.message_count || 0,
    created: row.created || "",
    modified: row.modified || "",
    gitBranch: row.git_branch || "",
    projectPath: row.project_path || "",
    matchSnippet: row.match_snippet || undefined,
    fileExists,
  };
}

function sanitizeFtsQuery(query: string): string {
  // Remove FTS5 special operators to prevent syntax errors
  let sanitized = query.replace(/[":{}()\[\]^~*]/g, " ").trim();

  // Split into terms and add wildcards for prefix matching
  const terms = sanitized.split(/\s+/).filter((t) => t.length > 0);
  if (terms.length === 0) return '""';

  if (terms.length === 1) {
    return `"${terms[0]}"*`;
  }

  // Multi-term: each term gets a wildcard
  return terms.map((t) => `"${t}"*`).join(" ");
}

// ---------- Projects ----------

export function getClaudeProjects(): { dirName: string; originalPath: string }[] {
  if (!existsSync(CLAUDE_PROJECTS_DIR)) return [];

  const results: { dirName: string; originalPath: string }[] = [];

  let dirs: string[];
  try {
    dirs = readdirSync(CLAUDE_PROJECTS_DIR);
  } catch {
    return [];
  }

  for (const dirName of dirs) {
    if (dirName.startsWith(".")) continue;

    const projectDir = join(CLAUDE_PROJECTS_DIR, dirName);

    // Try sessions-index.json first for originalPath
    const indexPath = join(projectDir, "sessions-index.json");
    if (existsSync(indexPath)) {
      try {
        const index: SessionsIndex = JSON.parse(readFileSync(indexPath, "utf-8"));
        if (index.originalPath) {
          results.push({ dirName, originalPath: index.originalPath });
          continue;
        }
      } catch {
        // Fall through to JSONL scanning
      }
    }

    // No sessions-index.json -- check if directory has JSONL files and extract path
    try {
      const files = readdirSync(projectDir);
      const hasJsonl = files.some(f => UUID_RE.test(f));
      if (hasJsonl) {
        // Decode the directory name (e.g., "-home-user-myproject" -> "/home/user/myproject")
        // This is a heuristic -- the dir name is the path with / replaced by -
        const decodedPath = "/" + dirName.replace(/^-/, "").replace(/-/g, "/");
        results.push({ dirName, originalPath: decodedPath });
      }
    } catch {
      continue;
    }
  }

  return results;
}
