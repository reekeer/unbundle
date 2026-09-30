import { join, normalize } from "node:path";

export interface FixtureServerOptions {
  root: string;
  mount?: string;
  serveMaps?: boolean;
  fail?: (pathname: string) => number | null;
}

export interface FixtureServer {
  url: string;
  requests: string[];
  stop(): void;
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript",
  ".css": "text/css",
  ".map": "application/json",
  ".txt": "text/plain",
  ".json": "application/json",
};

async function resolveFile(root: string, rel: string): Promise<string | null> {
  const clean = normalize(`/${decodeURIComponent(rel)}`).replace(/^\/+/, "");
  const base = join(root, clean);
  if (!base.startsWith(root)) return null;
  const trimmed = base.replace(/\/+$/, "");
  for (const candidate of [base, `${trimmed}.html`, join(trimmed, "index.html")]) {
    const file = Bun.file(candidate);
    if ((await file.exists()) && !candidate.endsWith("/")) {
      try {
        await file.arrayBuffer();
        return candidate;
      } catch {
        continue;
      }
    }
  }
  return null;
}

export function startFixtureServer(options: FixtureServerOptions): FixtureServer {
  const mount = (options.mount ?? "").replace(/\/+$/, "");
  const requests: string[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const { pathname } = new URL(req.url);
      requests.push(pathname);
      const forced = options.fail?.(pathname);
      if (forced) return new Response("forced failure", { status: forced });
      if (mount && pathname !== mount && !pathname.startsWith(`${mount}/`)) return new Response("not found", { status: 404 });
      if (options.serveMaps === false && pathname.endsWith(".map")) return new Response("not found", { status: 404 });
      const file = await resolveFile(options.root, pathname.slice(mount.length) || "/");
      if (!file) return new Response("not found", { status: 404 });
      const ext = file.slice(file.lastIndexOf("."));
      return new Response(Bun.file(file), { headers: { "content-type": TYPES[ext] ?? "application/octet-stream" } });
    },
  });
  return { url: `http://127.0.0.1:${server.port}${mount}`, requests, stop: () => server.stop(true) };
}
