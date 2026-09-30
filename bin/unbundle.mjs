#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

function bunBinary() {
  if (process.versions.bun) return process.execPath;
  try {
    return createRequire(import.meta.url).resolve("bun/bin/bun.exe");
  } catch {
    return "bun";
  }
}

const result = spawnSync(bunBinary(), [cli, ...process.argv.slice(2)], { stdio: "inherit" });
if (result.error) {
  console.error("unbundle runs on Bun, and no Bun binary was found. Install it from https://bun.sh or run `bunx @reekeer/unbundle`.");
  process.exit(1);
}
process.exit(result.status ?? 1);
