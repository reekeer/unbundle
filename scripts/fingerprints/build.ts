import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { build, readRules } from "@reekeer/sigdb";
import { dirname, join, relative, resolve } from "node:path";
import { COMPONENT_GROUP, COMPONENT_INDEX, exportNames, FILE_GROUPS, fileKey, FINGERPRINT_SCHEMA, FINGERPRINTS_PATH, FUNCTION_GROUPS, FUNCTION_INDEX, inlinedVariants, printModule, type LibraryFile } from "../../src/refine/fingerprint.ts";
import { normalizeExports } from "../../src/refine/cleanup.ts";
import { buildIcons } from "./icons.ts";
import { libraryComponents } from "./components.ts";
import { inlineConstants } from "./constants.ts";

const ROOT = resolve(import.meta.dir, "../..");
const CACHE = process.env.UNBUNDLE_FP_CACHE ?? join(ROOT, ".cache/fingerprints");
const SOURCES = join(ROOT, "sigdb");
const MAX_FILES_PER_PACKAGE = 300;
const MAX_FILES: Record<string, number> = { next: 900, nuxt: 600 };
const FOLLOW = /^(@radix-ui\/|@floating-ui\/|@swc\/helpers|react-remove-scroll|react-remove-scroll-bar|react-style-singleton|aria-hidden|use-callback-ref|use-sidecar|get-nonce|detect-node-es|@firebase\/|@sentry\/(core|browser|react|utils)|@wagmi\/core|@tanstack\/(router-core|history|store)|@reduxjs\/|redux$|reselect|@vueuse\/(shared|core)|@internationalized\/|@emotion\/|@mui\/(system|utils|base|styled-engine)|@supabase\/|@apollo\/|@wry\/|use-sync-external-store|motion-dom|motion-utils|@react-spring\/|embla-carousel|@floating-ui\/|@shikijs\/|@telegram-apps\/|@clerk\/|@auth0\/auth0-spa-js|@dnd-kit\/|@tanstack\/table-core|@primevue\/|@vee-validate\/|@tanstack\/(vue-query|query-core))/;
const CONDITIONS = ["browser", "import", "module", "default", "require"];

type Entry = string | { spec: string; entry: string };

