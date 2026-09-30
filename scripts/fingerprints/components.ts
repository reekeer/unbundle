import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";

export interface LibraryComponent {
  package: string;
  name: string;
  export: string;
  global: boolean;
}

const COMPILED: string[] = ["reka-ui", "@leavepulse/ui", "vaul-vue", "motion-v", "@vue-flow/core", "@vue-flow/background", "@vue-flow/controls", "@vue-flow/minimap"];
const SOURCE: Array<{ package: string; dir: string; prefix: string }> = [
  { package: "@nuxt/ui", dir: "dist/runtime/components", prefix: "U" },
  { package: "@nuxtjs/mdc", dir: "dist/runtime/components/prose", prefix: "" },
  { package: "nuxt", dir: "dist/app/components", prefix: "" },
  { package: "@nuxt/content", dir: "dist/runtime/components", prefix: "" },
  { package: "@nuxtjs/turnstile", dir: "dist/runtime/components", prefix: "" },
  { package: "@nuxtjs/mdc", dir: "dist/runtime/components", prefix: "" },
];

const NAMED: Array<{ package: string; dir: string; prefix: string; name: RegExp }> = [
  { package: "element-plus", dir: "es/components", prefix: "", name: /\bname:\s*["'`](El[A-Z][A-Za-z0-9]*)["'`]/g },
  { package: "vuetify", dir: "lib/components", prefix: "", name: /\bname:\s*["'`](V[A-Z][A-Za-z0-9]*)["'`]/g },
  { package: "naive-ui", dir: "es", prefix: "N", name: /\bname:\s*["'`]([A-Z][A-Za-z0-9]*)["'`]/g },
  { package: "@headlessui/vue", dir: "dist/components", prefix: "", name: /\bname:\s*["'`]([A-Z][A-Za-z0-9]*)["'`]/g },
];

const SCRIPTED: Array<{ package: string; dir: string }> = [
  { package: "@nuxtjs/i18n", dir: "dist/runtime/components" },
  { package: "nuxt", dir: "dist/app/components" },
];

function files(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

function pascalFile(file: string): string {
  return basename(file, ".vue")
    .split(/[-_.]/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join("");
}

export function libraryComponents(modules: string): LibraryComponent[] {
  const out = new Map<string, LibraryComponent>();
  for (const pkg of COMPILED) {
    for (const file of files(join(modules, pkg, "dist")).filter((f) => /\.m?js$/.test(f))) {
      for (const match of readFileSync(file, "utf8").matchAll(pkg.startsWith("@vue-flow/") ? /\b(?:__)?name:\s*["'`]([A-Z][A-Za-z0-9]*)["'`]/g : /__name:\s*["'`]([A-Z][A-Za-z0-9]*)["'`]/g)) {
        out.set(`${pkg}\u0000${match[1]}`, { package: pkg, name: match[1]!, export: match[1]!, global: false });
      }
    }
  }
  for (const source of SOURCE) {
    for (const file of files(join(modules, source.package, source.dir)).filter((f) => f.endsWith(".vue"))) {
      const name = `${source.package === "@nuxt/ui" && file.includes("/prose/") ? "Prose" : source.prefix}${pascalFile(file)}`;
      out.set(`${source.package}\u0000${name}`, { package: source.package, name, export: name, global: true });
    }
  }
  for (const source of NAMED) {
    for (const file of files(join(modules, source.package, source.dir)).filter((f) => /\.m?js$/.test(f) && !/\.d\./.test(f))) {
      for (const match of readFileSync(file, "utf8").matchAll(source.name)) {
        const name = `${source.prefix}${match[1]}`;
        if (!out.has(`${source.package}\u0000${name}`)) out.set(`${source.package}\u0000${name}`, { package: source.package, name, export: name, global: false });
      }
    }
  }
  for (const source of SCRIPTED) {
    for (const file of files(join(modules, source.package, source.dir)).filter((f) => /\.m?js$/.test(f) && !/\.d\.|index\.m?js$|\.server\.m?js$/.test(f))) {
      const declared = /\bname:\s*["'`]([A-Z][A-Za-z0-9]*)["'`]/.exec(readFileSync(file, "utf8"))?.[1];
      const name = declared ?? pascalFile(basename(file).replace(/\.(client\.)?m?js$/, ""));
      if (!/^[A-Z][A-Za-z0-9]*$/.test(name) || out.has(`${source.package}\u0000${name}`)) continue;
      out.set(`${source.package}\u0000${name}`, { package: source.package, name, export: name, global: true });
    }
  }
  return [...out.values()];
}
