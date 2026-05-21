#!/usr/bin/env -S deno run -A

import { parseArgs } from "@std/cli";
import {
  aggregateProfile,
  buildSymbolLookup,
  loadProfile,
  mergeThreads,
} from "./parser.ts";
import { formatAllResults, type FormatOptions } from "./formatter.ts";
import type { ThreadInfo } from "./types.ts";

const VERSION = "0.1.0";

function printHelp() {
  console.log(`
flamey v${VERSION} - LLM-friendly profiling output

USAGE:
  flamey [OPTIONS] -- <COMMAND> [ARGS...]    Profile a command
  flamey --pid <PID>                         Attach to an existing process
  flamey --load <profile.json>               Load existing profile

OPTIONS:
  -h, --help              Show this help message
  -V, --version           Show version
  -o, --output <file>     Write output to file (default: stdout)
  -f, --format <fmt>      Output format: text, markdown, json (default: text)
  --top-functions <n>     Number of top functions to show (default: 30)
  --max-depth <n>         Max call tree depth (default: 50)
  --min-percent <n>       Min percentage to show (default: 0.1)
  --rate <hz>             Sampling rate in Hz (default: 1000)
  --duration <sec>        Max recording duration in seconds
  --ignore-before <time>  Ignore samples before this elapsed time (e.g. 250ms, 1s)
  --main-thread-only      Only profile main thread
  -p, --pid <PID>         Attach to an existing process by PID
  --load <file>           Load existing profile.json instead of recording
  --forward-sigint        Forward SIGINT to samply (use when running as subprocess)

  Thread filtering:
  -t, --thread <pattern>  Only show threads with name matching pattern
  --exclude-thread <pat>  Exclude threads with name matching pattern
  --min-samples <n>       Only show threads with at least N samples (default: 5)
  --merge-threads         Merge same-named threads into a single combined profile
  --max-threads <n>       Max threads to show per unique thread name (busiest first)

EXAMPLES:
  # Profile a command and output to terminal
  flamey -- ./my-program arg1 arg2

  # Profile with markdown output for documentation
  flamey -f markdown -o profile.md -- cargo build

  # Load an existing profile
  flamey --load profile.json

  # Profile with custom settings
  flamey --rate 100 --duration 30 -- python script.py

  # Ignore startup warmup samples
  flamey --ignore-before 250ms -- ./my-program

  # Attach to a running process
  flamey --pid 12345
  flamey -p 12345 --duration 10

  # Filter to specific threads
  flamey --thread main --load profile.json
  flamey --exclude-thread worker --min-samples 100 --load profile.json

  # Handle large thread pools (e.g. tokio workers)
  flamey --merge-threads --load profile.json
  flamey --max-threads 5 --load profile.json

SIGNAL HANDLING:
  Press Ctrl+C once to stop recording and process the profile.
  Press Ctrl+C twice (within 1 second) to abort completely.

OUTPUT FORMAT:
  The output is designed to be easily parsed by LLMs, with:
  - Summary statistics
  - Top functions by self-time (where CPU is actually spent)
  - Call tree showing hot paths
  - Most frequent stack traces

  This helps identify performance bottlenecks without requiring
  visual flamegraph interpretation.
`);
}

async function detectPresymbolicateFlag(): Promise<string | null> {
  try {
    const output = await new Deno.Command("samply", {
      args: ["record", "--help"],
      stdout: "piped",
      stderr: "piped",
    }).output();
    const help = new TextDecoder().decode(output.stdout) +
      new TextDecoder().decode(output.stderr);
    if (help.includes("--unstable-presymbolicate")) {
      return "--unstable-presymbolicate";
    }
    if (help.includes("--presymbolicate")) {
      return "--presymbolicate";
    }
    return null;
  } catch {
    return null;
  }
}

