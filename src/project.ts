import { parse } from "node-html-parser";
import { posix } from "node:path";
import type { OutputTree } from "./output.ts";
import type { OutputFile } from "./types.ts";
import { literalKey, parseProgram, t, traverse } from "./unpack/ast.ts";

export interface ProjectInfo {
  host: string;
  adapter: string | null;
  typescript: boolean;
  versions: ReadonlyMap<string, string>;
  aliases?: ReadonlyMap<string, string>;
  html?: string;
  base?: string;
}

function viteIndexHtml(html: string, entry: string, base: string): string {
  const root = parse(html, { comment: false, blockTextElements: { script: true, style: true, noscript: true, pre: true, textarea: true } });
  const built = (url: string) => /\/assets\/[^/]+\.(m?js|css)$/.test(url) || /\/assets\/[^/]+-[\w-]{8}\.(m?js|css)$/.test(url);
  for (const el of root.querySelectorAll("script[src]")) if (built(el.getAttribute("src") ?? "")) el.remove();
  for (const el of root.querySelectorAll("link")) {
    const rel = el.getAttribute("rel") ?? "";
    if (/modulepreload|preload|prefetch/.test(rel) || (rel === "stylesheet" && built(el.getAttribute("href") ?? ""))) el.remove();
  }
  const body = root.querySelector("body");
  if (!body) return "";
  body.appendChild(parse(`<script type="module" src="/${entry}"></script>`));
  let out = root.toString();
  if (base !== "/") out = out.replace(new RegExp(`(href|src)="${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?!assets/)`, "g"), '$1="%BASE_URL%');
  return out;
}

const VUE_API = new Set([
  "ref", "shallowRef", "computed", "reactive", "shallowReactive", "readonly", "watch", "watchEffect", "toRef", "toRefs", "toRaw", "unref", "isRef", "markRaw", "nextTick",
  "onMounted", "onBeforeMount", "onUnmounted", "onBeforeUnmount", "onUpdated", "onBeforeUpdate", "onActivated", "onDeactivated", "onErrorCaptured",
  "provide", "inject", "h", "defineComponent", "defineAsyncComponent", "getCurrentInstance", "useAttrs", "useSlots", "useModel", "useTemplateRef", "useId",
]);
const NUXT_API = new Set([
  "useNuxtApp", "useRuntimeConfig", "useAppConfig", "navigateTo", "abortNavigation", "useState", "useFetch", "useLazyFetch", "useAsyncData", "useLazyAsyncData", "useCookie",
  "useRequestURL", "useRequestHeaders", "useRequestEvent", "useError", "createError", "showError", "clearError", "useHead", "useSeoMeta", "useServerSeoMeta", "useHeadSafe",
  "defineNuxtPlugin", "defineNuxtRouteMiddleware", "addRouteMiddleware", "refreshNuxtData", "clearNuxtData", "prerenderRoutes", "callOnce", "onNuxtReady", "useLoadingIndicator", "reloadNuxtApp",
]);
const ROUTER_API = new Set(["useRoute", "useRouter", "onBeforeRouteLeave", "onBeforeRouteUpdate"]);
const MACROS = new Set(["definePageMeta", "defineProps", "defineEmits", "defineExpose", "defineModel", "defineSlots", "defineOptions", "withDefaults"]);
const PINIA_API = new Set(["defineStore", "storeToRefs", "acceptHMRUpdate"]);
const I18N_API = new Set(["useI18n", "useLocalePath", "useSwitchLocalePath", "useLocaleRoute", "useLocaleHead", "useBrowserLocale", "useCookieLocale", "useSetI18nParams"]);
const HTML_TAGS = /^(a|abbr|address|area|article|aside|audio|b|base|bdi|bdo|blockquote|body|br|button|canvas|caption|cite|code|col|colgroup|data|datalist|dd|del|details|dfn|dialog|div|dl|dt|em|embed|fieldset|figcaption|figure|footer|form|h[1-6]|head|header|hgroup|hr|html|i|iframe|img|input|ins|kbd|label|legend|li|link|main|map|mark|menu|meta|meter|nav|noscript|object|ol|optgroup|option|output|p|param|picture|pre|progress|q|rp|rt|ruby|s|samp|script|search|section|select|slot|small|source|span|strong|style|sub|summary|sup|table|tbody|td|template|textarea|tfoot|th|thead|time|title|tr|track|u|ul|var|video|wbr|svg|path|g|circle|rect|line|polyline|polygon|ellipse|defs|use|symbol|text|tspan|lineargradient|radialgradient|stop|clippath|mask|pattern|filter|foreignobject|component|transition|transition-group|keep-alive|teleport|suspense)$/i;

