import { readdirSync } from "node:fs";

/** Directory listing in a fixed order (case-insensitive, then by code unit), whatever the file system. */
export function listDir(dir: string): string[] {
  return readdirSync(dir).sort((a, b) => {
    const x = a.toLowerCase();
    const y = b.toLowerCase();
    return x < y ? -1 : x > y ? 1 : a < b ? -1 : a > b ? 1 : 0;
  });
}
