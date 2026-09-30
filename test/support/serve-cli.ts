import { resolve } from "node:path";
import { startFixtureServer } from "./server.ts";

const [fixture = "site-webpack", mount = "", maps = "maps"] = Bun.argv.slice(2);
const server = startFixtureServer({ root: resolve(import.meta.dir, "../fixtures", fixture), mount, serveMaps: maps !== "nomaps" });
console.log(server.url);
