import type { AggregationResult, CallTreeNode } from "./parser.ts";
import type { ThreadInfo } from "./types.ts";

export interface FormatOptions {
  topFunctions?: number;
  maxTreeDepth?: number;
  minPercent?: number;
  showHotPaths?: boolean;
  format?: "text" | "markdown" | "json";
}

const DEFAULT_OPTIONS: Required<FormatOptions> = {
  topFunctions: 30,
  maxTreeDepth: 50,
  minPercent: 0.1,
  showHotPaths: true,
  format: "text",
};

export function formatResult(
  result: AggregationResult,
  thread: ThreadInfo,
  options: FormatOptions = {},
): string {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  if (opts.format === "json") {
    return formatJson(result, thread, opts);
  }

  const lines: string[] = [];
  const isMarkdown = opts.format === "markdown";

  // Header
  if (isMarkdown) {
    lines.push(`## Profile: ${thread.processName} (${thread.name})`);
    lines.push("");
  } else {
    lines.push(`=== Profile: ${thread.processName} (${thread.name}) ===`);
    lines.push("");
  }

  // Summary
  lines.push(
    `Total samples: ${result.totalSamples} | Total time: ~${result.totalTime}ms`,
  );
  lines.push("");

  // Top functions by self time (where CPU time is actually spent)
  if (isMarkdown) {
    lines.push("### Top Functions by Self Time");
    lines.push("");
    lines.push(
      "| Rank | Self% | Total% | Self Time | Function |",
    );
    lines.push("|------|-------|--------|-----------|----------|");
  } else {
    lines.push("TOP FUNCTIONS BY SELF TIME:");
    lines.push("-".repeat(80));
    lines.push(
      `${"Rank".padEnd(6)}${"Self%".padEnd(8)}${"Total%".padEnd(9)}${
        "Self Time".padEnd(12)
      }Function`,
    );
    lines.push("-".repeat(80));
  }

  const topFuncs = result.functions.slice(0, opts.topFunctions);
  for (let i = 0; i < topFuncs.length; i++) {
    const f = topFuncs[i];
    if (f.selfPercent < opts.minPercent) continue;

    const rank = `${i + 1}`;
    const selfPct = `${f.selfPercent.toFixed(1)}%`;
    const totalPct = `${f.totalPercent.toFixed(1)}%`;
    const selfTime = `${f.selfTime.toFixed(0)}ms`;
    const name = cleanName(f.name, 120);

    if (isMarkdown) {
      lines.push(
        `| ${rank} | ${selfPct} | ${totalPct} | ${selfTime} | \`${name}\` |`,
      );
    } else {
      lines.push(
        `${rank.padEnd(6)}${selfPct.padEnd(8)}${totalPct.padEnd(9)}${
          selfTime.padEnd(12)
        }${name}`,
      );
    }
  }
  lines.push("");

  // Call tree (hot path focused)
  if (isMarkdown) {
    lines.push("### Call Tree (Hot Paths)");
    lines.push("");
    lines.push("```");
  } else {
    lines.push("CALL TREE (HOT PATHS):");
    lines.push("-".repeat(80));
  }

  formatCallTreeNode(
    result.callTree,
    lines,
    0,
    opts.maxTreeDepth,
    opts.minPercent,
  );

  if (isMarkdown) {
    lines.push("```");
  }
  lines.push("");

  // Hot paths (complete stack traces for the most frequent patterns)
  if (opts.showHotPaths && result.hotPaths.length > 0) {
    if (isMarkdown) {
      lines.push("### Most Frequent Stack Traces");
      lines.push("");
    } else {
      lines.push("MOST FREQUENT STACK TRACES:");
      lines.push("-".repeat(80));
    }

    const displayPaths = result.hotPaths.slice(0, 10);

    // Compute longest common root (suffix in leaf-to-root array). Print once
    // if it's worth sharing, and strip it from each path below.
    const commonRoot = displayPaths.length >= 2
      ? longestCommonSuffix(displayPaths)
      : [];
    const stripCount = commonRoot.length >= 4 ? commonRoot.length : 0;

    if (stripCount > 0) {
      const collapsed = collapseRuns(commonRoot.map((f) => cleanName(f, 100)));
      if (isMarkdown) {
        lines.push(
          `**Shared root** (last ${stripCount} frames in every path below; leaf-of-shared → root):`,
        );
        lines.push("```");
      } else {
        lines.push(
          `Shared root (last ${stripCount} frames in every path below; leaf-of-shared → root):`,
        );
      }
      for (let i = 0; i < collapsed.length; i++) {
        const indent = "  ".repeat(i);
        const { name, count } = collapsed[i];
        const suffix = count > 1 ? ` (×${count})` : "";
        lines.push(`${indent}← ${name}${suffix}`);
      }
      if (isMarkdown) lines.push("```");
      lines.push("");
    }

    for (let i = 0; i < displayPaths.length; i++) {
      const fullPath = displayPaths[i];
      const path = stripCount > 0
        ? fullPath.slice(0, fullPath.length - stripCount)
        : fullPath;
      if (isMarkdown) {
        lines.push(`**Path ${i + 1}:**`);
        lines.push("```");
      } else {
        lines.push(`Path ${i + 1}:`);
      }

      const collapsed = collapseRuns(path.map((f) => cleanName(f, 120)));
      for (let j = 0; j < collapsed.length; j++) {
        const indent = "  ".repeat(j);
        const { name, count } = collapsed[j];
        const suffix = count > 1 ? ` (×${count})` : "";
        if (j === 0) {
          lines.push(`${indent}→ ${name}${suffix} (leaf/executing)`);
        } else {
          lines.push(`${indent}← ${name}${suffix}`);
        }
      }
      if (stripCount > 0) {
        const indent = "  ".repeat(collapsed.length);
        lines.push(`${indent}← [+${stripCount} shared root frames]`);
      }

      if (isMarkdown) {
        lines.push("```");
      }
      lines.push("");
    }
  }

  return lines.join("\n");
}

