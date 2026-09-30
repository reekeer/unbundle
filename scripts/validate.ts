import { parse as babelParse } from "@babel/parser";
import traverseModule from "@babel/traverse";
import { parse as sfcParse, compileTemplate, compileScript } from "../.cache/fingerprints/node_modules/@vue/compiler-sfc/dist/compiler-sfc.cjs.js";
import { readdirSync, statSync, existsSync, readFileSync } from "node:fs";
import { join, dirname, normalize, relative } from "node:path";
import { entryExports, loadFingerprints } from "../src/refine/fingerprint.ts";
const db = await loadFingerprints();
const realExport = (spec: string, name: string) => entryExports(db, spec).has(name) || (spec.startsWith("@vue/") && entryExports(db, "vue").has(name)) || (/^(lucide|@heroicons\/|@tabler\/icons|@phosphor-icons\/|react-icons|@radix-ui\/react-icons)/.test(spec) && /^[A-Z][A-Za-z0-9]*$/.test(name));
const root = process.argv[2]!;
const files: string[] = [];
const walk = (d: string) => { for (const e of readdirSync(d)) { if (e === ".chunks" || e === "node_modules") continue; const p = join(d, e); if (statSync(p).isDirectory()) walk(p); else if (/\.(m?[jt]sx?|vue)$/.test(e) && !p.includes("/_chunks/scripts/")) files.push(p); } };
walk(root);
const pkg = existsSync(join(root, "package.json")) ? JSON.parse(readFileSync(join(root, "package.json"), "utf8")) : {};
const deps = new Set(Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }));
const problems: string[] = [];
const nuxt = deps.has("nuxt");
const autoComponents = new Set<string>();
if (nuxt) for (const f of files) { const m = /\/app\/components\/(.+)\.vue$/.exec(f); if (m) { const parts = m[1]!.split("/").flatMap((p) => p.split(/[-_]/)).map((p) => p[0]!.toUpperCase() + p.slice(1)); const dedup: string[] = []; for (const p of parts) if (dedup.at(-1) !== p) dedup.push(p); autoComponents.add(dedup.join("")); autoComponents.add(dedup.join("").replace(/Index$/, "")); autoComponents.add(parts.join("")); } }
const exportsOf = new Map<string, Set<string> | null>();
const scriptOf = (p: string): { code: string; ts: boolean } | null => {
  const src = readFileSync(p, "utf8");
  if (!p.endsWith(".vue")) return { code: src, ts: /\.tsx?$/.test(p) };
  const { descriptor } = sfcParse(src);
  const s = descriptor.scriptSetup ?? descriptor.script;
  return s ? { code: s.content, ts: s.lang === "ts" } : { code: "", ts: false };
};
const astOf = (p: string) => { const s = scriptOf(p)!; return babelParse(s.code, { sourceType: "module", plugins: s.ts ? ["typescript", "jsx"] : ["jsx"], errorRecovery: false }); };
const bindingNames = (node: any): string[] => {
  if (!node) return [];
  if (node.type === "Identifier") return [node.name];
  if (node.type === "ObjectPattern") return node.properties.flatMap((p: any) => bindingNames(p.type === "RestElement" ? p.argument : p.value));
  if (node.type === "ArrayPattern") return node.elements.flatMap((e: any) => bindingNames(e));
  if (node.type === "AssignmentPattern") return bindingNames(node.left);
  if (node.type === "RestElement") return bindingNames(node.argument);
  return [];
};
const namesExported = (p: string): Set<string> | null => {
  if (exportsOf.has(p)) return exportsOf.get(p)!;
  let out: Set<string> | null = new Set();
  try {
    if (p.endsWith(".vue")) { out.add("default"); }
    else for (const s of astOf(p).program.body as any[]) {
      if (s.type === "ExportDefaultDeclaration") out.add("default");
      if (s.type === "ExportAllDeclaration") { out = null; break; }
      if (s.type === "ExportNamedDeclaration") {
        for (const sp of s.specifiers) out.add(sp.exported.name ?? sp.exported.value);
        const d = s.declaration; if (d?.id) out.add(d.id.name); if (d?.declarations) for (const x of d.declarations) for (const name of bindingNames(x.id)) out.add(name);
      }
    }
  } catch { out = null; }
  exportsOf.set(p, out); return out;
};
const traverse = ((traverseModule as any).default ?? traverseModule) as typeof traverseModule;
const BROWSER = "window self globalThis document location history navigator localStorage sessionStorage screen innerWidth innerHeight outerWidth outerHeight scrollX scrollY pageXOffset pageYOffset scrollTo scrollBy devicePixelRatio requestAnimationFrame cancelAnimationFrame requestIdleCallback cancelIdleCallback getComputedStyle matchMedia getSelection alert confirm prompt open close print postMessage customElements indexedDB caches visualViewport IntersectionObserver ResizeObserver MutationObserver PerformanceObserver Image Audio Option HTMLElement HTMLCanvasElement HTMLInputElement HTMLTextAreaElement HTMLSelectElement HTMLImageElement HTMLAnchorElement HTMLIFrameElement HTMLDivElement HTMLFormElement HTMLVideoElement HTMLMediaElement SVGElement Element Node NodeList NodeFilter Text Comment Document DocumentFragment ShadowRoot Range Selection DOMParser XMLSerializer DOMRect FileReader FileList File Worker SharedWorker ServiceWorker Notification KeyboardEvent MouseEvent PointerEvent TouchEvent FocusEvent InputEvent WheelEvent DragEvent ClipboardEvent UIEvent ErrorEvent PopStateEvent HashChangeEvent StorageEvent MessageEvent ProgressEvent AnimationEvent TransitionEvent CustomEvent Event EventTarget XMLHttpRequest WebSocket EventSource IDBKeyRange CSS CSSStyleSheet getComputedStyle frames parent top opener name status origin isSecureContext external speechSynthesis MediaRecorder MediaStream AudioContext webkitAudioContext OffscreenCanvas ImageData Path2D DOMMatrix createImageBitmap BroadcastChannel ClipboardItem trustedTypes importScripts WorkerGlobalScope DedicatedWorkerGlobalScope gtag ym dataLayer fbq turnstile grecaptcha Telegram process global".split(" ");
const KNOWN_GLOBALS = new Set([...Object.getOwnPropertyNames(globalThis), ...BROWSER, "defineProps", "defineEmits", "defineExpose", "defineModel", "defineSlots", "defineOptions", "withDefaults", "undefined", "arguments"]);
for (const dts of ["auto-imports.d.ts", "app/auto-imports.d.ts", "src/auto-imports.d.ts", "components.d.ts", "src/components.d.ts", "app/components.d.ts", "env.d.ts", "src/env.d.ts"]) if (existsSync(join(root, dts))) for (const m of readFileSync(join(root, dts), "utf8").matchAll(/\b(?:const|let|var|function)\s+([A-Za-z_$][\w$]*)/g)) KNOWN_GLOBALS.add(m[1]!);
const undefinedNames = (ast: any): string[] => {
  const out = new Set<string>();
  traverse(ast, {
    ReferencedIdentifier(path: any) {
      const name = path.node.name;
      if (path.parentPath?.isMemberExpression({ property: path.node, computed: false })) return;
      if (path.parentPath?.isUnaryExpression({ operator: "typeof" })) return;
      if (path.scope.hasBinding(name, true) || KNOWN_GLOBALS.has(name) || /^__\w+__$/.test(name)) return;
      if (path.parentPath?.isTSTypeReference() || path.parentPath?.isTSQualifiedName() || path.findParent((p: any) => p.isTSType?.() || p.isTSTypeAnnotation?.())) return;
      out.add(name);
    },
  });
  return [...out];
};
const resolveRel = (from: string, spec: string) => {
  const base = normalize(join(dirname(from), spec));
  for (const suf of ["", ".js", ".jsx", ".ts", ".tsx", ".vue", ".mjs", "/index.js", "/index.ts", "/index.tsx", "/index.jsx"]) if (existsSync(base + suf) && statSync(base + suf).isFile()) return base + suf;
  return null;
};
for (const f of files) {
  const rel = relative(root, f);
  const src = readFileSync(f, "utf8");
  if (f.endsWith(".vue")) {
    try {
      const { descriptor, errors } = sfcParse(src, { filename: f });
      if (errors.length) problems.push(`${rel}: sfc parse: ${errors[0].message}`);
      if (descriptor.template && descriptor.scriptSetup) {
        const declared = new Set<string>();
        let parsed = true;
        try { for (const st of babelParse(descriptor.scriptSetup.content, { sourceType: "module", plugins: descriptor.scriptSetup.lang === "ts" ? ["typescript", "jsx"] : ["jsx"] }).program.body as any[]) { if (st.type === "ImportDeclaration") for (const sp of st.specifiers) declared.add(sp.local.name); if (st.type === "VariableDeclaration") for (const d of st.declarations) if (d.id.type === "Identifier") declared.add(d.id.name); if (st.type === "FunctionDeclaration" && st.id) declared.add(st.id.name); } } catch { parsed = false; }
        const globals = ["src", "app"].map((dir) => join(root, dir, "components.d.ts")).filter((path) => existsSync(path)).map((path) => readFileSync(path, "utf8")).join("\n");
        if (parsed) for (const m of descriptor.template.content.matchAll(/<([A-Z][A-Za-z0-9]*)/g)) if (!declared.has(m[1]) && !/^(Transition|TransitionGroup|KeepAlive|Teleport|Suspense|Component|RouterView|RouterLink|NuxtLink|NuxtPage|NuxtLayout|ClientOnly)$/.test(m[1]) && !globals.includes(m[1] + ":") && !(nuxt && deps.has("@nuxt/ui") && /^U[A-Z]/.test(m[1])) && !(nuxt && (autoComponents.has(m[1]) || autoComponents.has(m[1].replace(/^Lazy/, "")) || /^(Icon|Nuxt\w+|ClientOnly|ContentRenderer|MDC\w*|NuxtTurnstile|I18nT|Html|Head|Body|Title|Meta|Link|Style|NoScript|Base)$/.test(m[1])))) problems.push(`${rel}: template uses <${m[1]}> which is not imported`);
      }
      if (descriptor.template) {
        let bindings; try { if (descriptor.scriptSetup || descriptor.script) bindings = compileScript(descriptor, { id: "x" }).bindings; } catch (e: any) { problems.push(`${rel}: script: ${String(e.message).split("\n")[0]}`); }
        const r = compileTemplate({ source: descriptor.template.content, filename: f, id: "x", compilerOptions: { bindingMetadata: bindings } });
        for (const e of r.errors) problems.push(`${rel}: template: ${typeof e === "string" ? e : e.message}`);
      }
    } catch (e: any) { problems.push(`${rel}: ${String(e.message).split("\n")[0]}`); }
  }
  let ast;
  try { ast = astOf(f); } catch (e: any) { problems.push(`${rel}: parse: ${String(e.message).split("\n")[0]}`); continue; }
  if (!rel.startsWith("vendor/") && !/\.d\.ts$/.test(rel) && !(nuxt && f.endsWith(".vue"))) {
    const missing = undefinedNames(ast).filter((name) => !(nuxt && /^(use[A-Z]|define[A-Z]|navigateTo|\$fetch|abortNavigation|createError|showError|clearError|refreshNuxtData|clearNuxtData|onNuxtReady|reloadNuxtApp|setPageLayout|prerenderRoutes|callOnce|onBeforeRouteLeave|onBeforeRouteUpdate|addRouteMiddleware|preloadComponents|prefetchComponents|preloadRouteComponents|updateAppConfig|isPrerendered|requestIdleCallback|cancelIdleCallback|tryUseNuxtApp|useNuxtApp)/.test(name)));
    if (missing.length) problems.push(`${rel}: undefined ${missing.slice(0, 8).join(", ")}${missing.length > 8 ? ` (+${missing.length - 8})` : ""}`);
  }
  for (const s of ast.program.body as any[]) {
    if (s.type !== "ImportDeclaration" && !(s.type === "ExportNamedDeclaration" && s.source) && s.type !== "ExportAllDeclaration") continue;
    const raw: string = s.source.value;
    const srcDir = existsSync(join(root, "app")) && nuxt ? "app" : "src";
    const aliased = raw.startsWith("@/") || raw.startsWith("~/") ? join(root, srcDir, raw.slice(2)) : raw.startsWith("~~/") ? join(root, raw.slice(3)) : raw.startsWith("@vendor/") ? join(root, "vendor", raw.slice(8)) : null;
    const spec: string = aliased ? `./${relative(dirname(f), aliased)}`.replace(/^\.\/\.\.\//, "../") : raw;
    if (spec.startsWith(".")) {
      const target = resolveRel(f, spec.replace(/[?#].*$/, ""));
      if (!target) { problems.push(`${rel}: unresolved ${spec}`); continue; }
      if (/\.(css|scss|svg|png|json)$/.test(target)) continue;
      const ex = namesExported(target);
      if (!ex) continue;
      for (const sp of s.specifiers ?? []) {
        const name = sp.type === "ImportDefaultSpecifier" ? "default" : sp.type === "ImportSpecifier" ? (sp.imported.name ?? sp.imported.value) : sp.type === "ExportSpecifier" ? sp.local.name : null;
        if (name && !ex.has(name)) problems.push(`${rel}: ${spec} has no export '${name}'`);
      }
    } else if (!spec.startsWith("/") && !/^(https?:|virtual:|#|node:)/.test(spec)) {
      const p = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]!;
      if (!deps.has(p) && !rel.startsWith("vendor/")) problems.push(`${rel}: bare import '${spec}' not in package.json`);
      if (existsSync(join(root, "vendor", spec)) || existsSync(join(root, "vendor", spec + ".js"))) {
        const vf = resolveRel(join(root, "x"), `./vendor/${spec}`);
        const ex = vf ? namesExported(vf) : null;
        const vtext = vf ? readFileSync(vf, "utf8") : "";
        if (ex) for (const sp of s.specifiers ?? []) { const name = sp.type === "ImportDefaultSpecifier" ? "default" : sp.type === "ImportSpecifier" ? (sp.imported.name ?? sp.imported.value) : null; if (name && ex.has("default") && new RegExp("\\b\\w+\\." + name + "\\s*=").test(vtext)) continue; if (name && !ex.has(name) && !realExport(spec, name)) problems.push(`${rel}: vendor ${spec} has no export '${name}'`); }
      }
    }
  }
}
console.log(`${files.length} files, ${problems.length} problems`);
for (const p of problems) console.log("  " + p);
