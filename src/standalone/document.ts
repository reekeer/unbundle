import { posix } from "node:path";
import type { HTMLElement } from "node-html-parser";
import type { StylesOutput } from "../types.ts";

const URL_ATTRIBUTES: Record<string, string[]> = {
  a: ["href"],
  img: ["src", "srcset"],
  source: ["src", "srcset"],
  video: ["src", "poster"],
  audio: ["src"],
  iframe: ["src"],
  link: ["href"],
  form: ["action"],
  image: ["href", "xlink:href"],
  use: ["href", "xlink:href"],
};
const DROPPED_LINKS = /\b(preload|modulepreload|prefetch|preconnect|dns-prefetch|manifest)\b/i;

const OVERLAY = `<style id="unbundle-overlay-style">
#unbundle-toggle{position:fixed;right:12px;bottom:12px;z-index:2147483647;font:12px/1 system-ui,sans-serif;padding:8px 10px;border-radius:6px;border:1px solid #7c3aed;background:#fff;color:#4c1d95;cursor:pointer}
#unbundle-styling{position:fixed;right:12px;bottom:46px;z-index:2147483647;font:11px/1 system-ui,sans-serif;padding:5px 8px;border-radius:6px;background:#0ea5e9;color:#fff}
#unbundle-label{position:fixed;z-index:2147483647;pointer-events:none;font:11px/1.3 ui-monospace,monospace;padding:4px 6px;border-radius:4px;background:#4c1d95;color:#fff;display:none;max-width:60vw}
html.unbundle-overlay-on [data-component]{outline:2px dashed #7c3aed;outline-offset:-2px}
</style>
<button id="unbundle-toggle" type="button">client components: off</button>
<div id="unbundle-label"></div>
<script id="unbundle-overlay">
(function(){var root=document.documentElement,button=document.getElementById("unbundle-toggle"),label=document.getElementById("unbundle-label");
button.addEventListener("click",function(){var on=root.classList.toggle("unbundle-overlay-on");button.textContent="client components: "+(on?"on":"off");if(!on)label.style.display="none"});
document.addEventListener("mousemove",function(e){if(!root.classList.contains("unbundle-overlay-on"))return;var t=e.target&&e.target.closest?e.target.closest("[data-component]"):null;if(!t){label.style.display="none";return}
label.textContent=t.getAttribute("data-component")+(t.getAttribute("data-component-src")?"  \\u2014  "+t.getAttribute("data-component-src"):"");label.style.display="block";label.style.left=Math.min(e.clientX+12,innerWidth-label.offsetWidth-8)+"px";label.style.top=(e.clientY+14)+"px"});})();
</script>`;

function absolutize(value: string, attribute: string, base: URL): string {
  if (attribute === "srcset") {
    return value
      .split(",")
      .map((part) => {
        const [url, ...descriptor] = part.trim().split(/\s+/);
        return [absolutize(url ?? "", "src", base), ...descriptor].join(" ");
      })
      .join(", ");
  }
  if (/^(#|data:|blob:|javascript:|mailto:|tel:)/i.test(value)) return value;
  return URL.parse(value, base)?.href ?? value;
}

export function standaloneDocument(root: HTMLElement, pageUrl: URL, styles: StylesOutput, filePath: string): string {
  const relative = (target: string) => posix.relative(posix.dirname(filePath), target);
  for (const script of root.querySelectorAll("script")) script.remove();
  for (const link of root.querySelectorAll("link")) {
    const rel = link.getAttribute("rel") ?? "";
    if (DROPPED_LINKS.test(rel)) {
      link.remove();
      continue;
    }
    if (/\bstylesheet\b/i.test(rel)) {
      const url = URL.parse(link.getAttribute("href") ?? "", pageUrl)?.href;
      if (url && styles.sources.has(url)) link.remove();
    }
  }
  for (const [tag, attributes] of Object.entries(URL_ATTRIBUTES)) {
    for (const element of root.querySelectorAll(tag)) {
      for (const attribute of attributes) {
        const value = element.getAttribute(attribute);
        if (value) element.setAttribute(attribute, absolutize(value, attribute, pageUrl));
      }
    }
  }

  const links = [styles.tailwind?.path, styles.app].filter((p): p is string => !!p).map((p) => `<link rel="stylesheet" href="${relative(p)}">`);
  const head = root.querySelector("head");
  head?.insertAdjacentHTML("afterbegin", `<meta name="generator" content="unbundle --standalone">`);
  head?.insertAdjacentHTML("beforeend", links.join(""));

  const tailwind = styles.tailwind;
  const tailwindLabel = tailwind ? `Tailwind CSS${tailwind.version ? ` v${tailwind.version}` : ""}` : null;
  const notes = [
    "unbundle --standalone",
    `Source page: ${pageUrl.href}`,
    tailwind
      ? `Styling: ${tailwindLabel}. Utility classes are left exactly as written in class="…" (for example class="bg-white p-4"). The generated Tailwind stylesheet (${tailwind.rules} top-level rules, ${(tailwind.bytes / 1024).toFixed(1)} kB) is linked from ${relative(tailwind.path)}, not inlined.`
      : null,
    styles.app ? `Site-specific CSS: ${relative(styles.app)}` : null,
    'data-component="Name" marks DOM rendered by a React Client Component, data-component-src points at its recovered module. Server-rendered markup carries no component name: React does not ship Server Component names to the browser.',
    "The page's own scripts were removed; use the button in the corner to outline client components.",
  ].filter(Boolean);
  const comment = `<!--\n  ${notes.join("\n  ").replace(/-->/g, "- ->")}\n-->\n`;

  const overlay = tailwindLabel ? OVERLAY.replace("client components: off</button>", `client components: off</button><span id="unbundle-styling">${tailwindLabel}</span>`) : OVERLAY;
  const body = root.querySelector("body");
  if (body) body.insertAdjacentHTML("beforeend", overlay);
  else root.insertAdjacentHTML("beforeend", overlay);

  const html = root.toString();
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
  return doctype ? `${doctype[0]}\n${comment}${html.slice(doctype[0].length).trimStart()}` : `${comment}${html}`;
}