function packageOf(specifier: string): string | null {
  if (/^(\.|\/|#|node:|virtual:|~|@\/|data:|https?:)/.test(specifier)) return null;
  const parts = specifier.split("/");
  const name = specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
  return /^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name) ? name : null;
}

function scriptOf(file: OutputFile): string {
  if (!file.path.endsWith(".vue")) return file.content;
  return /<script\b[^>]*>([\s\S]*?)<\/script>/.exec(file.content)?.[1] ?? "";
}

function templateOf(file: OutputFile): string {
  return file.path.endsWith(".vue") ? file.content.replace(/<script\b[\s\S]*?<\/script>/g, "").replace(/<style\b[\s\S]*?<\/style>/g, "") : "";
}

function freeNames(code: string): Set<string> {
  const names = new Set<string>();
  try {
    traverse(parseProgram(code), {
      Identifier(path) {
        if (path.isReferencedIdentifier() && !path.scope.hasBinding(path.node.name, true)) names.add(path.node.name);
      },
    });
  } catch {
    return names;
  }
  return names;
}

function importedNames(code: string): Set<string> {
  const names = new Set<string>();
  for (const match of code.matchAll(/import\s+([\w$]+)?\s*,?\s*(?:\{([^}]*)\})?\s*from/g)) {
    if (match[1]) names.add(match[1]);
    for (const part of (match[2] ?? "").split(",")) {
      const local = part.split(/\s+as\s+/).pop()?.trim();
      if (local) names.add(local);
    }
  }
  return names;
}

function globalDeclaration(name: string): string {
  if (VUE_API.has(name)) return `  const ${name}: typeof import("vue")["${name}"];`;
  if (ROUTER_API.has(name)) return `  const ${name}: typeof import("vue-router")["${name}"];`;
  if (PINIA_API.has(name)) return `  const ${name}: typeof import("pinia")["${name}"];`;
  if (NUXT_API.has(name)) return `  const ${name}: typeof import("nuxt/app")["${name}"];`;
  if (name === "useI18n") return `  const ${name}: typeof import("vue-i18n")["${name}"];`;
  return `  const ${name}: (...args: any[]) => any;`;
}

function autoImports(files: OutputFile[], vue: boolean, nuxt: boolean): { globals: string[]; components: string[] } {
  const known = (name: string) => VUE_API.has(name) || (nuxt && (NUXT_API.has(name) || ROUTER_API.has(name) || MACROS.has(name) || PINIA_API.has(name) || I18N_API.has(name) || /^use[A-Z]\w*Store$/.test(name)));
  const globals = new Set<string>();
  const components = new Set<string>();
  for (const file of files) {
    const script = scriptOf(file);
    for (const name of freeNames(script)) if (known(name) && !MACROS.has(name)) globals.add(name);
    if (!vue || !file.path.endsWith(".vue")) continue;
    const imported = importedNames(script);
    for (const match of templateOf(file).matchAll(/<([A-Za-z][\w.-]*)/g)) {
      const tag = match[1]!;
      if (HTML_TAGS.test(tag) || tag.includes(".")) continue;
      const pascal = tag.includes("-") ? tag.split("-").map((w) => w[0]!.toUpperCase() + w.slice(1)).join("") : tag;
      if (!/^[A-Z]/.test(pascal) || imported.has(pascal) || imported.has(tag)) continue;
      components.add(pascal);
    }
  }
  return { globals: [...globals].sort(), components: [...components].sort() };
}

