#!/usr/bin/env -S deno run -A

import { parseArgs } from "jsr:@std/cli@1/parse-args";
import { loadProfile, aggregateProfile } from "./parser.ts";
import { formatAllResults, type FormatOptions } from "./formatter.ts";

const VERSION = "0.1.0";

function printHelp() {
  console.log(`
flamey v${VERSION} - LLM-friendly profiling output

USAGE:
  flamey [OPTIONS] -- <COMMAND> [ARGS...]    Profile a command
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
  --main-thread-only      Only profile main thread
  --load <file>           Load existing profile.json instead of recording
  --forward-sigint        Forward SIGINT to samply (use when running as subprocess)

  Thread filtering:
  -t, --thread <pattern>  Only show threads with name matching pattern
  --exclude-thread <pat>  Exclude threads with name matching pattern
  --min-samples <n>       Only show threads with at least N samples (default: 5)

EXAMPLES:
  # Profile a command and output to terminal
  flamey -- ./my-program arg1 arg2

  # Profile with markdown output for documentation
  flamey -f markdown -o profile.md -- cargo build

  # Load an existing profile
  flamey --load profile.json

  # Profile with custom settings
  flamey --rate 100 --duration 30 -- python script.py

  # Filter to specific threads
  flamey --thread main --load profile.json
  flamey --exclude-thread worker --min-samples 100 --load profile.json

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

async function recordProfile(
  command: string[],
  options: {
    rate?: number;
    duration?: number;
    mainThreadOnly?: boolean;
    forwardSigint?: boolean;
  }
): Promise<string> {
  // Create temp file for profile output
  const tempDir = await Deno.makeTempDir({ prefix: "flamey-" });
  const profilePath = `${tempDir}/profile.json`;

  // Build samply command
  const samplyArgs = [
    "record",
    "--save-only",
    "--unstable-presymbolicate",
    "-o",
    profilePath,
  ];

  if (options.rate) {
    samplyArgs.push("--rate", options.rate.toString());
  }
  if (options.duration) {
    samplyArgs.push("--duration", options.duration.toString());
  }
  if (options.mainThreadOnly) {
    samplyArgs.push("--main-thread-only");
  }

  samplyArgs.push("--");
  samplyArgs.push(...command);

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

  try {
    const status = await proc.status;

    // If we sent SIGINT, any exit is expected (samply may exit with code 1)
    // Only throw if samply failed without us signaling it
    if (!status.success && !receivedSigint) {
      throw new Error(`samply exited with code ${status.code}`);
    }
  } finally {
    Deno.removeSignalListener("SIGINT", sigintHandler);
  }

  // Check if profile was written
  try {
    await Deno.stat(profilePath);
  } catch {
    if (receivedSigint) {
      throw new Error(
        "Profile was not written. samply may not have had enough samples, " +
        "or the process exited too quickly after Ctrl+C."
      );
    }
    throw new Error(`Profile was not written to ${profilePath}`);
  }

  return profilePath;
}

async function main() {
  const args = parseArgs(Deno.args, {
    boolean: ["help", "version", "main-thread-only", "forward-sigint"],
    string: ["output", "format", "load", "thread", "exclude-thread"],
    collect: ["thread", "exclude-thread"],
    alias: {
      h: "help",
      V: "version",
      o: "output",
      f: "format",
      t: "thread",
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

  let profilePath: string;

  if (args.load) {
    // Load existing profile
    profilePath = args.load;
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
    profilePath = await recordProfile(command, {
      rate: args.rate as number | undefined,
      duration: args.duration as number | undefined,
      mainThreadOnly: args["main-thread-only"] as boolean | undefined,
      forwardSigint: args["forward-sigint"] as boolean | undefined,
    });
  } else {
    console.error("Error: Must specify either --load <file> or -- <command>");
    printHelp();
    Deno.exit(1);
  }

  // Load and parse profile
  console.error(`\nLoading profile from ${profilePath}...`);
  const parsed = await loadProfile(profilePath);

  // Aggregate data
  console.error("Aggregating profile data...");
  const results = aggregateProfile(parsed);

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

  const filteredThreads = parsed.profile.threads.filter((t) => {
    // Must have minimum samples
    if (t.samples.length < minSamples) return false;

    // If thread patterns specified, must match at least one
    // Match thread name only (not process name) since threads in same process share process name
    if (threadPatterns.length > 0) {
      const matches = threadPatterns.some((p) => t.name.includes(p));
      if (!matches) return false;
    }

    // Must not match any exclude patterns
    if (excludePatterns.length > 0) {
      const excluded = excludePatterns.some((p) => t.name.includes(p));
      if (excluded) return false;
    }

    return true;
  });

  // Filter results to match the filtered threads
  const filteredResults = results.filter((_, i) => {
    const thread = parsed.profile.threads.filter((t) => t.samples.length > 0)[i];
    return filteredThreads.includes(thread);
  });

  if (filteredThreads.length === 0) {
    console.error("No threads matched the filter criteria.");
    console.error(`Total threads: ${parsed.profile.threads.length}`);
    console.error(`Threads with samples: ${parsed.profile.threads.filter(t => t.samples.length > 0).length}`);
    Deno.exit(1);
  }

  const output = formatAllResults(filteredResults, filteredThreads, formatOptions);

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
