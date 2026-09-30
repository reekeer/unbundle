import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const FIXTURES = resolve(import.meta.dir, "../test/fixtures");
const APPS = join(FIXTURES, "apps");

const available = readdirSync(APPS).filter((file) => file.endsWith(".tar.gz")).map((file) => file.replace(/\.tar\.gz$/, ""));
const wanted = process.argv.slice(2);
const unknown = wanted.filter((name) => !available.includes(name));
if (unknown.length) {
  console.error(`unknown fixture app: ${unknown.join(", ")} (available: ${available.join(", ")})`);
  process.exit(2);
}

for (const app of wanted.length ? wanted : available) {
  const work = mkdtempSync(join(tmpdir(), `unbundle-${app}-`));
  try {
    const extracted = Bun.spawnSync(["tar", "-xzf", join(APPS, `${app}.tar.gz`), "-C", work], { stderr: "inherit" });
    if (extracted.exitCode !== 0) throw new Error(`cannot extract ${app}`);
    const script = join(work, "build.sh");
    if (!existsSync(script)) throw new Error(`${app} has no build.sh`);
    console.log(`building ${app}`);
    const built = Bun.spawnSync(["bash", script], { cwd: work, stdout: "inherit", stderr: "inherit", env: { ...process.env, UNBUNDLE_FIXTURES: FIXTURES } });
    if (built.exitCode !== 0) throw new Error(`${app}: build.sh failed`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
