/**
 * Extract context window size from model string.
 *
 * Model strings from Claude Code include a bracket suffix with the context
 * window size, e.g. "claude-opus-4-6[1m]", "claude-sonnet-4-6[200k]".
 * Parse that first; fall back to known defaults if missing.
 */
export function getContextWindowSize(model?: string): number {
  if (!model) return 200_000;

  // Parse bracket suffix: [1m] → 1_000_000, [200k] → 200_000
  const ctxMatch = model.match(/\[(\d+)([mk])\]/i);
  if (ctxMatch) {
    const num = parseInt(ctxMatch[1], 10);
    const unit = ctxMatch[2].toLowerCase();
    return unit === "m" ? num * 1_000_000 : num * 1_000;
  }

  // Fallback for model strings without bracket suffix
  const m = model.toLowerCase();
  if (m.includes("opus")) return 200_000;
  if (m.includes("sonnet")) return 200_000;
  if (m.includes("haiku")) return 200_000;
  return 200_000;
}
