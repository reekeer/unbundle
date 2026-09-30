import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BASE, identified, runSite, serve, serveDirectory, TIMEOUT } from "./support/e2e.ts";
import { brokenImports, exists, modulePath, read, runOn, unresolvedModules } from "./support/run.ts";

describe("meta-frameworks", () => {
  test(
    "astro: islands are recovered per framework and annotated in --standalone pages",
    async () => {
      const { outDir, manifest } = await runOn(serve("site-astro", { serveMaps: false }).url, { crawlDepth: 1, standalone: true });
      expect(await brokenImports(outDir)).toEqual([]);
      expect(await unresolvedModules(outDir)).toEqual([]);
      expect(manifest.bundler.adapter).toBe("astro");
      expect(manifest.coverage.status).toBe("complete");
      const react = await read(outDir, "src/components/ReactCounter.jsx");
      expect(react).toContain("export default function ReactCounter({ initial })");
      expect(react).toContain("ASTRO_REACT {state}");
      const vue = await read(outDir, "src/components/VueToggle.vue");
      expect(vue).toContain("const open = ref(false);");
      expect(vue).toContain('<button @click="open = !open">{{ props.label }}</button>');
      expect(vue).toContain('<p v-if="open">ASTRO_VUE_OPEN</p>');
      expect(await read(outDir, "src/components/SvelteLikes.js")).toContain("ASTRO_SVELTE");
      const islands = JSON.parse(await read(outDir, ".chunks/html/index.astro.json")) as { islands: Array<{ component: string; props: unknown }> };
      expect(islands.islands.map((i) => i.component)).toEqual(["ReactCounter", "VueToggle", "SvelteLikes"]);
      expect(islands.islands[1]!.props).toEqual({ label: "ASTRO_VUE_LABEL" });
      const standalone = await read(outDir, "html/index.standalone.html");
      expect(standalone).toContain('data-component="ReactCounter"');
      expect(standalone).toContain('data-component-src="src/components/ReactCounter.jsx"');
      expect(standalone).toContain('data-component="VueToggle"');
    },
    TIMEOUT,
  );
});

describe("angular", () => {
  test(
    "components, pipe, service and routes come back as Angular source with templates",
    async () => {
      const { outDir, manifest } = await runOn(serve("site-angular", { serveMaps: false }).url, { crawlDepth: 1 });
      expect(await brokenImports(outDir)).toEqual([]);
      expect(await unresolvedModules(outDir)).toEqual([]);
      expect(manifest.bundler.adapter).toBe("angular");
      for (const pkg of ["@angular/core", "@angular/router"]) expect(manifest.summary.quality.identifiedPackages).toContain(pkg);
      expect(await exists(outDir, "tsconfig.json")).toBe(true);
      expect(await read(outDir, "src/main.ts")).toContain("bootstrapApplication(AppComponent");
      const app = await read(outDir, "src/app/app.component.ts");
      expect(app).toContain('import { RouterOutlet, RouterLink } from "@angular/router";');
      expect(app).toContain('<a routerLink="/about">About</a>');
      expect(app).toContain("<router-outlet />");
      const counter = await read(outDir, "src/app/counter/counter.component.ts");
      expect(counter).toContain('selector: "app-counter"');
      expect(counter).toContain('<button (click)="change(1)" [disabled]="atMax()">+</button>');
      expect(counter).toContain("<span>NG_COUNT {{ count() }}</span>");
      expect(counter).toContain("@if (atMax()) {");
      expect(counter).toContain("export class CounterComponent");
      const todos = await read(outDir, "src/app/todo-list/todo-list.component.ts");
      expect(todos).toContain("@for (todo of service.todos(); track todo.id) {");
      expect(todos).toContain("{{ todo.title | shout }}");
      expect(todos).toContain("} @empty {");
      expect(await read(outDir, "src/app/shout.pipe.ts")).toContain('@Pipe({');
      expect(await read(outDir, "src/app/app.routes.ts")).toContain('import("@/app/about/about.component")');
      expect(await read(outDir, "src/app/about/about.component.ts")).toContain("<h1>NG_ABOUT_TITLE</h1>");
    },
    TIMEOUT,
  );
});
