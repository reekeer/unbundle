import { join } from "node:path";
import type { BundlerAdapter } from "../types.ts";

export function defineAdapter<T extends BundlerAdapter>(adapter: T): T {
  return adapter;
}

export const genericAdapter: BundlerAdapter = {
  name: "generic",
  detect: () => ({ score: 0, evidence: [] }),
  collectAssets: () => [],
  parseChunk: () => null,
};

function isAdapter(value: unknown): value is BundlerAdapter {
  const v = value as Partial<BundlerAdapter> | null;
  return !!v && typeof v.name === "string" && typeof v.detect === "function" && typeof v.collectAssets === "function" && typeof v.parseChunk === "function";
}

export async function loadAdapters(dir = import.meta.dir): Promise<BundlerAdapter[]> {
  const adapters: BundlerAdapter[] = [];
  for await (const file of new Bun.Glob("*.ts").scan({ cwd: dir, onlyFiles: true })) {
    if (file === "index.ts") continue;
    const mod = (await import(join(dir, file))) as { default?: unknown };
    if (!isAdapter(mod.default)) throw new Error(`adapter ${file} has no valid default export`);
    if (adapters.some((a) => a.name === (mod.default as BundlerAdapter).name)) throw new Error(`duplicate adapter name in ${file}`);
    adapters.push(mod.default);
  }
  return adapters.sort((a, b) => a.name.localeCompare(b.name));
}