function literal(node: t.Node | null | undefined): unknown {
  if (t.isStringLiteral(node) || t.isNumericLiteral(node) || t.isBooleanLiteral(node)) return node.value;
  if (t.isNullLiteral(node)) return null;
  if (t.isUnaryExpression(node, { operator: "!" }) && t.isNumericLiteral(node.argument)) return !node.argument.value;
  if (t.isArrayExpression(node)) return node.elements.map((e) => literal(e));
  if (t.isObjectExpression(node)) {
    const out: Record<string, unknown> = {};
    for (const prop of node.properties) {
      if (!t.isObjectProperty(prop)) continue;
      const key = literalKey(prop.key);
      if (key) out[key] = literal(prop.value);
    }
    return out;
  }
  return undefined;
}

function runtimeConfig(files: OutputFile[]): Record<string, unknown> | null {
  for (const file of files) {
    if (!/\.html$/.test(file.path) || !file.content.includes("__NUXT__.config")) continue;
    for (const match of file.content.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) {
      if (!match[1]!.includes("__NUXT__.config")) continue;
      try {
        let found: Record<string, unknown> | null = null;
        t.traverseFast(parseProgram(match[1]!).program, (n) => {
          if (!found && t.isAssignmentExpression(n) && t.isMemberExpression(n.left) && literalKey(n.left.property) === "config" && t.isObjectExpression(n.right)) found = literal(n.right) as Record<string, unknown>;
        });
        if (found) return found;
      } catch {
        continue;
      }
    }
  }
  return null;
}

function i18nLocales(files: OutputFile[]): Array<Record<string, unknown>> {
  for (const file of files) {
    if ((file.kind !== "module" && file.kind !== "script") || !/\.m?[jt]s$/.test(file.path) || !/\bfile:\s*"[\w-]+\.(ts|js|json)"/.test(file.content)) continue;
    let out: Array<Record<string, unknown>> = [];
    try {
      t.traverseFast(parseProgram(file.content).program, (n) => {
        if (out.length || !t.isArrayExpression(n) || !n.elements.length) return;
        const items = n.elements.map((e) => literal(e) as Record<string, unknown> | undefined);
        if (items.every((i) => i && typeof i.code === "string" && typeof i.file === "string")) out = items as Array<Record<string, unknown>>;
      });
    } catch {
      continue;
    }
    if (out.length) return out;
  }
  return [];
}

const MODULE_KEYS: Record<string, string> = { turnstile: "@nuxtjs/turnstile", "nuxt-scripts": "@nuxt/scripts", mdc: "@nuxtjs/mdc", content: "@nuxt/content", i18n: "@nuxtjs/i18n", icon: "@nuxt/icon", colorMode: "@nuxtjs/color-mode", "color-mode": "@nuxtjs/color-mode", gtag: "nuxt-gtag", sentry: "@sentry/nuxt", supabase: "@nuxtjs/supabase" };
const MODULE_PACKAGES: Record<string, string> = { "@nuxt/ui": "@nuxt/ui", "@nuxtjs/i18n": "@nuxtjs/i18n", "vue-i18n": "@nuxtjs/i18n", pinia: "@pinia/nuxt", "@nuxtjs/mdc": "@nuxtjs/mdc", "@nuxt/content": "@nuxt/content", "@nuxt/icon": "@nuxt/icon", "@nuxt/image": "@nuxt/image" };

