import type { HTMLElement, Node } from "node-html-parser";
import type { VirtualNode } from "../types.ts";

type Boundary = Extract<VirtualNode, { type: "boundary" }>;
type Owner = "server" | "client";

export interface Alignment {
  annotated: Array<{ boundary: Boundary; nodes: HTMLElement[] }>;
  skipped: Array<{ component: string; reason: string }>;
}

const NOT_RENDERED = new Set(["script", "template", "style", "link", "noscript", "meta", "title", "base"]);
const OPENING = new Set(["$", "$?", "$!", "$~"]);

function isElement(node: Node | undefined): node is HTMLElement {
  return !!node && node.nodeType === 1;
}

function tagOf(element: HTMLElement): string {
  return (element.rawTagName ?? "").toLowerCase();
}

function commentData(node: Node | undefined): string | null {
  return node && node.nodeType === 8 ? node.rawText : null;
}

function normalizeClass(value: unknown): string | null {
  return typeof value === "string" ? value.trim().split(/\s+/).filter(Boolean).join(" ") : null;
}

function matchesHost(element: HTMLElement, node: Extract<VirtualNode, { type: "host" }>): boolean {
  if (tagOf(element) !== node.tag.toLowerCase()) return false;
  const expectedClass = normalizeClass(node.props.className);
  if (expectedClass !== null && normalizeClass(element.getAttribute("class") ?? "") !== expectedClass) return false;
  if (typeof node.props.id === "string" && element.getAttribute("id") !== node.props.id) return false;
  return true;
}

function flatten(nodes: VirtualNode[]): VirtualNode[] {
  const out: VirtualNode[] = [];
  for (const node of nodes) {
    if (node.type === "fragment") out.push(...flatten(node.children));
    else if (node.type !== "text") out.push(node);
  }
  return out;
}

function findHost(dom: Node[], from: number, to: number, node: Extract<VirtualNode, { type: "host" }>): number {
  for (let i = from; i < to; i++) {
    const candidate = dom[i];
    if (isElement(candidate) && matchesHost(candidate, node)) return i;
  }
  return -1;
}

function findOpening(dom: Node[], from: number, to: number): number {
  for (let i = from; i < to; i++) if (OPENING.has(commentData(dom[i]) ?? "")) return i;
  return -1;
}

function findClosing(dom: Node[], open: number, to: number): number {
  let depth = 0;
  for (let i = open + 1; i < to; i++) {
    const data = commentData(dom[i]);
    if (data === null) continue;
    if (OPENING.has(data)) depth++;
    else if (data === "/$") {
      if (depth === 0) return i;
      depth--;
    }
  }
  return to;
}

function renderedElements(dom: Node[], from: number, to: number): HTMLElement[] {
  return dom.slice(from, to).filter((n): n is HTMLElement => isElement(n) && !NOT_RENDERED.has(tagOf(n)));
}

function descendantsInOrder(roots: HTMLElement[]): HTMLElement[] {
  const out: HTMLElement[] = [];
  const walk = (element: HTMLElement) => {
    out.push(element);
    for (const child of element.childNodes) if (isElement(child)) walk(child);
  };
  roots.forEach(walk);
  return out;
}

export class Aligner {
  readonly result: Alignment = { annotated: [], skipped: [] };

