import { availableParallelism } from "node:os";
import { renameIdentifiers } from "./rename.ts";

export interface RefineJob {
  id: number;
  code: string;
  webcrack: boolean;
  rename: boolean;
}

export interface RefineResult {
  id: number;
  code: string;
  renamed: number;
  warnings: Array<{ stage: string; message: string }>;
}

let webcrackModule: Promise<typeof import("webcrack")> | null = null;

export async function refineCode(job: RefineJob): Promise<RefineResult> {
  const result: RefineResult = { id: job.id, code: job.code, renamed: 0, warnings: [] };
  if (job.webcrack) {
    try {
      const { webcrack } = await (webcrackModule ??= import("webcrack"));
      result.code = (await webcrack(result.code, { unpack: false, deobfuscate: false, unminify: true, jsx: true, mangle: false })).code;
    } catch (err) {
      result.warnings.push({ stage: "webcrack", message: err instanceof Error ? err.message : String(err) });
    }
  }
  if (job.rename) {
    try {
      const renamed = renameIdentifiers(result.code);
      result.code = renamed.code;
      result.renamed = renamed.renamed;
      if (renamed.violations?.length) result.warnings.push({ stage: "rename", message: `reverted: ${renamed.violations.slice(0, 3).join("; ")}` });
    } catch (err) {
      result.warnings.push({ stage: "rename", message: err instanceof Error ? err.message : String(err) });
    }
  }
  return result;
}

const POOL_MIN_BYTES = 4 * 1024 * 1024;
const POOL_MIN_JOBS = 200;

export function autoWorkers(jobs: RefineJob[]): number {
  const bytes = jobs.reduce((n, j) => n + j.code.length, 0);
  if (bytes < POOL_MIN_BYTES || jobs.length < POOL_MIN_JOBS) return 1;
  return Math.max(1, Math.min(8, availableParallelism() - 1));
}

const JOB_TIMEOUT_MS = 120_000;

export async function refineAll(
  jobs: RefineJob[],
  workers: number,
  onProgress: (done: number) => void,
  timeoutMs = JOB_TIMEOUT_MS,
): Promise<RefineResult[]> {
  const size = Math.min(workers, jobs.length);
  const results: RefineResult[] = new Array(jobs.length);
  let done = 0;
  const finish = (result: RefineResult) => {
    results[result.id] = result;
    onProgress(++done);
  };
  if (size <= 1) {
    for (const job of jobs) finish(await refineCode(job));
    return results;
  }

  const queue = [...jobs].sort((a, b) => b.code.length - a.code.length);
  let next = 0;
  const spawn = () => new Worker(new URL(import.meta.url).href);

  const lane = async (): Promise<void> => {
    let worker = spawn();
    try {
      while (next < queue.length) {
        const job = queue[next++]!;
        const outcome = await new Promise<RefineResult | Error>((resolve) => {
          const timer = setTimeout(() => resolve(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
          worker.onmessage = (event: MessageEvent<RefineResult>) => {
            clearTimeout(timer);
            resolve(event.data);
          };
          worker.onerror = (event) => {
            clearTimeout(timer);
            resolve(new Error(event.message || "worker crashed"));
          };
          worker.postMessage(job);
        });
        if (outcome instanceof Error) {
          worker.terminate();
          worker = spawn();
          const fallback = await refineCode(job);
          fallback.warnings.push({ stage: "worker", message: `${outcome.message}; redone on the main thread` });
          finish(fallback);
        } else {
          finish(outcome);
        }
      }
    } finally {
      worker.terminate();
    }
  };
  await Promise.all(Array.from({ length: size }, lane));
  return results;
}

if (!Bun.isMainThread) {
  const scope = self as unknown as Worker;
  scope.onmessage = async (event: MessageEvent<RefineJob>) => {
    scope.postMessage(await refineCode(event.data));
  };
}
