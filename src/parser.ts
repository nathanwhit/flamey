import type {
  AggregatedFunction,
  CallTreeNode,
  Profile,
  SymbolsFile,
  Thread,
  ThreadInfo,
} from "./types.ts";

export type { CallTreeNode } from "./types.ts";

export interface ParsedProfile {
  profile: Profile;
  symbols?: SymbolsFile;
}

export async function loadProfile(profilePath: string): Promise<ParsedProfile> {
  const profileText = await Deno.readTextFile(profilePath);
  const profile: Profile = JSON.parse(profileText);

  // Try to load symbols sidecar if it exists
  const symbolsPath = profilePath.replace(/\.json$/, ".syms.json");
  let symbols: SymbolsFile | undefined;
  try {
    const symbolsText = await Deno.readTextFile(symbolsPath);
    symbols = JSON.parse(symbolsText);
  } catch {
    // Symbols file doesn't exist, that's okay
  }

  return { profile, symbols };
}

// Build a lookup from address to symbol name using symbols file
export function buildSymbolLookup(
  symbols: SymbolsFile,
  _libs: Profile["libs"],
): Map<string, Map<number, string>> {
  const lookup = new Map<string, Map<number, string>>();

  for (const libSyms of symbols.data) {
    const addressToSymbol = new Map<number, string>();

    // known_addresses maps [address, symbol_table_index]
    // symbol_table[idx].symbol is the index into the global string_table
    if (libSyms.known_addresses) {
      for (const [addr, symTableIdx] of libSyms.known_addresses) {
        if (symTableIdx < libSyms.symbol_table.length) {
          const symEntry = libSyms.symbol_table[symTableIdx];
          const name = symbols.string_table[symEntry.symbol];
          if (name && name !== "UNKNOWN") {
            addressToSymbol.set(addr, name);
          }
        }
      }
    }

    // Also map symbol_table RVAs directly
    for (const entry of libSyms.symbol_table) {
      const name = symbols.string_table[entry.symbol];
      if (name && name !== "UNKNOWN") {
        addressToSymbol.set(entry.rva, name);
      }
    }

    lookup.set(
      libSyms.debug_id.toLowerCase().replace(/-/g, ""),
      addressToSymbol,
    );
  }

  return lookup;
}

interface SymbolContext {
  symbolLookup: Map<string, Map<number, string>>;
  libs: Profile["libs"];
  resourceTable: Thread["resourceTable"];
  stringArray: Thread["stringArray"];
}

// Get function name for a func index
function getFuncName(
  thread: Thread,
  funcIdx: number,
  ctx?: SymbolContext,
): string {
  const nameIdx = thread.funcTable.name[funcIdx];
  const name = thread.stringArray[nameIdx];

  // If name looks like an address (0x...), try to look it up in symbols
  if (ctx && name && name.startsWith("0x")) {
    const resourceIdx = thread.funcTable.resource[funcIdx];
    if (resourceIdx !== -1 && resourceIdx < thread.resourceTable.lib.length) {
      const libIdx = thread.resourceTable.lib[resourceIdx];
      if (libIdx !== null && libIdx < ctx.libs.length) {
        const lib = ctx.libs[libIdx];
        // breakpadId in profile has an extra "0" at the end
        const debugId = lib.breakpadId.slice(0, -1).toLowerCase().replace(
          /-/g,
          "",
        );
        const libSymbols = ctx.symbolLookup.get(debugId);
        if (libSymbols) {
          const addr = parseInt(name, 16);
          const resolved = libSymbols.get(addr);
          if (resolved) {
            return resolved;
          }
        }
      }
    }
  }

  return name || `func_${funcIdx}`;
}

// Walk the stack from a stack index, returning frame names from leaf to root
function walkStack(
  thread: Thread,
  stackIdx: number | null,
  ctx?: SymbolContext,
): string[] {
  const frames: string[] = [];
  let currentStack = stackIdx;

  while (currentStack !== null && currentStack !== undefined) {
    const frameIdx = thread.stackTable.frame[currentStack];
    const funcIdx = thread.frameTable.func[frameIdx];
    const name = getFuncName(thread, funcIdx, ctx);
    frames.push(name);
    currentStack = thread.stackTable.prefix[currentStack];
  }

  return frames;
}

export interface AggregationResult {
  totalSamples: number;
  totalTime: number;
  functions: AggregatedFunction[];
  callTree: CallTreeNode;
  hotPaths: string[][];
}

// Collect resolved stack traces from a thread
function collectStacks(thread: Thread, ctx?: SymbolContext): string[][] {
  const allStacks: string[][] = [];
  for (let i = 0; i < thread.samples.length; i++) {
    const stackIdx = thread.samples.stack[i];
    if (stackIdx === null || stackIdx === undefined) continue;
    const stack = walkStack(thread, stackIdx, ctx);
    if (stack.length > 0) allStacks.push(stack);
  }
  return allStacks;
}