  align(nodes: VirtualNode[], dom: Node[], from: number, to: number, owner: Owner): number {
    const items = flatten(nodes);
    let cursor = from;
    for (let k = 0; k < items.length; k++) {
      const item = items[k]!;
      if (item.type === "host") {
        const index = findHost(dom, cursor, to, item);
        if (index < 0) continue;
        const element = dom[index] as HTMLElement;
        this.align(item.children, element.childNodes, 0, element.childNodes.length, "server");
        cursor = index + 1;
      } else if (item.type === "suspense") {
        const open = findOpening(dom, cursor, to);
        if (open < 0) {
          cursor = this.align(item.children, dom, cursor, to, owner);
          continue;
        }
        const close = findClosing(dom, open, to);
        this.align(item.children, dom, open + 1, close, owner);
        cursor = Math.min(close + 1, to);
      } else if (item.type === "boundary") {
        let end = k + 1;
        while (end < items.length && items[end]!.type === "boundary") end++;
        if (end - k > 1) {
          const last = items[end - 1] as Boundary;
          const lead = flatten(last.children)[0];
          const anchorIndex = lead?.type === "host" ? findHost(dom, cursor, to, lead) : -1;
          if (anchorIndex >= 0) {
            const before = items.slice(k, end - 1) as Boundary[];
            if (before.length === 1) this.boundaryRange(before[0]!, dom, cursor, anchorIndex, false, owner);
            else for (const run of before) this.result.skipped.push({ component: run.name, reason: "rendered next to other client components with no server-rendered separator to split their DOM" });
            const next = this.nextAnchor(items, end, dom, anchorIndex, to);
            this.result.skipped.push({ component: last.name, reason: "renders only the server content passed to it (a provider): no markup of its own to mark" });
            this.align(last.children, dom, anchorIndex, next.index, owner);
            cursor = next.index;
            k = end - 1;
            continue;
          }
          const next = this.nextAnchor(items, end, dom, cursor, to);
          const rendered = renderedElements(dom, cursor, next.index).length;
          for (const run of items.slice(k, end) as Boundary[]) {
            this.result.skipped.push({
              component: run.name,
              reason: rendered ? "rendered next to other client components with no server-rendered separator to split their DOM" : "renders no host element (null or empty fragment)",
            });
          }
          cursor = next.index;
          k = end - 1;
          continue;
        }
        cursor = this.boundary(item, items, k, dom, cursor, to, owner);
      }
    }
    return cursor;
  }

  private nextAnchor(items: VirtualNode[], after: number, dom: Node[], from: number, to: number): { index: number } {
    for (let k = after; k < items.length; k++) {
      const item = items[k]!;
      if (item.type === "boundary") continue;
      if (item.type === "host") {
        const index = findHost(dom, from, to, item);
        if (index >= 0) return { index };
      }
      if (item.type === "suspense") {
        const index = findOpening(dom, from, to);
        if (index >= 0) return { index };
      }
    }
    return { index: to };
  }

  private boundary(item: Boundary, items: VirtualNode[], k: number, dom: Node[], from: number, to: number, owner: Owner): number {
    const next = this.nextAnchor(items, k + 1, dom, from, to);
    this.boundaryRange(item, dom, from, next.index, next.index === to, owner);
    return next.index;
  }

  private boundaryRange(item: Boundary, dom: Node[], from: number, end: number, trailing: boolean, owner: Owner): void {
    const span = renderedElements(dom, from, end);
    if (!span.length) {
      this.result.skipped.push({ component: item.name, reason: "renders no host element (null or empty fragment)" });
      return;
    }
    if (trailing && owner === "client" && span.length > 1) {
      this.result.skipped.push({ component: item.name, reason: "last child inside another client component with several elements: its end cannot be told apart from the parent's own markup" });
      return;
    }
    this.result.annotated.push({ boundary: item, nodes: span });
    this.alignInside(item, span);
  }

  private alignInside(item: Boundary, span: HTMLElement[]): void {
    const children = flatten(item.children);
    const anchorIndex = children.findIndex((c) => c.type === "host");
    if (anchorIndex < 0) {
      for (const child of children) if (child.type === "boundary") this.result.skipped.push({ component: child.name, reason: "nested without a server-rendered anchor to locate it" });
      return;
    }
    const anchor = children[anchorIndex] as Extract<VirtualNode, { type: "host" }>;
    const element = descendantsInOrder(span).find((candidate) => matchesHost(candidate, anchor));
    if (!element?.parentNode) return;
    for (const child of children.slice(0, anchorIndex)) {
      if (child.type === "boundary") this.result.skipped.push({ component: child.name, reason: "precedes the first server-rendered child inside a client component" });
    }
    const level = element.parentNode.childNodes;
    this.align(children.slice(anchorIndex), level, level.indexOf(element), level.length, "client");
  }
}

export function applyAnnotations(alignment: Alignment): Array<{ component: string; src: string | null; nodes: number }> {
  const summary: Array<{ component: string; src: string | null; nodes: number }> = [];
  for (const { boundary, nodes } of alignment.annotated) {
    for (const node of nodes) {
      const names = [node.getAttribute("data-component"), boundary.name].filter(Boolean).join(" ");
      node.setAttribute("data-component", names);
      if (boundary.src) {
        const sources = [node.getAttribute("data-component-src"), boundary.src].filter(Boolean).join(" ");
        node.setAttribute("data-component-src", sources);
      }
    }
    summary.push({ component: boundary.name, src: boundary.src, nodes: nodes.length });
  }
  return summary;
}
