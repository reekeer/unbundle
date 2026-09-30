import type { Issue } from "./types.ts";

type Level = "silent" | "quiet" | "normal" | "verbose";
type Kind = "start" | "info" | "success" | "warn" | "error" | "debug";

const MARKS: Record<Kind, string> = {
  start: "[ # ]",
  info: "[ - ]",
  success: "[ + ]",
  warn: "[ ! ]",
  error: "[ x ]",
  debug: "[ . ]",
};

const COLORS: Record<Kind, [number, number]> = {
  start: [36, 39],
  info: [2, 22],
  success: [32, 39],
  warn: [33, 39],
  error: [31, 39],
  debug: [2, 22],
};

function colorEnabled(): boolean {
  return !process.env.NO_COLOR && !!process.stderr.isTTY;
}

function paint(text: string, [open, close]: [number, number]): string {
  return colorEnabled() ? `\x1b[${open}m${text}\x1b[${close}m` : text;
}

export class Logger {
  constructor(
    readonly level: Level = "normal",
    private readonly tag = "",
  ) {}

  withTag(tag: string): Logger {
    return new Logger(this.level, tag);
  }

  start(message: string): void {
    if (this.level === "verbose") this.write("start", message);
  }

  info(message: string): void {
    this.write("info", message);
  }

  success(message: string): void {
    this.write("success", message);
  }

  warn(message: string): void {
    this.write("warn", message);
  }

  error(message: string): void {
    this.write("error", message);
  }

  debug(message: string): void {
    if (this.level === "verbose") this.write("debug", message);
  }

  banner(name: string, version: string, target?: string): void {
    if (this.level === "silent" || this.level === "quiet") return;
    const title = `${paint(name, [1, 22])} ${paint(`v${version}`, [2, 22])}`;
    process.stderr.write(`\n  ${title}${target ? `  ${paint("->", [2, 22])} ${target}` : ""}\n\n`);
  }

  summary(title: string, rows: Array<[string, string]>): void {
    if (this.level === "silent" || this.level === "quiet") return;
    const width = Math.max(...rows.map(([key]) => key.length));
    const lines = rows.map(([key, value]) => `      ${paint(key.padEnd(width), [2, 22])}  ${value}`);
    process.stderr.write(`\n${paint(MARKS.success, COLORS.success)} ${title}\n${lines.join("\n")}\n\n`);
  }

  private write(kind: Kind, message: string): void {
    if (this.level === "silent" || (this.level === "quiet" && kind !== "error")) return;
    const tag = this.tag ? `${paint(this.tag, [2, 22])} ` : "";
    const text = kind === "start" ? paint(message, [1, 22]) : kind === "info" || kind === "debug" ? paint(message, [2, 22]) : message;
    process.stderr.write(`${paint(MARKS[kind], COLORS[kind])} ${tag}${text}\n`);
  }
}

export function createLogger(level: Level = "normal"): Logger {
  return new Logger(level);
}

export class Report {
  readonly errors: Issue[] = [];
  readonly warnings: Issue[] = [];

  error(issue: Issue): void {
    this.errors.push(issue);
  }

  warn(issue: Issue): void {
    this.warnings.push(issue);
  }
}

export function count(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
