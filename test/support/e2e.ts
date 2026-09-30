import { afterAll } from "bun:test";
import { removeRuns, runOn } from "./run.ts";
import { startFixtureServer, type FixtureServer } from "./server.ts";
import { sitePath } from "./sites.ts";

export const BASE = "/t/tttt";
export const TIMEOUT = 240_000;

const servers: FixtureServer[] = [];

export function serve(fixture: string, options: { mount?: string; serveMaps?: boolean; fail?: (p: string) => number | null } = {}): FixtureServer {
  const server = startFixtureServer({ root: sitePath(fixture), ...options });
  servers.push(server);
  return server;
}

type ServeOptions = { mount?: string; serveMaps?: boolean };
type SiteRun = Awaited<ReturnType<typeof runOn>> & { url: string };
const runs = new Map<string, Promise<SiteRun>>();

export function runSite(fixture: string, serveOptions: ServeOptions, options: Parameters<typeof runOn>[1] = {}): Promise<SiteRun> {
  const key = JSON.stringify([fixture, serveOptions, options]);
  let run = runs.get(key);
  if (!run) {
    const url = serve(fixture, serveOptions).url;
    runs.set(key, (run = runOn(url, options).then((result) => ({ ...result, url }))));
  }
  return run;
}

export function serveDirectory(root: string): FixtureServer {
  const server = startFixtureServer({ root });
  servers.push(server);
  return server;
}

export function identified(manifest: Awaited<ReturnType<typeof runOn>>["manifest"]): Set<string> {
  return new Set(manifest.modules.flatMap((m) => (m.identifiedAs ? [m.identifiedAs.package] : [])));
}

afterAll(async () => {
  servers.forEach((s) => s.stop());
  await removeRuns();
});