function formatCallTreeNode(
  node: CallTreeNode,
  lines: string[],
  depth: number,
  maxDepth: number,
  minPercent: number,
): void {
  if (depth > maxDepth) return;
  if (node.totalPercent < minPercent && depth > 0) return;

  // Walk down a chain of single-significant-child nodes whose totalPercent
  // matches their parent (within rounding) and which have no self time worth
  // showing. Collapse 3+ such frames to a single line.
  const chain: CallTreeNode[] = [];
  let cur: CallTreeNode = node;
  while (true) {
    chain.push(cur);
    const sig = cur.children.filter((c) => c.totalPercent >= minPercent);
    if (sig.length !== 1) break;
    if (cur.selfPercent > 0.5) break;
    const child = sig[0];
    if (Math.abs(child.totalPercent - cur.totalPercent) > 0.5) break;
    cur = child;
    if (chain.length > 500) break;
  }

  let nextDepth: number;
  if (chain.length >= 4) {
    const indent = "  ".repeat(depth);
    const head = cleanName(chain[0].name, 60);
    const tail = cleanName(chain[chain.length - 1].name, 60);
    lines.push(
      `${indent}${chain[0].totalPercent.toFixed(1)}% ${head} → … (×${
        chain.length - 2
      } same-%) → ${tail}`,
    );
    nextDepth = depth + 1;
  } else {
    for (let i = 0; i < chain.length; i++) {
      const n = chain[i];
      const ind = "  ".repeat(depth + i);
      const selfInfo = n.selfPercent > 0.5
        ? ` [self: ${n.selfPercent.toFixed(1)}%]`
        : "";
      lines.push(
        `${ind}${n.totalPercent.toFixed(1)}% ${
          cleanName(n.name, 100)
        }${selfInfo}`,
      );
    }
    nextDepth = depth + chain.length;
  }

  const last = chain[chain.length - 1];
  const significantChildren = last.children.filter(
    (c) => c.totalPercent >= minPercent,
  );
  for (const child of significantChildren) {
    formatCallTreeNode(child, lines, nextDepth, maxDepth, minPercent);
  }
}