async function recordProfile(
  target: { command: string[] } | { pid: number },
  options: {
    rate?: number;
    duration?: number;
    mainThreadOnly?: boolean;
    forwardSigint?: boolean;
  },
): Promise<string> {
  // Create temp file for profile output
  const tempDir = await Deno.makeTempDir({ prefix: "flamey-" });
  const profilePath = `${tempDir}/profile.json`;

  const presymbolicateFlag = await detectPresymbolicateFlag();

  // Build samply command
  const samplyArgs = ["record", "--save-only"];
  if (presymbolicateFlag) {
    samplyArgs.push(presymbolicateFlag);
  }
  samplyArgs.push("-o", profilePath);

  if (options.rate) {
    samplyArgs.push("--rate", options.rate.toString());
  }
  if (options.duration) {
    samplyArgs.push("--duration", options.duration.toString());
  }
  if (options.mainThreadOnly) {
    samplyArgs.push("--main-thread-only");
  }

  if ("pid" in target) {
    samplyArgs.push("--pid", target.pid.toString());
  } else {
    samplyArgs.push("--");
    samplyArgs.push(...target.command);
  }

  console.error(`Recording profile: samply ${samplyArgs.join(" ")}`);
  console.error("(Press Ctrl+C to stop recording, twice to abort)");
  console.error("");

  const proc = new Deno.Command("samply", {
    args: samplyArgs,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }).spawn();

  // Track Ctrl+C presses for double-tap to exit
  let lastSigint = 0;
  let receivedSigint = false;
  const DOUBLE_TAP_MS = 1000;

  const sigintHandler = () => {
    const now = Date.now();
    if (now - lastSigint < DOUBLE_TAP_MS) {
      // Double Ctrl+C - kill samply and exit
      console.error("\nAborting...");
      try {
        proc.kill("SIGKILL");
      } catch {
        // Process may have already exited
      }
      Deno.exit(130); // Standard exit code for SIGINT
    } else {
      lastSigint = now;
      receivedSigint = true;
      console.error("\nStopping recording... (press Ctrl+C again to abort)");

      // Forward SIGINT if explicitly requested (for subprocess use)
      // In TTY mode, samply receives SIGINT directly from terminal
      if (options.forwardSigint) {
        try {
          // First signal all children of samply (the profiled process)
          // This ensures the profiled process exits before samply tries to finalize
          new Deno.Command("pkill", {
            args: ["-INT", "-P", `${proc.pid}`],
          }).outputSync();

          // Then signal samply itself
          new Deno.Command("kill", {
            args: ["-INT", `${proc.pid}`],
          }).outputSync();
        } catch {
          // Process may have already exited
        }
      }
    }
  };

  Deno.addSignalListener("SIGINT", sigintHandler);

  // samply's --duration stops profiling but does not stop the profiled
  // process. When we spawned the command ourselves, enforce the duration by
  // signalling the child process tree once the time is up so samply can
  // finalize the profile.
  let durationTimer: ReturnType<typeof setTimeout> | undefined;
  if (options.duration && "command" in target) {
    durationTimer = setTimeout(() => {
      console.error(
        `\nDuration of ${options.duration}s elapsed, stopping profiled process...`,
      );
      try {
        new Deno.Command("pkill", {
          args: ["-INT", "-P", `${proc.pid}`],
        }).outputSync();
      } catch {
        // Process may have already exited
      }
    }, options.duration * 1000);
  }

  try {
    const status = await proc.status;

    // If we sent SIGINT, any exit is expected (samply may exit with code 1)
    // Only throw if samply failed without us signaling it
    if (!status.success && !receivedSigint) {
      throw new Error(`samply exited with code ${status.code}`);
    }
  } finally {
    if (durationTimer !== undefined) clearTimeout(durationTimer);
    Deno.removeSignalListener("SIGINT", sigintHandler);
  }

  // Check if profile was written
  try {
    await Deno.stat(profilePath);
  } catch {
    if (receivedSigint) {
      throw new Error(
        "Profile was not written. samply may not have had enough samples, " +
          "or the process exited too quickly after Ctrl+C.",
      );
    }
    throw new Error(`Profile was not written to ${profilePath}`);
  }

  return profilePath;
}

