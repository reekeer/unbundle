import { existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ARCHIVES = resolve(import.meta.dir, "../fixtures/sites");
const EXTRACTED = resolve(import.meta.dir, "../../.cache/sites");

function fresh(target: string, archive: string): boolean {
  const stamp = join(target, ".extracted");
  return existsSync(stamp) && statSync(stamp).mtimeMs >= statSync(archive).mtimeMs;
}

export function sitePath(name: string): string {
  const archive = join(ARCHIVES, `${name}.tar.gz`);
  if (!existsSync(archive)) throw new Error(`fixture site ${name} is missing: build it with "bun run fixtures"`);
  const target = join(EXTRACTED, name);
  if (fresh(target, archive)) return target;
  const staging = `${target}.${process.pid}.tmp`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  const result = Bun.spawnSync(["tar", "-xzf", archive, "-C", staging]);
  if (result.exitCode !== 0) throw new Error(`cannot extract ${archive}: ${result.stderr.toString()}`);
  writeFileSync(join(staging, ".extracted"), "");
  if (fresh(target, archive)) {
    rmSync(staging, { recursive: true, force: true });
    return target;
  }
  rmSync(target, { recursive: true, force: true });
  try {
    renameSync(staging, target);
  } catch {
    rmSync(staging, { recursive: true, force: true });
    if (!fresh(target, archive)) throw new Error(`cannot extract ${archive} into ${target}`);
  }
  return target;
}
