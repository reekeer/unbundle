import { format, type Plugin } from "prettier";
import * as astroPlugin from "prettier-plugin-astro";
import * as sveltePlugin from "prettier-plugin-svelte";

const PARSER_BY_EXT: Record<string, string> = {
  ".js": "babel",
  ".mjs": "babel",
  ".cjs": "babel",
  ".jsx": "babel",
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "typescript",
  ".css": "css",
  ".scss": "scss",
  ".less": "less",
  ".html": "html",
  ".htm": "html",
  ".json": "json",
  ".vue": "vue",
  ".md": "markdown",
  ".svelte": "svelte",
  ".astro": "astro",
};

export function parserFor(path: string): string | null {
  const dot = path.lastIndexOf(".");
  return dot < 0 ? null : (PARSER_BY_EXT[path.slice(dot).toLowerCase()] ?? null);
}

export function tightenText(html: string): string {
  const lines = html.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const open = lines[i]!;
    const text = lines[i + 1];
    const close = lines[i + 2];
    const tag = /^(\s*)<([A-Za-z][\w.:-]*)(?:\s[^<>]*)?>$/.exec(open) ?? /^(\s*)>$/.exec(open);
    if (tag && text !== undefined && close !== undefined) {
      const indent = tag[1]!;
      const name = tag[2] ?? openedName(out, indent);
      const inner = /^\s+(\S.*)$/.exec(text)?.[1];
      if (name && !/^(script|style|pre|textarea)$/i.test(name) && inner && !/[<>]/.test(inner) && close === `${indent}</${name}>` && text.startsWith(`${indent}  `)) {
        const joined = `${open}${inner}</${name}>`;
        if (!tag[2] || joined.length <= MARKUP_WIDTH) {
          out.push(joined);
          i += 2;
          continue;
        }
      }
    }
    out.push(open);
  }
  return out.join("\n");
}

function openedName(previous: string[], indent: string): string | null {
  for (let i = previous.length - 1; i >= 0 && i >= previous.length - 60; i--) {
    const match = new RegExp(`^${indent}<([A-Za-z][\\w.:-]*)(\\s|$)`).exec(previous[i]!);
    if (match) return match[1]!;
    if (previous[i]!.startsWith(`${indent}<`) || previous[i]!.startsWith(`${indent}</`)) return null;
  }
  return null;
}

export const CODE_WIDTH = 120;
export const MARKUP_WIDTH = 200;

const BLOCK = /^(address|article|aside|blockquote|body|dd|details|dialog|div|dl|dt|fieldset|figcaption|figure|footer|form|h[1-6]|head|header|hgroup|hr|html|li|main|nav|ol|p|pre|section|summary|table|tbody|td|tfoot|th|thead|tr|ul|template|slot|svg|script|style|link|meta|title)$/i;

export function settleMarkup(text: string, vue: boolean): string {
  let out = text.replace(/\{\{\s*\n\s*([^\n{}]*?)\s*\n\s*\}\}/g, "{{ $1 }}");
  out = out.replace(/<\/([A-Za-z][\w.:-]*)\n([ \t]*)>(<\/?([A-Za-z][\w.:-]*))?/g, (whole, name: string, indent: string, next: string | undefined, nextName: string | undefined) => {
    if (!next) return `</${name}>`;
    const safe = vue || BLOCK.test(name) || (nextName !== undefined && BLOCK.test(nextName));
    return safe ? `</${name}>\n${indent}${next}` : `</${name}>${next}`;
  });
  out = out.replace(/(\n[ \t]*[\w:@#.\-[\]]+(?:="[^"\n]*")?)\n[ \t]*>(?=[^\s>])/g, "$1>");
  return out;
}

export async function formatContent(path: string, content: string): Promise<string> {
  const parser = parserFor(path);
  if (!parser) return content;
  const plugins = parser === "astro" ? [astroPlugin as Plugin] : parser === "svelte" ? [sveltePlugin as Plugin] : [];
  const markup = parser === "html" || parser === "vue" || parser === "astro" || parser === "svelte";
  const formatted = await format(content, { parser, printWidth: markup ? MARKUP_WIDTH : CODE_WIDTH, filepath: path, plugins, ...(parser === "html" || parser === "vue" || parser === "astro" || parser === "svelte" ? { htmlWhitespaceSensitivity: "css" as const } : {}) });
  if (parser === "html" || parser === "astro" || parser === "svelte") return tightenText(settleMarkup(formatted, false));
  if (parser === "vue") return tightenText(settleMarkup(formatted, true));
  return formatted;
}