function parseDurationMs(
  value: unknown,
  optionName: string,
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "number") {
    if (Number.isFinite(value) && value >= 0) return value;
    throw new Error(`Invalid ${optionName} value: ${value}`);
  }
  if (typeof value !== "string") {
    throw new Error(`Invalid ${optionName} value: ${value}`);
  }

  const match = value.trim().match(/^(\d+(?:\.\d+)?)(ms|s)?$/);
  if (!match) {
    throw new Error(
      `Invalid ${optionName} value: ${value} (expected e.g. 250ms or 1s)`,
    );
  }

  const amount = Number.parseFloat(match[1]);
  const unit = match[2] ?? "ms";
  return unit === "s" ? amount * 1000 : amount;
}

async function main() {
  const args = parseArgs(Deno.args, {
    boolean: [
      "help",
      "version",
      "main-thread-only",
      "forward-sigint",
      "merge-threads",
    ],
    string: [
      "output",
      "format",
      "load",
      "thread",
      "exclude-thread",
      "pid",
      "ignore-before",
    ],
    collect: ["thread", "exclude-thread"],
    alias: {
      h: "help",
      V: "version",
      o: "output",
      f: "format",
      t: "thread",
      p: "pid",
    },
    default: {
      format: "text",
      "top-functions": 30,
      "max-depth": 50,
      "min-percent": 0.1,
      "min-samples": 5,
    },
    "--": true,
  });

  if (args.help) {
    printHelp();
    Deno.exit(0);
  }

  if (args.version) {
    console.log(`flamey v${VERSION}`);
    Deno.exit(0);
  }

  const ignoreBeforeMs = parseDurationMs(
    args["ignore-before"],
    "--ignore-before",
  );

  let profilePath: string;

  if (args.load) {
    // Load existing profile
    profilePath = args.load;
  } else if (args.pid) {
    const pid = Number.parseInt(args.pid as string, 10);
    if (!Number.isInteger(pid) || pid <= 0) {
      console.error(`Error: Invalid --pid value: ${args.pid}`);
      Deno.exit(1);
    }

    profilePath = await recordProfile({ pid }, {
      rate: args.rate as number | undefined,
      duration: args.duration as number | undefined,
      mainThreadOnly: args["main-thread-only"] as boolean | undefined,
      forwardSigint: args["forward-sigint"] as boolean | undefined,
    });
  } else if (args._.length > 0 || Deno.args.includes("--")) {
    // Get command after --
    const dashDashIndex = Deno.args.indexOf("--");
    const command = dashDashIndex >= 0
      ? Deno.args.slice(dashDashIndex + 1)
      : args._.map(String);

    if (command.length === 0) {
      console.error("Error: No command specified");
      console.error("Usage: flamey -- <command> [args...]");
      Deno.exit(1);
    }

    // Record profile
    profilePath = await recordProfile({ command }, {
      rate: args.rate as number | undefined,
      duration: args.duration as number | undefined,
      mainThreadOnly: args["main-thread-only"] as boolean | undefined,
      forwardSigint: args["forward-sigint"] as boolean | undefined,
    });
  } else {
    console.error(
      "Error: Must specify either --load <file>, --pid <pid>, or -- <command>",
    );
    printHelp();
    Deno.exit(1);
  }

  // Load and parse profile
  console.error(`\nLoading profile from ${profilePath}...`);
  const parsed = await loadProfile(profilePath);

  // Aggregate data
  console.error("Aggregating profile data...");
  const aggregationOptions = {
    ignoreBeforeMs,
    profileStartTime: parsed.profile.meta.startTime,
  };
  const results = aggregateProfile(parsed, aggregationOptions);

  // Format output
  const formatOptions: FormatOptions = {
    topFunctions: args["top-functions"] as number | undefined,
    maxTreeDepth: args["max-depth"] as number | undefined,
    minPercent: args["min-percent"] as number | undefined,
    format: args.format as "text" | "markdown" | "json",
    showHotPaths: true,
  };

  // Filter threads
  const minSamples = (args["min-samples"] as number) ?? 5;
  const threadPatterns = (args.thread as string[]) ?? [];
  const excludePatterns = (args["exclude-thread"] as string[]) ?? [];
  const shouldMerge = args["merge-threads"] as boolean;
  const maxThreads = args["max-threads"] as number | undefined;

  // Threads with samples, in order matching results[]
  const threadsWithSamples = parsed.profile.threads.filter((t) =>
    t.samples.length > 0
  );

  const filteredPairs: {
    thread: typeof threadsWithSamples[0];
    result: typeof results[0];
  }[] = [];
  for (let i = 0; i < threadsWithSamples.length; i++) {
    const t = threadsWithSamples[i];
    const result = results[i];

    if (result.totalSamples < minSamples) continue;

    if (threadPatterns.length > 0) {
      const matches = threadPatterns.some((p) => t.name.includes(p));
      if (!matches) continue;
    }

    if (excludePatterns.length > 0) {
      const excluded = excludePatterns.some((p) => t.name.includes(p));
      if (excluded) continue;
    }

    filteredPairs.push({ thread: t, result });
  }

  if (filteredPairs.length === 0) {
    console.error("No threads matched the filter criteria.");
    console.error(`Total threads: ${parsed.profile.threads.length}`);
    console.error(`Threads with samples: ${threadsWithSamples.length}`);
    Deno.exit(1);
  }

  // Group by thread name for merge/limit operations
  const groupsByName = new Map<string, typeof filteredPairs>();
  for (const pair of filteredPairs) {
    const name = pair.thread.name;
    const group = groupsByName.get(name);
    if (group) {
      group.push(pair);
    } else {
      groupsByName.set(name, [pair]);
    }
  }

  // Build final output arrays
  const finalThreadInfos: ThreadInfo[] = [];
  const finalResults: typeof results = [];

  const symbolLookup = parsed.symbols
    ? buildSymbolLookup(parsed.symbols, parsed.profile.libs)
    : new Map();

  for (const [name, group] of groupsByName) {
    if (shouldMerge && group.length > 1) {
      // Merge all threads in this group into one combined result
      const threads = group.map((p) => p.thread);
      const merged = mergeThreads(
        threads,
        symbolLookup,
        parsed.profile.libs,
        aggregationOptions,
      );
      const first = group[0].thread;
      finalThreadInfos.push({
        name: `${name} (${group.length} threads merged)`,
        processName: first.processName,
        pid: first.pid,
        tid: first.tid,
      });
      finalResults.push(merged);
    } else if (maxThreads !== undefined && group.length > maxThreads) {
      // Sort by sample count descending, keep top N
      group.sort((a, b) => b.result.totalSamples - a.result.totalSamples);
      const kept = group.slice(0, maxThreads);
      const dropped = group.length - maxThreads;
      console.error(
        `Showing ${maxThreads} of ${group.length} '${name}' threads (busiest first, ${dropped} omitted — use --merge-threads to combine)`,
      );
      for (const pair of kept) {
        finalThreadInfos.push(pair.thread);
        finalResults.push(pair.result);
      }
    } else {
      // Pass through unchanged
      for (const pair of group) {
        finalThreadInfos.push(pair.thread);
        finalResults.push(pair.result);
      }
    }
  }

  const output = formatAllResults(
    finalResults,
    finalThreadInfos,
    formatOptions,
  );

  // Write output
  if (args.output) {
    await Deno.writeTextFile(args.output, output);
    console.error(`\nOutput written to ${args.output}`);
  } else {
    console.error("\n" + "=".repeat(80));
    console.log(output);
  }
}

main().catch((err) => {
  console.error("Error:", err.message);
  Deno.exit(1);
});
