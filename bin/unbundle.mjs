#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const shell = process.platform === "win32";

function bun() {
  if (process.versions.bun) return [process.execPath];
  const system = spawnSync("bun", ["--version"], { stdio: "ignore", shell });
  if (!system.error && system.status === 0) return ["bun"];
  const version = /^bun@(.+)$/.exec(createRequire(import.meta.url)("../package.json").packageManager ?? "")?.[1] ?? "latest";
  return ["npx", "--yes", `bun@${version}`];
}

const [command, ...prefix] = bun();
const result = spawnSync(command, [...prefix, cli, ...process.argv.slice(2)], { stdio: "inherit", shell });
if (result.error) {
  console.error("unbundle runs on Bun and could not start it. Install Bun from https://bun.sh or run `bunx @reekeer/unbundle`.");
  process.exit(1);
}
process.exit(result.status ?? 1);
