import { spawnSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { Preview } from "../types.ts";

interface Route {
  path: string;
  type: string;
}

interface ViteMiddleware {
  middlewares: {
    use(handler: (req: IncomingMessage, res: ServerResponse, next: () => void) => void): void;
  };
}

interface ViteModule {
  createServer(options: {
    root: string;
    plugins: Array<{ name: string; configureServer(server: ViteMiddleware): void }>;
    server: { host: string; port: number; strictPort: boolean };
  }): Promise<{ listen(): Promise<unknown>; printUrls(): void; close(): Promise<void> }>;
}

const root = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
const preview: Preview = JSON.parse(await readFile(resolve(root, ".unbundle/preview.json"), "utf8"));
const routes = new Map<string, Route>(preview.routes.map(([url, path, type]) => [url, { path, type }]));
const host = "127.0.0.1";
const port = Number(process.env.PORT ?? "4173");
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("PORT must be a valid port number");

async function startVite() {
  const vitePackage = "vite";
  let vite: ViteModule;
  try {
    vite = await import(vitePackage);
  } catch (err) {
    if (!(err instanceof Error) || !("code" in err) || err.code !== "ERR_MODULE_NOT_FOUND" || !err.message.includes("Cannot find package 'vite'")) throw err;
    const cli = process.env.npm_execpath;
    const npm = cli ? process.execPath : process.platform === "win32" ? "npm.cmd" : "npm";
    const args = [...(cli ? [cli] : []), "install", "--ignore-scripts", "--no-audit", "--no-fund"];
    const installed = spawnSync(npm, args, { cwd: root, stdio: "inherit", shell: !cli && process.platform === "win32" });
    if (installed.error || installed.status !== 0) throw installed.error ?? new Error(`npm install exited with ${installed.status}`);
    vite = await import(vitePackage);
  }
  const snapshotAssets = {
    name: "unbundle-snapshot-assets",
    configureServer(server: ViteMiddleware) {
      server.middlewares.use((req, res, next) => {
        const url = parseUrl(req);
        const target = url && (routes.get(url.pathname + url.search) ?? routes.get(url.pathname));
        if (target && !/^text\/html/i.test(target.type) && !/javascript/i.test(target.type) && !url.pathname.startsWith("/src/")) {
          void send(target, req, res, next);
        } else next();
      });
    },
  };
  const server = await vite.createServer({ root, plugins: [snapshotAssets], server: { host, port, strictPort: true } });
  try {
    await server.listen();
  } catch (err) {
    await server.close();
    throw err;
  }
  server.printUrls();
  console.log("Edit src/ to change this preview.");
}

function parseUrl(req: IncomingMessage) {
  if (req.method !== "GET" && req.method !== "HEAD") return null;
  if (!/^(?:localhost|127\.0\.0\.1)(?::\d+)?$/.test(req.headers.host ?? "")) return null;
  if (!req.url?.startsWith("/") || req.url.startsWith("//")) return null;
  try {
    return new URL(req.url, `http://${host}`);
  } catch {
    return null;
  }
}

async function send(target: Route, req: IncomingMessage, res: ServerResponse, missing: () => void) {
  let path;
  let size;
  try {
    path = await realpath(resolve(root, target.path));
    if (!path.startsWith(root + sep)) return missing();
    const info = await stat(path);
    if (!info.isFile()) return missing();
    size = info.size;
  } catch {
    return missing();
  }
  res.writeHead(200, { "Content-Type": target.type, "Content-Length": size, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  if (req.method === "HEAD") return res.end();
  const stream = createReadStream(path);
  stream.on("error", () => res.destroy());
  res.on("close", () => stream.destroy());
  stream.pipe(res);
}

function startStatic() {
  const server = createServer((req, res) => {
    const url = parseUrl(req);
    if (!url) {
      res.writeHead(400).end();
      return;
    }
    const missing = () => res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("This resource was not captured.\n");
    const pathname = url.pathname;
    if (pathname === "/" && !routes.has("/") && preview.entry !== "/") {
      res.writeHead(302, { Location: preview.entry }).end();
      return;
    }
    const fallback = preview.spa && req.headers.accept?.includes("text/html") ? routes.get(preview.entry) : null;
    const target = routes.get(pathname + url.search) ?? routes.get(pathname) ?? routes.get(pathname.endsWith("/") ? pathname.slice(0, -1) : pathname + "/") ?? fallback;
    if (target) void send(target, req, res, missing);
    else missing();
  });
  server.on("error", (err) => {
    console.error(`Could not start the snapshot on ${host}:${port}: ${err.message}`);
    process.exitCode = 1;
  });
  server.listen(port, host, () => {
    const address = server.address();
    if (!address || typeof address === "string") return;
    console.log(`Preview: http://${host}:${address.port}${preview.entry}`);
    const editable = preview.editable.startsWith("src/") && preview.mode === "static" ? `preview/ or ${preview.editable}` : "preview/";
    console.log(`Edit ${editable} and reload to see changes.`);
  });
}

if (preview.mode === "vite" && !process.argv.includes("--snapshot")) {
  try {
    await startVite();
  } catch (err) {
    console.warn(`Could not start Vite: ${err instanceof Error ? err.message : String(err)}\nStarting the editable snapshot.`);
    startStatic();
  }
} else startStatic();
