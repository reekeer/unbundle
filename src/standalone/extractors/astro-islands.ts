import type { HTMLElement } from "node-html-parser";
import { chunkStem } from "../../unpack/wrappers.ts";
import type { TreeExtractor } from "../../types.ts";

const extractor: TreeExtractor = {
  name: "astro-islands",
  applies(page) {
    return page.html.includes("<astro-island") ? { applicable: true } : { applicable: false, reason: "no <astro-island> on the page" };
  },
  extract: () => [],
  annotate(root, page, ctx) {
    const out: Array<{ component: string; src: string | null; nodes: number }> = [];
    for (const island of root.querySelectorAll("astro-island")) {
      let name: string | null = null;
      try {
        name = (JSON.parse(island.getAttribute("opts") ?? "{}") as { name?: string }).name ?? null;
      } catch {
        name = null;
      }
      const url = island.getAttribute("component-url");
      const resolved = url ? ctx.resolveComponent(chunkStem(new URL(url, page.url).href), island.getAttribute("component-export") ?? "default") : null;
      const component = name ?? resolved?.name ?? "Island";
      const targets = island.childNodes.filter((c): c is HTMLElement => c.nodeType === 1 && (c as HTMLElement).rawTagName?.toLowerCase() !== "template");
      const marked = targets.length ? targets : [island];
      for (const node of marked) {
        node.setAttribute("data-component", component);
        if (resolved?.src) node.setAttribute("data-component-src", resolved.src);
      }
      out.push({ component, src: resolved?.src ?? null, nodes: marked.length });
    }
    return out;
  },
};

export default extractor;
