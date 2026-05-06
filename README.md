# flamey

LLM-friendly profiling output. Wraps [samply](https://github.com/mstange/samply) and aggregates the profile into text (or markdown/JSON) that an LLM can actually reason about — top functions by self-time, hot call paths, and frequent stack traces — without needing to interpret a flamegraph visually.

## Install

Requires [Deno](https://deno.com) and [samply](https://github.com/mstange/samply) on `PATH`.

```sh
deno task install
```

This installs a `flamey` binary via `deno install`.

## Usage

Profile a command:

```sh
flamey -- ./my-program arg1 arg2
```

Attach to an already-running process:

```sh
flamey --pid 12345
```

Load an existing samply profile:

```sh
flamey --load profile.json
```

Write markdown to a file:

```sh
flamey -f markdown -o profile.md -- cargo build
```

Press `Ctrl+C` once to stop recording and process the profile, twice (within 1 second) to abort.

See `flamey --help` for the full set of options, including thread filtering (`--thread`, `--exclude-thread`, `--merge-threads`, `--max-threads`), sampling rate, duration, and output tuning (`--top-functions`, `--max-depth`, `--min-percent`).

## Output formats

- `text` (default) — plain text, good for piping into a chat
- `markdown` — same content, formatted for docs or PR descriptions
- `json` — structured aggregates for further tooling

## License

MIT