// Aggregate pre-collected stacks into a result
function aggregateStacks(
  allStacks: string[][],
  totalSamples: number,
  interval: number,
): AggregationResult {
  // Self time: time spent in this function (at top of stack)
  const selfCounts = new Map<string, number>();
  // Total time: time spent in this function or its callees
  const totalCounts = new Map<string, number>();

  for (const stack of allStacks) {
    // Top of stack (leaf) gets self time
    const leaf = stack[0];
    selfCounts.set(leaf, (selfCounts.get(leaf) || 0) + 1);

    // All frames in stack get total time (dedupe within same stack)
    const seen = new Set<string>();
    for (const frame of stack) {
      if (!seen.has(frame)) {
        seen.add(frame);
        totalCounts.set(frame, (totalCounts.get(frame) || 0) + 1);
      }
    }
  }

  const totalTime = totalSamples * interval;

  // Build aggregated functions list
  const functions: AggregatedFunction[] = [];
  const allFuncs = new Set([...selfCounts.keys(), ...totalCounts.keys()]);

  for (const name of allFuncs) {
    const selfCount = selfCounts.get(name) || 0;
    const totalCount = totalCounts.get(name) || 0;

    functions.push({
      name,
      selfTime: selfCount * interval,
      totalTime: totalCount * interval,
      selfPercent: (selfCount / totalSamples) * 100,
      totalPercent: (totalCount / totalSamples) * 100,
      sampleCount: selfCount,
    });
  }

  // Sort by self time descending
  functions.sort((a, b) => b.selfTime - a.selfTime);

  // Build call tree (bottom-up: root is at bottom of stacks)
  const callTree = buildCallTree(allStacks, totalSamples, interval);

  // Find hot paths (most sampled paths)
  const hotPaths = findHotPaths(allStacks, 5);

  return {
    totalSamples,
    totalTime,
    functions,
    callTree,
    hotPaths,
  };
}

export function aggregateThread(
  thread: Thread,
  ctx?: SymbolContext,
): AggregationResult {
  const allStacks = collectStacks(thread, ctx);
  const totalSamples = thread.samples.length;
  const interval = 1; // Could get from profile.meta.interval
  return aggregateStacks(allStacks, totalSamples, interval);
}

function buildCallTree(
  stacks: string[][],
  totalSamples: number,
  interval: number,
): CallTreeNode {
  const root: CallTreeNode = {
    name: "[root]",
    selfTime: 0,
    totalTime: totalSamples * interval,
    selfPercent: 0,
    totalPercent: 100,
    children: [],
  };

  // Build tree by iterating stacks from root to leaf
  for (const stack of stacks) {
    // Stack is leaf-to-root, reverse to get root-to-leaf
    const reversed = [...stack].reverse();

    let current = root;
    for (let i = 0; i < reversed.length; i++) {
      const name = reversed[i];
      const isLeaf = i === reversed.length - 1;

      let child = current.children.find((c) => c.name === name);
      if (!child) {
        child = {
          name,
          selfTime: 0,
          totalTime: 0,
          selfPercent: 0,
          totalPercent: 0,
          children: [],
        };
        current.children.push(child);
      }

      child.totalTime += interval;
      if (isLeaf) {
        child.selfTime += interval;
      }

      current = child;
    }
  }

  // Calculate percentages recursively
  function calcPercents(node: CallTreeNode) {
    node.selfPercent = (node.selfTime / (totalSamples * interval)) * 100;
    node.totalPercent = (node.totalTime / (totalSamples * interval)) * 100;
    // Sort children by total time descending
    node.children.sort((a, b) => b.totalTime - a.totalTime);
    for (const child of node.children) {
      calcPercents(child);
    }
  }

  calcPercents(root);

  return root;
}

function findHotPaths(stacks: string[][], limit: number): string[][] {
  // Count unique paths
  const pathCounts = new Map<string, { stack: string[]; count: number }>();

  for (const stack of stacks) {
    const key = stack.join(" -> ");
    const existing = pathCounts.get(key);
    if (existing) {
      existing.count++;
    } else {
      pathCounts.set(key, { stack: [...stack], count: 1 });
    }
  }

  // Sort by count and take top N
  const sorted = [...pathCounts.values()].sort((a, b) => b.count - a.count);
  return sorted.slice(0, limit).map((p) => p.stack);
}

// Merge multiple threads into a single combined AggregationResult
export function mergeThreads(
  threads: Thread[],
  symbolLookup: Map<string, Map<number, string>>,
  libs: Profile["libs"],
): AggregationResult {
  let allStacks: string[][] = [];
  let totalSamples = 0;

  for (const thread of threads) {
    const ctx: SymbolContext = {
      symbolLookup,
      libs,
      resourceTable: thread.resourceTable,
      stringArray: thread.stringArray,
    };
    const stacks = collectStacks(thread, ctx);
    allStacks = allStacks.concat(stacks);
    totalSamples += thread.samples.length;
  }

  return aggregateStacks(allStacks, totalSamples, 1);
}

export function aggregateProfile(parsed: ParsedProfile): AggregationResult[] {
  const symbolLookup = parsed.symbols
    ? buildSymbolLookup(parsed.symbols, parsed.profile.libs)
    : new Map();

  const results: AggregationResult[] = [];

  for (const thread of parsed.profile.threads) {
    // Skip threads with no samples
    if (thread.samples.length === 0) continue;

    const ctx: SymbolContext = {
      symbolLookup,
      libs: parsed.profile.libs,
      resourceTable: thread.resourceTable,
      stringArray: thread.stringArray,
    };

    const result = aggregateThread(thread, ctx);
    results.push({
      ...result,
      // Add thread info to the result
    });
  }

  return results;
}