const PACKAGES: Entry[] = [
  "react",
  "react/jsx-runtime",
  "react-dom",
  "react-dom/client",
  "scheduler",
  "zustand",
  "@tanstack/query-core",
  "@tanstack/react-query",
  "@radix-ui/react-slot",
  "@radix-ui/react-dialog",
  "react-router",
  "axios",
  "clsx",
  "tailwind-merge",
  "immer",
  "zod",
  "lodash-es",
  "vue",
  "@vue/runtime-dom",
  "@vue/runtime-core",
  "@vue/reactivity",
  "@vue/shared",
  "pinia",
  "vue-router",
  { spec: "next/dist/client/app-next", entry: "dist/client/app-next.js" },
  { spec: "next/dist/client/next", entry: "dist/client/next.js" },
  { spec: "next/link", entry: "dist/client/app-dir/link.js" },
  { spec: "next/link", entry: "dist/client/link.js" },
  { spec: "next/image", entry: "dist/client/image-component.js" },
  { spec: "next/image", entry: "dist/shared/lib/image-external.js" },
  { spec: "next/navigation", entry: "dist/client/components/navigation.js" },
  { spec: "next/script", entry: "dist/client/script.js" },
  { spec: "next/dynamic", entry: "dist/shared/lib/app-dynamic.js" },
  { spec: "next/dynamic", entry: "dist/shared/lib/dynamic.js" },
  { spec: "next/form", entry: "dist/client/app-dir/form.js" },
  { spec: "next/head", entry: "dist/shared/lib/head.js" },
  { spec: "next/dist/compiled/process", entry: "dist/compiled/process/browser.js" },
  { spec: "next/dist/build/polyfills/process", entry: "dist/build/polyfills/process.js" },
  { spec: "next/dist/lib/require-instrumentation-client", entry: "dist/lib/require-instrumentation-client.js" },
  { spec: "next/dist/compiled/react-server-dom-webpack/client", entry: "dist/compiled/react-server-dom-webpack/cjs/react-server-dom-webpack-client.browser.production.js" },
  ...internals("next", ["dist/client", "dist/client/components", "dist/client/components/builtin", "dist/client/components/instant-validation", "dist/client/request", "dist/lib/metadata/generate"]),
  ...internals("nuxt", ["dist/app", "dist/app/composables", "dist/app/components", "dist/app/plugins", "dist/app/utils", "dist/app/compat", "dist/pages/runtime", "dist/pages/runtime/plugins", "dist/head/runtime", "dist/head/runtime/plugins", "dist/components/runtime"]),
  ...internals("@nuxtjs/i18n", ["dist/runtime", "dist/runtime/composables", "dist/runtime/routing", "dist/runtime/shared", "dist/runtime/plugins", "dist/runtime/components"]),
  ...internals("@nuxt/icon", ["dist/runtime", "dist/runtime/components", "dist/runtime/plugins"]),
  "@angular/core",
  "@angular/common",
  "@angular/common/http",
  "@angular/router",
  "@angular/platform-browser",
  "@angular/forms",
  "@angular/animations",
  "rxjs",
  "@unhead/vue",
  "unhead",
  "hookable",
  "ofetch",
  "destr",
  "ufo",
  "defu",
  "cookie-es",
  "klona",
  "devalue",
  "consola",
  "perfect-debounce",
  { spec: "lucide-vue-next", entry: "dist/esm/createLucideIcon.js" },
  { spec: "lucide-vue-next", entry: "dist/esm/Icon.js" },
  { spec: "@tabler/icons-react", entry: "dist/esm/createReactComponent.mjs" },
  { spec: "@tabler/icons-vue", entry: "dist/esm/createVueComponent.mjs" },
  { spec: "lucide-react", entry: "dist/esm/createLucideIcon.mjs" },
  "preact",
  "preact/hooks",
  "preact/compat",
  "solid-js",
  "solid-js/web",
  "solid-js/store",
  "svelte/internal/client",
  "svelte/store",
  "lit",
  "alpinejs",
  "jquery",
  "htmx.org",
  "@tanstack/react-router",
  "wouter",
  "@solidjs/router",
  "@reduxjs/toolkit",
  "react-redux",
  "redux",
  "jotai",
  "jotai/utils",
  "valtio",
  "mobx",
  "mobx-react-lite",
  "xstate",
  "nanostores",
  "effector",
  "swr",
  "@apollo/client",
  "urql",
  "ky",
  "@trpc/client",
  "socket.io-client",
  "@supabase/supabase-js",
  "firebase/app",
  "firebase/auth",
  "firebase/firestore",
  "class-variance-authority",
  "cmdk",
  "vaul",
  "sonner",
  ...[
    "dropdown-menu", "popover", "tooltip", "select", "tabs", "accordion", "checkbox", "switch", "avatar", "label", "scroll-area", "toast", "alert-dialog",
    "navigation-menu", "hover-card", "separator", "progress", "radio-group", "slider", "toggle", "toggle-group", "collapsible", "context-menu", "menubar",
    "aspect-ratio", "visually-hidden",
  ].map((name) => `@radix-ui/react-${name}`),
  "@headlessui/react",
  "@mui/material",
  "@mantine/core",
  "antd",
  "@chakra-ui/react",
  "embla-carousel",
  "embla-carousel-react",
  "swiper",
  "react-hot-toast",
  "framer-motion",
  "motion",
  "gsap",
  "@react-spring/web",
  "lottie-web",
  "react-hook-form",
  "@hookform/resolvers",
  "formik",
  "yup",
  "valibot",
  "date-fns",
  "dayjs",
  "moment",
  "luxon",
  "recharts",
  "chart.js",
  "echarts",
  "apexcharts",
  ...["array", "scale", "shape", "selection", "format", "time-format", "interpolate", "axis", "transition", "zoom"].map((name) => `d3-${name}`),
  "i18next",
  "react-i18next",
  "next-intl",
  "vue-i18n",
  "lodash",
  "uuid",
  "nanoid",
  "qs",
  "js-cookie",
  "dompurify",
  "marked",
  "prismjs",
  "highlight.js",
  "jwt-decode",
  "crypto-js",
  "@telegram-apps/sdk",
  "@twa-dev/sdk",
  "@tonconnect/ui-react",
  "ethers",
  "viem",
  "wagmi",
  "@solana/web3.js",
  "@sentry/browser",
  "@sentry/nextjs",
  "posthog-js",
  "@vercel/analytics",
  "mixpanel-browser",
  "@stripe/stripe-js",
  "styled-components",
  "@emotion/react",
  "@vueuse/core",
  "reka-ui",
  "motion-v",
  "tailwind-variants",
  "@iconify/vue",
  "@iconify/react",
  "@leavepulse/ui",
  "@fortawesome/fontawesome-svg-core",
  "@fortawesome/react-fontawesome",
  { spec: "lucide-react", entry: "dist/esm/Icon.mjs" },
  { spec: "lucide-react", entry: "dist/esm/context.mjs" },
  "@vue-flow/core",
  "@vue-flow/background",
  "@vue-flow/controls",
  "@vue-flow/minimap",
  "shiki",
  ...internals("@nuxtjs/mdc", ["dist/runtime", "dist/runtime/components", "dist/runtime/parser", "dist/runtime/highlighter", "dist/runtime/utils"]),
  ...internals("@nuxt/content", ["dist/runtime", "dist/runtime/internal", "dist/runtime/utils", "dist/runtime/plugins"]),
  ...internals("@nuxtjs/turnstile", ["dist/runtime/composables"]),
  "@telegram-apps/sdk-react",
  "next-auth/react",
  "@clerk/clerk-react",
  "@react-oauth/google",
  "@auth0/auth0-react",
  "@marsidev/react-turnstile",
  "react-google-recaptcha",
  "@hcaptcha/react-hcaptcha",
  "element-plus",
  "vuetify",
  "primevue",
  "naive-ui",
  "vee-validate",
  "@tanstack/vue-query",
  "@headlessui/vue",
  "react-toastify",
  "@dnd-kit/core",
  "@tanstack/react-table",
  "react-markdown",
  "three",
];

