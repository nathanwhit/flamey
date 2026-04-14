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
    const name = truncateName(f.name, 120);

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

    for (let i = 0; i < Math.min(result.hotPaths.length, 10); i++) {
      const path = result.hotPaths[i];
      if (isMarkdown) {
        lines.push(`**Path ${i + 1}:**`);
        lines.push("```");
      } else {
        lines.push(`Path ${i + 1}:`);
      }

      // Show from leaf to root (caller)
      for (let j = 0; j < path.length; j++) {
        const indent = "  ".repeat(j);
        const name = truncateName(path[j], 150);
        if (j === 0) {
          lines.push(`${indent}→ ${name} (leaf/executing)`);
        } else {
          lines.push(`${indent}← ${name}`);
        }
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

  const indent = "  ".repeat(depth);
  const selfInfo = node.selfPercent > 0.5
    ? ` [self: ${node.selfPercent.toFixed(1)}%]`
    : "";
  const name = truncateName(node.name, 120);

  lines.push(
    `${indent}${node.totalPercent.toFixed(1)}% ${name}${selfInfo}`,
  );

  // Only show children that meet the threshold
  const significantChildren = node.children.filter(
    (c) => c.totalPercent >= minPercent,
  );

  for (const child of significantChildren) {
    formatCallTreeNode(child, lines, depth + 1, maxDepth, minPercent);
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

function truncateName(name: string, maxLen: number): string {
  if (name.length <= maxLen) return name;
  // Truncate from the beginning to keep the function name (which is at the end)
  return "..." + name.slice(-(maxLen - 3));
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

    // Skip threads with very few samples
    if (result.totalSamples < 5) continue;

    outputs.push(formatResult(result, thread, options));
  }

  if (options.format === "json") {
    return `[\n${outputs.join(",\n")}\n]`;
  }

  return outputs.join("\n" + "=".repeat(80) + "\n\n");
}
