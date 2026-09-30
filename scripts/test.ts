import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { availableParallelism, homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const LOCAL = resolve(process.env.UNBUNDLE_TEST_DIR ?? join(homedir(), ".cache", "unbundle-test"));
const ROOT_FILES = ["package.json", "bun.lock", "tsconfig.json", "fingerprints.sigdb", "icons.sigdb"];
const TREES = ["src", "test/support", "test/fixtures/sites"];

function list(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? list(join(dir, entry.name)) : [join(dir, entry.name)]));
}

function copy(from: string, to: string): boolean {
  const source = statSync(from);
  if (existsSync(to)) {
    const target = statSync(to);
    if (target.size === source.size && Math.abs(target.mtimeMs - source.mtimeMs) < 1) return false;
  }
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
  utimesSync(to, source.atime, source.mtime);
  return true;
}

function mirror(): number {
  let copied = 0;
  const wanted = new Set<string>();
  const take = (file: string) => {
    const rel = relative(ROOT, file);
    wanted.add(rel);
    if (copy(file, join(LOCAL, rel))) copied++;
  };
  for (const file of ROOT_FILES) if (existsSync(join(ROOT, file))) take(join(ROOT, file));
  for (const tree of TREES) for (const file of list(join(ROOT, tree))) take(file);
  for (const entry of readdirSync(join(ROOT, "test"), { withFileTypes: true })) if (entry.isFile()) take(join(ROOT, "test", entry.name));
  for (const tree of [...TREES, "test"]) {
    for (const file of list(join(LOCAL, tree))) {
      const rel = relative(LOCAL, file);
      if (tree === "test" && dirname(rel) !== "test") continue;
      if (!wanted.has(rel)) rmSync(file);
    }
  }
  return copied;
}

function install(): void {
  const stamp = join(LOCAL, ".deps");
  const deps = ["package.json", "bun.lock"].map((file) => (existsSync(join(ROOT, file)) ? readFileSync(join(ROOT, file), "utf8") : "")).join("\n");
  if (existsSync(join(LOCAL, "node_modules")) && existsSync(stamp) && readFileSync(stamp, "utf8") === deps) return;
  const frozen = Bun.spawnSync(["bun", "install", "--frozen-lockfile", "--ignore-scripts"], { cwd: LOCAL, stdout: "inherit", stderr: "inherit" });
  if (frozen.exitCode !== 0 && Bun.spawnSync(["bun", "install", "--ignore-scripts"], { cwd: LOCAL, stdout: "inherit", stderr: "inherit" }).exitCode !== 0) process.exit(1);
  writeFileSync(stamp, deps);
}

const started = performance.now();
mkdirSync(LOCAL, { recursive: true });
const copied = mirror();
install();
const e2eOnly = process.argv.includes("--e2e");
const args = process.argv.slice(2).filter((arg) => arg !== "--e2e");
const files = args.some((arg) => !arg.startsWith("-")) ? [] : readdirSync(join(LOCAL, "test")).filter((file) => file.endsWith(".test.ts") && (e2eOnly ? file.startsWith("e2e-") : file !== "corpus.test.ts" || !!process.env.UNBUNDLE_CORPUS)).map((file) => `test/${file}`);
console.log(`tests run from ${LOCAL} (${copied} file(s) synced in ${Math.round(performance.now() - started)} ms)`);
const workers = Math.max(1, Math.min(files.length || 8, availableParallelism()));
const result = Bun.spawnSync(["bun", "test", `--parallel=${workers}`, ...args, ...files], { cwd: LOCAL, stdout: "inherit", stderr: "inherit", env: { ...process.env, UNBUNDLE_SOURCE_ROOT: ROOT } });
process.exit(result.exitCode ?? 1);