function internals(name: string, dirs: string[]): Entry[] {
  const root = join(CACHE, "node_modules", name);
  return dirs.flatMap((dir) =>
    existsSync(join(root, dir))
      ? readdirSync(join(root, dir))
          .filter((file) => file.endsWith(".js") && !/\.(dev|development|test|server)\.js$|-dev\.js$|react-server/.test(file))
          .map((file) => ({ spec: `${name}/${dir}/${file.replace(/\.js$/, "")}`, entry: `${dir}/${file}` }))
      : [],
  );
}

const production = new Bun.Transpiler({
  loader: "js",
  define: {
    "process.env.NODE_ENV": '"production"',
    __DEV__: "false",
    __VUE_OPTIONS_API__: "true",
    __VUE_PROD_DEVTOOLS__: "false",
    __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: "false",
    __FEATURE_PROD_DEVTOOLS__: "false",
    ngDevMode: "false",
    ngJitMode: "false",
    ngI18nClosureMode: "false",
    ngServerMode: "false",
  },
  deadCodeElimination: true,
});

const ESM_ENV = /import\s*\{([^}]*)\}\s*from\s*["']esm-env["'];?/;
const ENV_VALUES: Record<string, string> = { DEV: "false", BROWSER: "true", NODE: "false" };

const browserProduction = new Bun.Transpiler({
  loader: "js",
  define: { "process.env.NODE_ENV": '"production"', ...ENV_VALUES },
  deadCodeElimination: true,
});

function toProduction(code: string): string {
  const env = ESM_ENV.exec(code);
  const names = env ? env[1]!.split(",").map((n) => n.trim()).filter(Boolean) : [];
  const plain = names.length > 0 && names.every((n) => n in ENV_VALUES);
  try {
    return plain ? browserProduction.transformSync(code.replace(ESM_ENV, "")) : production.transformSync(code);
  } catch {
    return code;
  }
}

const transpiler = new Bun.Transpiler({ loader: "js" });

function packageDir(name: string): string | null {
  const dir = join(CACHE, "node_modules", name);
  return existsSync(join(dir, "package.json")) ? dir : null;
}

function pickCondition(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const picked = pickCondition(item);
      if (picked) return picked;
    }
    return null;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const condition of CONDITIONS) if (condition in record) {
      const picked = pickCondition(record[condition]);
      if (picked) return picked;
    }
  }
  return null;
}

