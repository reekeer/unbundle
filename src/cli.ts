#!/usr/bin/env bun
import { parseArgs } from "node:util";
import pkg from "../package.json" with { type: "json" };
import { count, createLogger } from "./log.ts";
import { run } from "./pipeline.ts";
import type { Options } from "./types.ts";

const USAGE = `unbundle <url> [options]

Loads a site the way a browser does and recovers its client code into unbun/<host>/.
Renaming, formatting, source maps and JSX recovery are always on.

  -o, --out <dir>         output root (default: unbun)
      --depth <n>         link depth (default: 2, 0 = only the given page)
      --max-pages <n>     pages to crawl inside the site scope (default: 20)
      --include-external  also load third-party scripts
      --standalone        also write html/<page>.standalone.html marking which DOM
                          each React Client Component rendered (Next.js App Router)
  -v, --verbose           log every request
  -q, --quiet             errors only
  -h, --help              show this help

debugging:
      --no-rename         keep minified identifiers
      --no-format         skip prettier`;

function int(name: string, value: string | undefined, fallback: number, min = 1): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min) throw new Error(`--${name} must be an integer >= ${min}`);
  return n;
}

export function parseCli(argv: string[]): { options: Options; verbose: boolean; quiet: boolean } | "help" {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    allowNegative: true,
    options: {
      out: { type: "string", short: "o" },
      adapter: { type: "string", short: "a" },
      sourcemaps: { type: "boolean", default: true },
      rename: { type: "boolean", default: true },
      webcrack: { type: "boolean", default: true },
      format: { type: "boolean", default: true },
      concurrency: { type: "string", short: "c" },
      workers: { type: "string", short: "w" },
      retries: { type: "string" },
      timeout: { type: "string" },
      "max-bytes": { type: "string" },
      "max-pages": { type: "string" },
      depth: { type: "string" },
      "include-external": { type: "boolean", default: false },
      standalone: { type: "boolean", default: false },
      verbose: { type: "boolean", short: "v", default: false },
      quiet: { type: "boolean", short: "q", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) return "help";
  const [input, ...rest] = positionals;
  if (!input) throw new Error("missing <url>");
  if (rest.length) throw new Error(`unexpected arguments: ${rest.join(" ")}`);
  const url = URL.parse(/^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? input : `https://${input}`);
  if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) throw new Error(`invalid URL: ${input}`);
  return {
    verbose: values.verbose,
    quiet: values.quiet,
    options: {
      url,
      outDir: values.out ?? "unbun",
      ...(values.adapter ? { adapter: values.adapter } : {}),
      sourceMaps: values.sourcemaps,
      rename: values.rename,
      webcrack: values.webcrack,
      format: values.format,
      concurrency: int("concurrency", values.concurrency, 6),
      workers: int("workers", values.workers, 0, 0),
      retries: int("retries", values.retries, 2, 0),
      timeoutMs: int("timeout", values.timeout, 30_000),
      maxBytes: int("max-bytes", values["max-bytes"], 50 * 1024 * 1024),
      maxPages: int("max-pages", values["max-pages"], 20),
      crawlDepth: int("depth", values.depth, 2, 0),
      includeExternal: values["include-external"],
      standalone: values.standalone,
    },
  };
}

async function main(): Promise<number> {
  let parsed: ReturnType<typeof parseCli>;
  try {
    parsed = parseCli(Bun.argv.slice(2));
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}\n\n${USAGE}`);
    return 2;
  }
  if (parsed === "help") {
    console.log(USAGE);
    return 0;
  }
  const log = createLogger(parsed.quiet ? "quiet" : parsed.verbose ? "verbose" : "normal");
  log.banner("unbundle", pkg.version, parsed.options.url.href);
  try {
    const { outDir, manifest } = await run(parsed.options, log);
    const s = manifest.summary;
    const coverage = manifest.coverage;
    const unloaded = coverage.unfetchedChunkIds.length + coverage.seenButNotLoaded.length + coverage.failedResources.length;
    log.summary("done", [
      ["bundler", manifest.bundler.adapter ?? "unknown"],
      ["pages", `${s.pages} (${s.requests} requests)`],
      ["code", `${s.scripts} scripts, ${s.chunks} chunks, ${s.modules} modules, ${s.styles} styles`],
      ["source maps", `${s.sourceMaps.maps} (${s.sourceMaps.sources} files)`],
      ["strings", `${s.strings} (${s.endpoints} endpoints)`],
      ["issues", s.errors || s.warnings ? `${count(s.errors, "error")}, ${count(s.warnings, "warning")} (.unbundle/manifest.json#errors, #warnings)` : "none"],
      [
        "coverage",
        coverage.status === "complete"
          ? "complete"
          : `possibly incomplete: ${coverage.unresolvedLoaders.length} unknown loaders, ${coverage.missingModules.length} missing modules, ${unloaded} unloaded (.unbundle/manifest.json#coverage)`,
      ],
      ["time", `${(s.durationMs / 1000).toFixed(1)}s`],
      ["output", outDir],
    ]);
    return 0;
  } catch (err) {
    log.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

if (import.meta.main) process.exit(await main());