function nuxtConfig(files: OutputFile[], packages: Set<string>, root: string): { code: string; modules: string[] } {
  const config = runtimeConfig(files);
  const publicConfig = { ...((config?.public as Record<string, unknown>) ?? {}) };
  const modules = new Set<string>();
  for (const [pkg, module] of Object.entries(MODULE_PACKAGES)) if (packages.has(pkg)) modules.add(module);
  for (const key of Object.keys(publicConfig)) if (MODULE_KEYS[key]) modules.add(MODULE_KEYS[key]!);
  if (modules.has("@nuxt/ui")) for (const bundled of ["@nuxt/icon", "@nuxtjs/color-mode", "@nuxt/fonts"]) modules.delete(bundled);
  if (modules.has("@nuxt/content")) modules.delete("@nuxtjs/mdc");
  const options: Record<string, unknown> = { modules: [...modules].sort() };
  const css = files.filter((f) => f.kind === "style" && f.path.startsWith(`${root}/assets/css/`) && !/tailwind\.css$/.test(f.path)).map((f) => `~/${f.path.slice(root.length + 1)}`);
  if (css.length) options.css = css;
  const locales = i18nLocales(files);
  const runtimeI18n = publicConfig.i18n as Record<string, unknown> | undefined;
  if (!locales.length && Array.isArray(runtimeI18n?.locales)) {
    const declared = (runtimeI18n.locales as Array<Record<string, unknown>>).filter((l) => typeof l.code === "string").map((l) => {
      const file = Array.isArray(l.files) ? (l.files[0] as Record<string, unknown> | undefined)?.path : l.file;
      return { code: l.code, ...(typeof l.language === "string" ? { language: l.language } : {}), ...(typeof l.name === "string" ? { name: l.name } : {}), ...(typeof file === "string" ? { file: file.split("/").pop() } : {}) };
    });
    if (declared.length) options.i18n = { ...(typeof runtimeI18n.defaultLocale === "string" ? { defaultLocale: runtimeI18n.defaultLocale } : {}), ...(typeof runtimeI18n.strategy === "string" ? { strategy: runtimeI18n.strategy } : {}), locales: declared };
  }
  if (locales.length) {
    const prefixed = new Set<string>();
    for (const file of files) for (const match of file.content.matchAll(/path:\s*"\/([a-z]{2}(?:-[A-Z]{2})?)\//g)) prefixed.add(match[1]!);
    const codes = locales.map((l) => String(l.code));
    const unprefixed = codes.filter((c) => !prefixed.has(c));
    options.i18n = { ...(unprefixed.length === 1 ? { defaultLocale: unprefixed[0], strategy: prefixed.size ? "prefix_except_default" : "no_prefix" } : {}), locales };
  }
  const turnstile = publicConfig.turnstile as Record<string, unknown> | undefined;
  if (turnstile?.siteKey) options.turnstile = { siteKey: turnstile.siteKey };
  for (const key of Object.keys(publicConfig)) if (MODULE_KEYS[key]) delete publicConfig[key];
  if (Object.keys(publicConfig).length) options.runtimeConfig = { public: publicConfig };
  return { code: `export default defineNuxtConfig(${JSON.stringify(options, null, 2)});\n`, modules: [...modules] };
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

const AUTO_COMPONENTS = new Set(["NuxtLink", "NuxtPage", "NuxtLayout", "ClientOnly", "NuxtLoadingIndicator", "NuxtErrorBoundary", "NuxtRouteAnnouncer", "DevOnly"]);
const AUTO_SOURCES = /^(vue|vue-router|pinia|vue-i18n|#imports|#app|nuxt\/app)$/;

function autoImportable(name: string): boolean {
  return VUE_API.has(name) || NUXT_API.has(name) || ROUTER_API.has(name) || PINIA_API.has(name) || I18N_API.has(name) || AUTO_COMPONENTS.has(name) || name === "NuxtIcon" || name === "defineNuxtRouteMiddleware" || name === "useToast";
}

export function dropAutoImports(tree: OutputTree, root: string): number {
  let dropped = 0;
  for (const file of tree.all()) {
    if ((file.kind !== "module" && file.kind !== "script") || !file.path.startsWith(`${root}/`) || !/\.(m?[jt]sx?|vue)$/.test(file.path) || file.path.endsWith(".d.ts")) continue;
    const next = file.content.replace(/^([ \t]*)import\s*\{([^}]*)\}\s*from\s*(["'])([^"']+)\3;?[ \t]*$/gm, (line, indent: string, list: string, quote: string, source: string) => {
      const fromVendor = source.startsWith(".") && posix.normalize(posix.join(posix.dirname(file.path), source)).startsWith("vendor/");
      if (!AUTO_SOURCES.test(source) && !fromVendor) return line;
      const parts = list.split(",").map((p) => p.trim()).filter(Boolean);
      const kept = parts.filter((part) => {
        const [imported, local] = part.split(/\s+as\s+/).map((x) => x.trim());
        if ((local ?? imported) !== imported || !autoImportable(imported!)) return true;
        if (new RegExp(`export\\s*\\{[^}]*\\b${imported}\\b`).test(file.content)) return true;
        dropped++;
        return false;
      });
      if (kept.length === parts.length) return line;
      return kept.length ? `${indent}import { ${kept.join(", ")} } from ${quote}${source}${quote};` : "";
    });
    let content = next;
    if (file.path.endsWith(".vue") && /<NuxtIcon\b/.test(content) && !/\bNuxtIcon\b/.test(/<script\b[\s\S]*?<\/script>/.exec(content)?.[0] ?? "")) content = content.replace(/<(\/?)NuxtIcon\b/g, "<$1Icon");
    if (content !== file.content) file.content = content.replace(/\n{3,}/g, "\n\n");
  }
  return dropped;
}

export function writeProjectFiles(tree: OutputTree, info: ProjectInfo): string[] {
  const nuxt = info.adapter === "nuxt";
  const root = nuxt ? "app" : "src";
  if (nuxt) dropAutoImports(tree, root);
  const files = tree.all();
  const code = files.filter((f) => (f.kind === "module" || f.kind === "script") && f.path.startsWith(`${root}/`) && /\.(m?[jt]sx?|vue)$/.test(f.path));
  const vue = files.some((f) => f.path.endsWith(".vue")) || nuxt;
  const svelte = info.adapter === "sveltekit" || files.some((f) => /from\s*["']svelte(\/|["'])/.test(f.content));
  const packages = new Set<string>();
  const scanned = files.filter((f) => (((f.kind === "module" || f.kind === "script") && (f.path.startsWith(`${root}/`) || f.path.startsWith("vendor/")) && /\.(m?[jt]sx?|vue)$/.test(f.path)) || /\.astro$/.test(f.path) || /^astro\.config\.m?[jt]s$/.test(f.path)));
  const transitive = new Set<string>();
  const vendorOf = (path: string) => /^vendor\/((?:@[^/]+\/)?[^/]+)\//.exec(path)?.[1] ?? null;
  for (const file of scanned) {
    const own = vendorOf(file.path);
    for (const match of scriptOf(file).matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["']([^"']+)["']/g)) {
      const name = packageOf(match[1]!);
      if (!name) continue;
      if (own === null || !match[1]!.startsWith(".")) {
        if (name !== own) packages.add(name);
      } else if (name !== own) transitive.add(name);
    }
  }
  for (const file of files) {
    const name = vendorOf(file.path);
    if (name && packageOf(name) && !transitive.has(name)) packages.add(name);
  }
  if (nuxt) packages.add("nuxt");
  if (vue) packages.add("vue");
  for (const name of [...packages]) if (/^@vue\//.test(name)) packages.delete(name);
  if (nuxt && files.some((f) => f.path.startsWith(`${root}/stores/`) || /\bdefineStore\(/.test(f.content))) packages.add("pinia");
  const config = nuxt ? nuxtConfig(files, packages, root) : null;
  for (const module of config?.modules ?? []) packages.add(module);
  if (packages.has("vue") && (nuxt || files.some((f) => /from\s*["']vue-router["']/.test(f.content)))) packages.add("vue-router");
  if (files.some((f) => f.kind === "style" && /tailwind\.css$/.test(f.path))) packages.add("tailwindcss");
  const version = (name: string) => {
    const own = info.versions.get(name);
    const sibling = /^@[^/]+\/shared$/.test(name) ? info.versions.get(name.replace(/\/shared$/, "/core")) : undefined;
    const picked = sibling && own && sibling.split(".")[0] !== own.split(".")[0] ? sibling : own;
    return picked ? `^${picked}` : "*";
  };
  const dependencies = Object.fromEntries([...packages].sort().map((name) => [name, version(name)]));
  const scripts = nuxt ? { dev: "nuxt dev", build: "nuxt build", generate: "nuxt generate", preview: "nuxt preview", postinstall: "nuxt prepare" } : info.adapter === "angular" ? { start: "ng serve", build: "ng build" } : info.adapter === "sveltekit" ? { dev: "vite dev", build: "vite build", preview: "vite preview" } : info.adapter === "astro" ? { dev: "astro dev", build: "astro build", preview: "astro preview" } : info.adapter === "next" ? { dev: "next dev", build: "next build", start: "next start" } : info.adapter === "react-router" ? { dev: "react-router dev", build: "react-router build" } : info.adapter === "vite" || info.adapter === "nuxt" ? { dev: "vite", build: "vite build", preview: "vite preview" } : null;
  const written: string[] = [];
  const add = (path: string, content: string) => {
    tree.add({ path, content, kind: "data", renamable: false });
    written.push(path);
  };

  const devDependencies: Record<string, string> = {};
  if (info.adapter === "vite") {
    const react = packages.has("react") || files.some((f) => /\.[jt]sx$/.test(f.path) && f.path.startsWith(`${root}/`));
    const tailwind = files.some((f) => f.kind === "style" && /tailwind\.css$/.test(f.path));
    const plugins: Array<[string, string]> = [...(vue ? [["vue", "@vitejs/plugin-vue"] as [string, string]] : []), ...(react ? [["react", "@vitejs/plugin-react"] as [string, string]] : []), ...(tailwind ? [["tailwindcss", "@tailwindcss/vite"] as [string, string]] : [])];
    devDependencies.vite = "*";
    for (const [, pkg] of plugins) devDependencies[pkg] = "*";
    if (info.typescript) devDependencies.typescript = "*";
    const base = info.base && info.base !== "/" ? info.base : null;
    const config = ['import { fileURLToPath } from "node:url";', 'import { defineConfig } from "vite";', ...plugins.map(([name, pkg]) => `import ${name} from "${pkg}";`), "", "export default defineConfig({", ...(base ? [`  base: ${JSON.stringify(base)},`] : []), `  plugins: [${plugins.map(([name]) => `${name}()`).join(", ")}],`, "  resolve: {", '    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)), "@vendor": fileURLToPath(new URL("./vendor", import.meta.url)) },', "  },", "});", ""].join("\n");
    const entry = files.map((f) => f.path).find((path) => /^src\/main\.(tsx|ts|jsx|js)$/.test(path));
    const main = entry ? files.find((f) => f.path === entry) : undefined;
    const sheets = files.filter((f) => f.kind === "style" && /^src\/assets\/css\/[^/]+\.css$/.test(f.path)).map((f) => `./${f.path.slice(4)}`);
    if (main && sheets.length && !/import\s*["'][^"']+\.css["']/.test(main.content)) {
      const lines = main.content.split("\n");
      let at = 0;
      lines.forEach((line, i) => {
        if (/^import\b/.test(line) || (at && /^\s*[}\w].*from\s*["']/.test(line))) at = i + 1;
      });
      lines.splice(at, 0, ...sheets.map((sheet) => `import "${sheet}";`));
      main.content = lines.join("\n");
    }
    if (info.html && entry) {
      const index = viteIndexHtml(info.html, entry, info.base ?? "/");
      if (index) tree.add({ path: "index.html", content: index, kind: "data", renamable: false });
    }
    tree.add({ path: info.typescript ? "vite.config.ts" : "vite.config.js", content: config, kind: "data", renamable: false });
  }
  const astro = info.adapter === "astro";
  devDependencies.prettier = "^3.9.9";
  if (astro) devDependencies["prettier-plugin-astro"] = "^1.1.0";
  if (svelte) devDependencies["prettier-plugin-svelte"] = "^4.1.1";
  const prettierPlugins = [...(astro ? ["prettier-plugin-astro"] : []), ...(svelte ? ["prettier-plugin-svelte"] : [])];
  add(".prettierrc", json({ printWidth: 120, htmlWhitespaceSensitivity: "css", ...(prettierPlugins.length ? { plugins: prettierPlugins } : {}), overrides: [{ files: ["*.vue", "*.astro", "*.html", "*.svelte"], options: { printWidth: 200 } }] }));
  add(".prettierignore", [".chunks", ".unbundle", "vendor", "dist", ".output", ".nuxt", ".astro", "node_modules", ""].join("\n"));
  const allScripts = { ...(scripts ?? {}), format: "prettier --write ." };
  add("package.json", json({ name: info.host.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[._-]+/, "") || "site", private: true, type: "module", scripts: allScripts, dependencies, ...(Object.keys(devDependencies).length ? { devDependencies } : {}) }));
  if (config) add(info.typescript ? "nuxt.config.ts" : "nuxt.config.js", config.code);

  const paths: Record<string, string[]> = { "~/*": [`${root}/*`], "@/*": [`${root}/*`], ...(nuxt ? { "~~/*": ["./*"] } : { "@vendor/*": ["vendor/*"] }) };
  for (const [alias, target] of info.aliases ?? []) paths[alias] = [target];
  const compilerOptions: Record<string, unknown> = {
    target: "esnext",
    module: "esnext",
    moduleResolution: "bundler",
    jsx: "preserve",
    allowJs: true,
    checkJs: false,
    noEmit: true,
    skipLibCheck: true,
    resolveJsonModule: true,
    baseUrl: ".",
    paths,
  };
  if (info.typescript) compilerOptions.strict = false;
  add(info.typescript ? "tsconfig.json" : "jsconfig.json", json({
    compilerOptions,
    include: [`${root}/**/*`, "vendor/**/*"],
    exclude: [".chunks", "html", "node_modules"],
    typeAcquisition: { enable: true, include: [...packages].sort() },
  }));

  add(posix.join(root, "env.d.ts"), [
    ...(vue ? ['declare module "*.vue" {', "  const component: any;", "  export default component;", "}", ""] : []),
    ...(svelte ? ['declare module "*.svelte" {', "  const component: any;", "  export default component;", "}", ""] : []),
    'declare module "*.css";',
    'declare module "*.svg" {',
    "  const src: string;",
    "  export default src;",
    "}",
    "",
  ].join("\n"));

  if (vue) {
    const { globals, components } = autoImports(code, vue, nuxt);
    if (globals.length) add(posix.join(root, "auto-imports.d.ts"), ["export {};", "declare global {", ...globals.map(globalDeclaration), "}", ""].join("\n"));
    if (components.length) {
      add(posix.join(root, "components.d.ts"), [
        "export {};",
        'declare module "vue" {',
        "  export interface GlobalComponents {",
        ...components.map((name) => `    ${name}: import("vue").DefineComponent<any, any, any>;`),
        "  }",
        "}",
        "",
      ].join("\n"));
    }
  }

  const recommendations = [...(vue ? ["Vue.volar"] : []), ...(svelte ? ["svelte.svelte-vscode"] : []), ...(info.adapter === "astro" ? ["astro-build.astro-vscode"] : [])];
  if (recommendations.length) add(".vscode/extensions.json", json({ recommendations }));
  const hidden = { ".chunks": true, ".unbundle": true };
  add(".vscode/settings.json", json({ "files.exclude": hidden, "search.exclude": { ...hidden, "html/*.standalone.html": true } }));
  return written;
}