function entryOf(dir: string, subpath: string): string | null {
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as Record<string, unknown>;
  const exports = pkg.exports as Record<string, unknown> | string | undefined;
  if (subpath !== ".") {
    const target = exports && typeof exports === "object" ? pickCondition(exports[subpath]) : null;
    return resolveFile(join(dir, target ?? subpath));
  }
  const fromExports = typeof exports === "string" ? exports : exports && typeof exports === "object" ? pickCondition("." in exports ? exports["."] : exports) : null;
  const candidate = fromExports ?? (typeof pkg.browser === "string" ? pkg.browser : null) ?? (pkg.module as string) ?? (pkg.main as string) ?? "index.js";
  return resolveFile(join(dir, candidate));
}

function resolveFile(base: string): string | null {
  for (const candidate of [base, `${base}.js`, `${base}.mjs`, `${base}.cjs`, join(base, "index.js"), join(base, "index.mjs")]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function packageNameOf(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
}

const BUILD_ENV = /^(G:process|P:env|P:(__NEXT|NEXT_|TURBOPACK|__TURBOPACK)\w*)$/;

function withoutBuildEnv(features: string[]): string[] {
  return features.filter((f) => !BUILD_ENV.test(f));
}

const perPackage = new Map<string, number>();

function isCommonJs(code: string): boolean {
  return /\b(exports|module\.exports)\b/.test(code) && !/^\s*(import|export)\s/m.test(code);
}

function walk(target: Entry, discovered: Set<string>, seenFiles: Set<string>): LibraryFile[] {
  const spec = typeof target === "string" ? target : target.spec;
  const name = packageNameOf(spec);
  const subpath = spec === name ? "." : `.${spec.slice(name.length)}`;
  const dir = packageDir(name);
  if (!dir) {
    console.warn(`skip ${name}: not installed`);
    return [];
  }
  const version = (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { version: string }).version;
  const entry = typeof target === "string" ? entryOf(dir, subpath) : resolveFile(join(dir, target.entry));
  if (!entry) return [];
  if (seenFiles.has(entry)) {
    const known = files.find((f) => f.package === name && f.file === relative(dir, entry));
    if (known && !known.specifier) Object.assign(known, { entry: true, specifier: spec });
    return [];
  }
  const queue = [entry];
  const seen = seenFiles;
  seen.add(entry);
  const found: LibraryFile[] = [];
  const limit = MAX_FILES[name] ?? MAX_FILES_PER_PACKAGE;
  while (queue.length && (perPackage.get(name) ?? 0) + found.length < limit) {
    const file = queue.shift()!;
    const code = readFileSync(file, "utf8");
    for (const imported of safeScan(code)) {
      if (imported.startsWith(".")) {
        const target = resolveFile(resolve(dirname(file), imported));
        if (target && !seen.has(target) && !/\.development\./.test(target) && /\.[cm]?js$/.test(target)) {
          seen.add(target);
          queue.push(target);
        }
      } else if (!imported.startsWith("node:")) {
        const other = packageNameOf(imported);
        if (other === name && imported !== name) {
          const target = entryOf(dir, `.${imported.slice(name.length)}`);
          if (target && !seen.has(target)) {
            seen.add(target);
            queue.push(target);
          }
        } else discovered.add(imported);
      }
    }
    try {
      const production = toProduction(inlineConstants(code, file, dir));
      const normalized = isCommonJs(production) ? normalizeExports(production) : production;
      const print = printModule(normalized);
      const names = exportNames(normalized);
      found.push({
        package: name,
        version,
        file: relative(dir, file),
        entry: file === entry,
        ...(file === entry ? { specifier: spec } : {}),
        features: withoutBuildEnv(print.features),
        exports: print.exports.map((fn) => ({ ...fn, features: withoutBuildEnv(fn.features) })),
        ...(names.length ? { names } : {}),
        locals: [...print.locals, ...inlinedVariants(print)].filter((l) => l.name.length > 2).map((fn) => ({ ...fn, features: withoutBuildEnv(fn.features) })),
      });
    } catch (err) {
      console.warn(`skip ${name}/${relative(dir, file)}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const router = /module\.exports\s*=\s*require\(\s*['"](\.\/cjs\/[^'"]*production[^'"]*)['"]\s*\)/.exec(readFileSync(entry, "utf8"));
  if (router) {
    const target = relative(dir, resolveFile(resolve(dirname(entry), router[1]!)) ?? "");
    for (const f of found) if (f.file === target) Object.assign(f, { entry: true, specifier: spec });
  }
  perPackage.set(name, (perPackage.get(name) ?? 0) + found.length);
  console.log(`${spec}@${version} (${relative(dir, entry)}): ${found.length} file(s)`);
  return found;
}

function safeScan(code: string): string[] {
  try {
    return transpiler.scanImports(code).map((i) => i.path);
  } catch {
    return [...code.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]!);
  }
}

const done = new Set<string>();
const seenFiles = new Set<string>();
const files: LibraryFile[] = [];
const pending = [...PACKAGES];
while (pending.length) {
  const target = pending.shift()!;
  const key = typeof target === "string" ? target : `${target.spec}\u0000${target.entry}`;
  if (done.has(key)) continue;
  done.add(key);
  const discovered = new Set<string>();
  files.push(...walk(target, discovered, seenFiles));
  for (const dep of discovered) if (!done.has(dep) && FOLLOW.test(dep) && packageDir(packageNameOf(dep))) pending.push(dep);
}

const byPackage = new Map<string, LibraryFile[]>();
for (const file of files) byPackage.set(file.package, [...(byPackage.get(file.package) ?? []), file]);
rmSync(SOURCES, { recursive: true, force: true });
for (const [pkg, list] of byPackage) {
  const fileRules: Record<string, unknown> = {};
  const functionRules: Record<string, unknown> = {};
  for (const file of list) {
    const key = fileKey(file);
    fileRules[key] = {
      data: { package: file.package, version: file.version, file: file.file, entry: file.entry, ...(file.specifier ? { specifier: file.specifier } : {}), ...(file.names ? { names: file.names } : {}) },
      features: file.features,
    };
    const prints = [...file.exports.map((fn) => ["export", fn] as const), ...(file.locals ?? []).map((fn) => ["local", fn] as const)];
    prints.forEach(([kind, fn], i) => {
      functionRules[`${key}#${i}:${fn.name}`] = { data: { name: fn.name, file: key, kind }, features: fn.features, links: fn.links ?? [] };
    });
  }
  const name = `${pkg.replace(/^@/, "").replace(/\//g, "__")}.json`;
  await Bun.write(join(SOURCES, "files", name), `${JSON.stringify(fileRules, null, 1)}\n`);
  await Bun.write(join(SOURCES, "functions", name), `${JSON.stringify(functionRules, null, 1)}\n`);
}
const components = libraryComponents(join(CACHE, "node_modules"));
const componentRules = Object.fromEntries(components.map((c) => [`${c.package}/${c.name}`, { data: c, [COMPONENT_GROUP]: [c.name] }]));
await Bun.write(join(SOURCES, "components.json"), `${JSON.stringify(componentRules, null, 1)}\n`);
const result = build(readRules(join(SOURCES, "files")), FINGERPRINTS_PATH, {
  groups: FILE_GROUPS,
  indexes: {
    [FUNCTION_INDEX]: { rules: readRules(join(SOURCES, "functions")), groups: FUNCTION_GROUPS },
    [COMPONENT_INDEX]: { rules: componentRules, groups: { [COMPONENT_GROUP]: {} } },
  },
  metadata: { dataset: "unbundle library fingerprints", schema: FINGERPRINT_SCHEMA, packages: [...byPackage.keys()].sort() },
});
console.log(`${components.length} library components`);
console.log(`wrote ${files.length} file prints (${(result.size / 1024).toFixed(0)} kB) to ${relative(ROOT, FINGERPRINTS_PATH)}, sources in ${relative(ROOT, SOURCES)}/`);
const icons = buildIcons(join(CACHE, "node_modules"));
console.log(`wrote ${icons.icons} icon shapes (${(icons.size / 1024).toFixed(0)} kB) to icons.sigdb`);