function formatJson(
  result: AggregationResult,
  thread: ThreadInfo,
  opts: Required<FormatOptions>,
): string {
  const output = {
    thread: {
      name: thread.name,
      processName: thread.processName,
      pid: thread.pid,
      tid: thread.tid,
    },
    summary: {
      totalSamples: result.totalSamples,
      totalTimeMs: result.totalTime,
    },
    topFunctions: result.functions
      .slice(0, opts.topFunctions)
      .filter((f) => f.selfPercent >= opts.minPercent)
      .map((f) => ({
        name: f.name,
        selfPercent: round(f.selfPercent, 2),
        totalPercent: round(f.totalPercent, 2),
        selfTimeMs: round(f.selfTime, 1),
        totalTimeMs: round(f.totalTime, 1),
      })),
    hotPaths: result.hotPaths.slice(0, 10),
  };

  return JSON.stringify(output, null, 2);
}

// Collapse a single bracket-balanced group (e.g. `<...>`, `(...)`) whose
// contents are longer than `minContentLen` into `<…>` / `(…)`. We do this on
// outer-most groups only — inner groups vanish along with their parent.
// Skip collapsing `<...>` whose content contains ` as `, since that's Rust
// UFCS (`<T as Trait>::method`) where the type/trait info is the meaningful
// part of the name.
function collapseGroups(
  s: string,
  open: string,
  close: string,
  minContentLen: number,
): string {
  let out = "";
  let i = 0;
  while (i < s.length) {
    if (s[i] !== open) {
      out += s[i];
      i++;
      continue;
    }
    let depth = 1;
    let j = i + 1;
    while (j < s.length && depth > 0) {
      if (s[j] === open) depth++;
      else if (s[j] === close) depth--;
      if (depth > 0) j++;
    }
    if (depth !== 0) {
      out += s[i];
      i++;
      continue;
    }
    const content = s.slice(i + 1, j);
    if (
      content.length >= minContentLen &&
      !(open === "<" && content.includes(" as "))
    ) {
      out += open + "…" + close;
    } else {
      out += open + content + close;
    }
    i = j + 1;
  }
  return out;
}

// Run-length-encode adjacent identical strings.
function collapseRuns(frames: string[]): { name: string; count: number }[] {
  const out: { name: string; count: number }[] = [];
  for (const f of frames) {
    const last = out[out.length - 1];
    if (last && last.name === f) {
      last.count++;
    } else {
      out.push({ name: f, count: 1 });
    }
  }
  return out;
}

// Frames are leaf-to-root, so the root is at the END of the array. Find the
// longest sequence at the end shared across every path.
function longestCommonSuffix(paths: string[][]): string[] {
  if (paths.length === 0) return [];
  const minLen = Math.min(...paths.map((p) => p.length));
  const suffix: string[] = [];
  for (let i = 1; i <= minLen; i++) {
    const frame = paths[0][paths[0].length - i];
    if (paths.every((p) => p[p.length - i] === frame)) {
      suffix.unshift(frame);
    } else {
      break;
    }
  }
  return suffix;
}

function cleanName(name: string, maxLen: number = 100): string {
  // JS frames are already terse and contain useful file/line info — leave alone.
  if (name.startsWith("JS:")) {
    if (name.length <= maxLen) return name;
    const head = Math.floor((maxLen - 1) / 2);
    const tail = maxLen - 1 - head;
    return name.slice(0, head) + "…" + name.slice(-tail);
  }
  let cleaned = collapseGroups(name, "<", ">", 24);
  cleaned = collapseGroups(cleaned, "(", ")", 24);
  if (cleaned.length <= maxLen) return cleaned;
  const head = Math.floor((maxLen - 1) / 2);
  const tail = maxLen - 1 - head;
  return cleaned.slice(0, head) + "…" + cleaned.slice(-tail);
}

function round(n: number, decimals: number): number {
  const factor = Math.pow(10, decimals);
  return Math.round(n * factor) / factor;
}

export function formatAllResults(
  results: AggregationResult[],
  threads: ThreadInfo[],
  options: FormatOptions = {},
): string {
  const outputs: string[] = [];

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const thread = threads[i];

    outputs.push(formatResult(result, thread, options));
  }

  if (options.format === "json") {
    return `[\n${outputs.join(",\n")}\n]`;
  }

  return outputs.join("\n" + "=".repeat(80) + "\n\n");
}
