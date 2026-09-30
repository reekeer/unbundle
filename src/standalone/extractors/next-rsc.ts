import { parse, type HTMLElement, type Node } from "node-html-parser";
import type { ExtractContext, Page, TreeExtractor, VirtualNode } from "../../types.ts";

type Row = { tag: string; value: unknown };
type ClientRef = { moduleId: string; chunks: unknown[]; exportName: string };
type Seed = [unknown, Record<string, unknown>?, ...unknown[]];

const PUSH = /self\.__next_f\.push\(\[\s*1\s*,\s*("(?:[^"\\]|\\.)*")\s*\]\)/g;
const INFRASTRUCTURE = new Set(["OutletBoundary", "ViewportBoundary", "MetadataBoundary", "AsyncMetadataOutlet", "ClientPageRoot", "ClientSegmentRoot"]);
const INFRASTRUCTURE_PROPS = ["parallelRouterKey", "errorComponent", "notFound", "forbidden", "unauthorized", "errorStyles"];
const TRANSPARENT_SYMBOLS = new Set(["react.fragment", "react.strict_mode", "react.profiler", "react.activity", "react.view_transition", "react.context", "react.consumer", "react.provider"]);

export function flightText(html: string): string {
  let text = "";
  for (const match of html.matchAll(PUSH)) {
    try {
      text += JSON.parse(match[1]!) as string;
    } catch {
      continue;
    }
  }
  return text;
}

export function parseRows(text: string): Map<string, Row> {
  const rows = new Map<string, Row>();
  const bytes = new TextEncoder().encode(text);
  const decoder = new TextDecoder();
  let pos = 0;
  const readUntil = (char: number) => {
    const start = pos;
    while (pos < bytes.length && bytes[pos] !== char) pos++;
    return decoder.decode(bytes.subarray(start, pos));
  };
  while (pos < bytes.length) {
    const id = readUntil(0x3a);
    pos++;
    let tag = "";
    while (pos < bytes.length && bytes[pos]! >= 0x41 && bytes[pos]! <= 0x5a) tag += String.fromCharCode(bytes[pos++]!);
    if (tag === "T") {
      const length = Number.parseInt(readUntil(0x2c), 16);
      pos++;
      rows.set(id, { tag, value: decoder.decode(bytes.subarray(pos, pos + length)) });
      pos += length;
      continue;
    }
    const line = readUntil(0x0a);
    pos++;
    if (!line) {
      rows.set(id, { tag, value: null });
      continue;
    }
    try {
      rows.set(id, { tag, value: JSON.parse(line) });
    } catch {
      rows.set(id, { tag, value: null });
    }
  }
  return rows;
}

class FlightTree {
  private readonly parallel: Array<Record<string, unknown>> = [];

  constructor(
    private readonly rows: Map<string, Row>,
    private readonly ctx: ExtractContext,
  ) {}

  private row(id: string): Row | undefined {
    return this.rows.get(id);
  }

  private navigate(value: unknown, path: string[]): unknown {
    let current = value;
    for (const key of path) {
      if (Array.isArray(current) && current[0] === "$" && ["type", "key", "props"].includes(key)) {
        current = current[{ type: 1, key: 2, props: 3 }[key as "type" | "key" | "props"]];
      } else if (current && typeof current === "object") {
        current = (current as Record<string, unknown>)[key];
      } else return undefined;
      current = this.reference(current);
    }
    return current;
  }

  reference(value: unknown, depth = 0): unknown {
    if (typeof value !== "string" || !value.startsWith("$") || depth > 20) return value;
    if (value.startsWith("$$")) return value.slice(1);
    if (value === "$undefined") return undefined;
    if (value.startsWith("$S")) return { symbol: value.slice(2) };
    const match = /^\$[L@]?([0-9a-f]+)((?::[^:]+)*)$/.exec(value);
    if (!match) return undefined;
    const row = this.row(match[1]!);
    if (!row) return undefined;
    if (row.tag === "I" && Array.isArray(row.value)) {
      const [moduleId, chunks, exportName] = row.value as [unknown, unknown[], unknown];
      return { client: { moduleId: String(moduleId), chunks: chunks ?? [], exportName: typeof exportName === "string" ? exportName : "" } satisfies ClientRef };
    }
    const path = match[2] ? match[2].slice(1).split(":") : [];
    return this.navigate(this.reference(row.value, depth + 1), path);
  }

  renderSeed(seed: unknown): VirtualNode[] {
    if (!Array.isArray(seed)) return [];
    const [rsc, parallel] = seed as Seed;
    this.parallel.push(parallel && typeof parallel === "object" ? parallel : {});
    const nodes = this.nodes(rsc);
    this.parallel.pop();
    return nodes;
  }

  nodes(input: unknown): VirtualNode[] {
    const value = this.reference(input);
    if (value === null || value === undefined || typeof value === "boolean") return [];
    if (typeof value === "string" || typeof value === "number") return [{ type: "text", value: String(value) }];
    if (Array.isArray(value)) {
      if (value[0] === "$" && value.length >= 4) return this.element(value[1], (value[3] ?? {}) as Record<string, unknown>);
      return value.flatMap((item) => this.nodes(item));
    }
    return [];
  }

  private renderableProps(props: Record<string, unknown>): VirtualNode[] {
    const out: VirtualNode[] = [];
    for (const [key, raw] of Object.entries(props)) {
      if (key === "children" || isElementLike(this.reference(raw))) out.push(...this.nodes(raw));
    }
    return out;
  }

  private element(rawType: unknown, props: Record<string, unknown>): VirtualNode[] {
    const type = this.reference(rawType);
    if (typeof type === "string") {
      const { children, dangerouslySetInnerHTML: _, ...rest } = props;
      return [{ type: "host", tag: type, props: rest, children: this.nodes(children) }];
    }
    if (type && typeof type === "object" && "symbol" in type) {
      const symbol = (type as { symbol: string }).symbol;
      if (symbol === "react.suspense") return [{ type: "suspense", children: this.nodes(props.children) }];
      if (TRANSPARENT_SYMBOLS.has(symbol)) return [{ type: "fragment", children: this.nodes(props.children) }];
      return [{ type: "fragment", children: this.nodes(props.children) }];
    }
    if (type && typeof type === "object" && "client" in type) return this.client((type as { client: ClientRef }).client, props);
    return [{ type: "fragment", children: this.nodes(props.children) }];
  }

  private client(ref: ClientRef, props: Record<string, unknown>): VirtualNode[] {
    if (typeof props.parallelRouterKey === "string") {
      const seed = this.parallel.at(-1)?.[props.parallelRouterKey];
      return [{ type: "fragment", children: this.renderSeed(seed) }];
    }
    if (ref.exportName === "ClientPageRoot" || ref.exportName === "ClientSegmentRoot") {
      const component = this.reference(props.Component);
      if (component && typeof component === "object" && "client" in component) return this.client((component as { client: ClientRef }).client, {});
      return [];
    }
    const infrastructure = INFRASTRUCTURE.has(ref.exportName) || INFRASTRUCTURE_PROPS.some((key) => key in props) || ref.chunks.length === 0;
    if (infrastructure) return [{ type: "fragment", children: this.renderableProps(props) }];
    const resolved = this.ctx.resolveComponent(ref.moduleId, ref.exportName);
    return [{ type: "boundary", name: resolved.name, src: resolved.src, moduleId: ref.moduleId, children: this.renderableProps(props) }];
  }
}

function isElementLike(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  if (value[0] === "$" && value.length >= 4) return true;
  return value.some((item) => Array.isArray(item) && item[0] === "$" && item.length >= 4);
}

function seedOf(root: unknown): unknown {
  const flight = (root as { f?: unknown[] } | null)?.f;
  const path = Array.isArray(flight) ? flight[0] : null;
  if (!Array.isArray(path) || path.length < 3) return null;
  return path[path.length - 3];
}

function isComment(node: Node | null | undefined, data?: RegExp): boolean {
  return !!node && node.nodeType === 8 && (!data || data.test(node.rawText));
}

function reconcileBoundary(template: HTMLElement, content: HTMLElement): void {
  const parent = template.parentNode;
  if (!parent) return;
  const siblings = parent.childNodes;
  const start = siblings.indexOf(template);
  const opening = siblings[start - 1];
  let depth = 0;
  let end = start;
  for (; end < siblings.length; end++) {
    const node = siblings[end]!;
    if (!isComment(node)) continue;
    const data = node.rawText;
    if (data === "/$" || data === "/&") {
      if (depth === 0) break;
      depth--;
    } else if (["$", "$?", "$~", "$!", "&"].includes(data)) depth++;
  }
  const replacement = content.childNodes.map((child) => {
    child.parentNode = parent;
    return child;
  });
  siblings.splice(start, end - start, ...replacement);
  if (opening && isComment(opening)) (opening as unknown as { rawText: string }).rawText = "$";
  content.remove();
}

export function reconcileStreaming(html: string): string {
  const root = parse(html, { comment: true, blockTextElements: { script: true, style: true, noscript: true } });
  const calls = [...html.matchAll(/\$RC\(\s*"([^"]+)"\s*,\s*"([^"]+)"\s*\)/g), ...html.matchAll(/\$RS\(\s*"([^"]+)"\s*,\s*"([^"]+)"\s*\)/g)];
  for (const call of calls) {
    const isSegment = call[0].startsWith("$RS");
    const [placeholderId, contentId] = isSegment ? [call[2]!, call[1]!] : [call[1]!, call[2]!];
    const placeholder = root.getElementById(placeholderId);
    const content = root.getElementById(contentId);
    if (!placeholder || !content) continue;
    if (isSegment) {
      const parent = placeholder.parentNode;
      if (!parent) continue;
      const index = parent.childNodes.indexOf(placeholder);
      parent.childNodes.splice(index, 1, ...content.childNodes.map((child) => ((child.parentNode = parent), child)));
      content.remove();
    } else reconcileBoundary(placeholder, content);
  }
  return root.toString();
}

const extractor: TreeExtractor = {
  name: "next-rsc",
  applies(page, bundler) {
    if (bundler !== "next") return { applicable: false, reason: `no Flight payload: page was built with ${bundler ?? "an unknown bundler"}, not Next.js` };
    if (/id=["']__NEXT_DATA__["']/.test(page.html)) return { applicable: false, reason: "Pages Router page: no React Server Components Flight payload" };
    const rows = parseRows(flightText(page.html));
    if (!seedOf(rows.get("0")?.value)) return { applicable: false, reason: "no App Router Flight payload with a rendered tree in the page" };
    if (!/<body[^>]*>[\s\S]*?<\/body>/i.test(page.html) || !/<body[^>]*>\s*(<[a-z])/i.test(page.html)) {
      return { applicable: false, reason: "empty HTML shell: nothing server-rendered to align against" };
    }
    return { applicable: true };
  },
  extract(page, ctx) {
    const rows = parseRows(flightText(page.html));
    const tree = new FlightTree(rows, ctx);
    return tree.renderSeed(seedOf(rows.get("0")?.value));
  },
  prepareDom: reconcileStreaming,
};

export default extractor;
