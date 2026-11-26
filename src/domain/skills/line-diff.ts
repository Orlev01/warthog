// A line-by-line comparison of a skill as it is and as an agent suggests it
// (docs/adr/agent-saved-skills.md), so the person sees exactly what would change before they use
// an agent's suggestion — a slipped-in instruction is one added line, not a re-read of the whole
// skill. Pure: no React, no DB, no clock.

export type DiffLine = { readonly kind: "same" | "added" | "removed"; readonly text: string };

// The comparison table is (changed lines before) × (changed lines after); past this many cells
// the caller shows both versions in full instead.
export const DIFF_CELL_LIMIT = 1_000_000;

const linesOf = (text: string) => text.replace(/\r\n?/g, "\n").split("\n");

/** The lines of `after` against `before`, in order, or null when they are too long to compare. */
export function lineDiff(before: string, after: string): DiffLine[] | null {
  const a = linesOf(before), b = linesOf(after);
  // Lines both share at the start and end need no table.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length, endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const n = endA - start, m = endB - start;
  if (n * m > DIFF_CELL_LIMIT) return null;
  // lcs[i][j]: the longest common run of a[start+i..] and b[start+j..].
  const width = m + 1;
  const lcs = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * width + j] = a[start + i] === b[start + j]
        ? lcs[(i + 1) * width + j + 1]! + 1
        : Math.max(lcs[(i + 1) * width + j]!, lcs[i * width + j + 1]!);
    }
  }
  const out: DiffLine[] = a.slice(0, start).map((text) => ({ kind: "same", text }));
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[start + i] === b[start + j]) {
      out.push({ kind: "same", text: a[start + i]! }); i++; j++;
    } else if (i < n && (j === m || lcs[(i + 1) * width + j]! >= lcs[i * width + j + 1]!)) {
      // A replaced line reads as the old one, then the new one.
      out.push({ kind: "removed", text: a[start + i]! }); i++;
    } else {
      out.push({ kind: "added", text: b[start + j]! }); j++;
    }
  }
  for (const text of a.slice(endA)) out.push({ kind: "same", text });
  return out;
}

export type DiffHunk = { readonly kind: "lines"; readonly lines: readonly DiffLine[] } | { readonly kind: "unchanged"; readonly count: number };

/** The diff with long unchanged runs folded, keeping `context` lines beside each change. */
export function foldUnchanged(lines: readonly DiffLine[], context = 2): DiffHunk[] {
  const keep = lines.map((line) => line.kind !== "same");
  const near = keep.map((_, index) => {
    for (let k = Math.max(0, index - context); k <= Math.min(lines.length - 1, index + context); k++) if (keep[k]) return true;
    return false;
  });
  const hunks: DiffHunk[] = [];
  let index = 0;
  while (index < lines.length) {
    if (near[index]) {
      const run: DiffLine[] = [];
      while (index < lines.length && near[index]) run.push(lines[index++]!);
      hunks.push({ kind: "lines", lines: run });
    } else {
      let count = 0;
      while (index < lines.length && !near[index]) { count++; index++; }
      hunks.push({ kind: "unchanged", count });
    }
  }
  return hunks;
}
