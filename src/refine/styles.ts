export interface StyleSheet {
  url: string;
  css: string;
}

export interface MergedStyles {
  tailwind: { version: string | null; css: string; rules: number } | null;
  app: { css: string; rules: number };
  sources: string[];
}

const TAILWIND_BANNER = /\/\*!\s*tailwindcss\s+v?([\d.]+)/i;
const TAILWIND_LAYERS = /^@layer\s+(properties|theme|base|components|utilities)\b/;
const TAILWIND_KEYFRAMES = /^@keyframes\s+(spin|ping|pulse|bounce)\b/;
const UTILITY = /^(-?(flex|grid|block|inline|hidden|contents|table|flow|relative|absolute|fixed|sticky|static|container|group|peer|sr-only|not-sr-only|truncate|underline|overline|line-through|no-underline|italic|not-italic|antialiased|subpixel-antialiased|visible|invisible|collapse|isolate|transform|transition|shadow|rounded|border|outline|ring|blur|filter|backdrop|resize|select|cursor|pointer|overflow|overscroll|object|aspect|columns|break|box|float|clear|z|order|col|row|gap|space|divide|place|justify|content|items|self|basis|grow|shrink|p[xytrblse]?|m[xytrblse]?|w|h|min|max|size|text|font|leading|tracking|align|whitespace|wrap|bg|from|via|to|fill|stroke|opacity|mix|inset|top|right|bottom|left|start|end|translate|rotate|scale|skew|origin|duration|ease|delay|animate|list|decoration|indent|line|uppercase|lowercase|capitalize|normal-case|appearance|accent|caret|scroll|snap|touch|will|sm|md|lg|xl|2xl|dark|hover|focus|active|disabled|first|last|odd|even)(-|$))/;

interface Rule {
  text: string;
  head: string;
}

export function topLevelRules(css: string): Rule[] {
  const rules: Rule[] = [];
  let depth = 0;
  let start = 0;
  let quote: string | null = null;
  for (let i = 0; i < css.length; i++) {
    const char = css[i]!;
    if (quote) {
      if (char === "\\") i++;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "/" && css[i + 1] === "*") {
      const end = css.indexOf("*/", i + 2);
      const stop = end < 0 ? css.length : end + 2;
      if (depth === 0) {
        if (css.slice(start, i).trim()) rules.push(rule(css.slice(start, i)));
        rules.push(rule(css.slice(i, stop)));
        start = stop;
      }
      i = stop - 1;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === "{") depth++;
    else if (char === "}") {
      depth = Math.max(0, depth - 1);
      if (depth === 0) {
        rules.push(rule(css.slice(start, i + 1)));
        start = i + 1;
      }
    } else if (char === ";" && depth === 0) {
      rules.push(rule(css.slice(start, i + 1)));
      start = i + 1;
    }
  }
  if (css.slice(start).trim()) rules.push(rule(css.slice(start)));
  return rules.filter((r) => r.text.trim());
}

function rule(text: string): Rule {
  const trimmed = text.trim();
  const brace = trimmed.indexOf("{");
  return { text: trimmed, head: (brace < 0 ? trimmed : trimmed.slice(0, brace)).trim() };
}

function classTokens(selector: string): string[] {
  return [...selector.matchAll(/\.((?:\\.|[\w-])+)/g)].map((m) => m[1]!.replace(/\\(.)/g, "$1"));
}

function isUtilitySelector(selector: string, legacy: boolean): boolean {
  const classes = classTokens(selector);
  if (!classes.length) return legacy;
  return classes.every((token) => /[:[\]/]/.test(token) || UTILITY.test(token));
}

export function isTailwindRule(r: Rule, version: string | null = null): boolean {
  if (r.text.startsWith("/*")) return TAILWIND_BANNER.test(r.text);
  if (TAILWIND_LAYERS.test(r.head) || TAILWIND_KEYFRAMES.test(r.head)) return true;
  if (/^@property\s+--tw-/.test(r.head)) return true;
  if (r.head.startsWith("@")) return false;
  const legacy = !!version && /^[0-3]\./.test(version);
  return r.head.split(",").every((selector) => isUtilitySelector(selector, legacy));
}

export function tailwindVersion(css: string): string | null | undefined {
  const banner = TAILWIND_BANNER.exec(css);
  if (banner) return banner[1]!;
  return /--tw-[\w-]+\s*:/.test(css) ? null : undefined;
}

export function mergeStyles(sheets: StyleSheet[]): MergedStyles {
  const seen = new Set<string>();
  const unique = sheets.filter((s) => {
    const key = Bun.hash(s.css).toString(36);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const version = unique.map((s) => tailwindVersion(s.css)).find((v) => v !== undefined);
  const usesTailwind = version !== undefined;
  const tailwind: string[] = [];
  const app: string[] = [];
  for (const sheet of unique) {
    for (const r of topLevelRules(sheet.css)) {
      if (/^\/\*#\s*sourceMappingURL=/.test(r.text)) continue;
      (usesTailwind && isTailwindRule(r, version ?? null) ? tailwind : app).push(r.text);
    }
  }
  return {
    tailwind: usesTailwind ? { version: version ?? null, css: tailwind.join(""), rules: tailwind.filter((t) => !t.startsWith("/*")).length } : null,
    app: { css: app.join("\n"), rules: app.filter((t) => !t.startsWith("/*")).length },
    sources: unique.map((s) => s.url),
  };
}
