import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { angularSourceCode } from "../src/refine/angular.ts";
import { dedupeExports } from "../src/refine/exports.ts";
import { withFingerprints, entryExports } from "../src/refine/fingerprint.ts";
import { packagePrints } from "../src/refine/learn.ts";
import { ModuleGraph } from "../src/refine/module-graph.ts";
import { organizeModules } from "../src/refine/organize.ts";
import { OutputTree } from "../src/output.ts";
import { TIMEOUT } from "./support/e2e.ts";
import { runOn } from "./support/run.ts";

describe("recovery across modules", () => {
  test("Ivy aliases follow reexports and repeated Unicode exports are removed", () => {
    const tree = new OutputTree();
    const add = (path: string, content: string) => tree.add({ path, content, kind: "module", renamable: false });
    add("src/instructions.js", 'export { ɵɵdomElement as a, ɵɵtext as b } from "@angular/core";');
    const app = add("src/component.ts", `
      import { a as x } from "./instructions";
      import { ɵɵdefineComponent as y } from "@angular/core";
      export class Widget {
        static ɵcmp = y({ selectors: [["app-widget"]], template: function (flags, self) {
          if (flags & 1) { x(0, "hr"); }
        }});
      }
    `);
    add("vendor/core.js", "export function ɵɵtext() {} export { ɵɵtext };");
    expect(dedupeExports(tree)).toBe(1);
    const graph = new ModuleGraph(tree.all());
    expect(graph.issues()).toEqual([]);
    expect(angularSourceCode(app.content, graph.angularImports(app.path))).toContain("<hr />");
  });

  test("two components with the same selector retain their own exports", () => {
    const tree = new OutputTree();
    const add = (path: string, content: string) => tree.add({ path, content, kind: "module", renamable: false });
    const files = ["a", "b"].map((id) => add(`js/${id}.js`, `
      var x = class { title = "${id}"; static ɵcmp = define({ selectors: [["app-widget"]], template: function () {} }); };
      export { x as ${id} };
    `));
    add("js/start.js", 'import { a as First } from "./a.js"; import { b as Second } from "./b.js"; console.log(new First(), new Second());');
    const modules = files.map((file, id) => ({ id: String(id), namespace: "esm", localPath: file.path, name: file.path, group: "app" as const, chunkUrl: "", deps: [] }));
    organizeModules(tree, modules, new Set());
    expect(new ModuleGraph(tree.all()).issues()).toEqual([]);
    const paths = tree.all().map((file) => file.path);
    expect(paths).toContain("js/app/widget/widget.component.js");
    expect(paths).toContain("js/app/widget/widget.component~2.js");
  });

  test("Ivy projection slots and two-way bindings survive vendored aliases", () => {
    const tree = new OutputTree();
    const add = (path: string, content: string) => tree.add({ path, content, kind: "module", renamable: false });
    add("vendor/@angular/core/chunk.js", `
      export function p(name, value, sanitizer) {
        if (writable(value)) value = value();
        const view = getView();
        const index = nextBinding();
        if (changed(view, index, value)) {
          setPropertyAndInputs(selectedNode(), view, name, value, view.renderer, sanitizer);
        }
        return p;
      }
    `);
    add("src/defs.js", 'export { p as bind } from "../vendor/@angular/core/chunk.js"; export const names = ["[slot=title]", "*"];');
    const app = add("src/widget.ts", `
      import { bind, names } from "./defs";
      import { ɵɵdefineComponent, ɵɵprojectionDef, ɵɵprojection, ɵɵelement, ɵɵadvance, ɵɵtwoWayListener, ɵɵtwoWayBindingSet } from "@angular/core";
      export class Widget {
        static ɵcmp = ɵɵdefineComponent({
          selectors: [["app-widget"]],
          ngContentSelectors: names,
          template: function (flags, ctx) {
            if (flags & 1) {
              ɵɵprojectionDef([[["", "slot", "title"]], "*"]);
              ɵɵprojection(0);
              ɵɵelement(1, "input");
              ɵɵtwoWayListener("ngModelChange", function (event) {
                if (!ɵɵtwoWayBindingSet(ctx.value, event)) ctx.value = event;
                return event;
              });
              ɵɵprojection(2, 1);
            }
            if (flags & 2) {
              ɵɵadvance();
              bind("ngModel", ctx.value);
            }
          }
        });
      }
    `);
    const graph = new ModuleGraph(tree.all());
    const source = angularSourceCode(app.content, graph.angularImports(app.path), undefined, (name) => graph.projectionSelectors(app.path, name));
    expect(source).toContain('<ng-content select="[slot=title]"></ng-content>');
    expect(source).toContain('<input [(ngModel)]="value" />');
    expect(source).toContain("<ng-content></ng-content>");
  });

  test("published archives can add exports to an existing fingerprint database", async () => {
    const base = { version: 1, files: [] };
    const name = "fixture-signatures";
    expect(entryExports(base, name).size).toBe(0);
    const version = "1.0.0";
    const archive = new Bun.Archive({
      "package/package.json": JSON.stringify({ name, version, exports: { ".": { import: "./index.mjs" } } }),
      "package/index.mjs": 'export function formatLabel(value) { return value.trim().toUpperCase(); }',
    }, { compress: "gzip" });
    const prints = await packagePrints(await archive.bytes(), name, version);
    expect(entryExports(withFingerprints(base, prints), name)).toEqual(new Set(["formatLabel"]));
    expect(entryExports(base, name).size).toBe(0);
    const newer = prints.map((file) => ({ ...file, version: "2.0.0", names: ["formatTitle"], exports: [] }));
    const combined = withFingerprints(withFingerprints(base, prints), newer);
    expect(entryExports(combined, name)).toEqual(new Set(["formatTitle"]));
    expect(entryExports(combined, name, false, version)).toEqual(new Set(["formatLabel"]));
  });
});

describe("local preview", () => {
  test("a generic site's edited recovered JavaScript is served after reload", async () => {
    const icon = new Uint8Array([0, 128, 255, 10]);
    const fixture = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/") return new Response('<html><body><app-root></app-root><img src="/icon.png"><script src="/main-ABCDEFGH.js"></script></body></html>', { headers: { "content-type": "text/html" } });
        if (url.pathname === "/main-ABCDEFGH.js") return new Response('document.querySelector("app-root").textContent = "preview-before";', { headers: { "content-type": "text/javascript" } });
        if (url.pathname === "/icon.png") return new Response(icon, { headers: { "content-type": "image/png" } });
        return new Response(null, { status: 404 });
      },
    });
    try {
      const { outDir, manifest } = await runOn(fixture.url.href, { crawlDepth: 0, sourceMaps: false });
      expect(manifest.bundler.adapter).toBeNull();
      expect(manifest.preview?.mode).toBe("static");
      expect(manifest.preview?.routes).toContainEqual(["/", "preview/index.html", "text/html; charset=utf-8"]);
      const pkg = await Bun.file(join(outDir, "package.json")).json();
      expect(pkg.scripts.start).toBe("node .unbundle/start.mjs");
      const process = Bun.spawn(["node", ".unbundle/start.mjs"], { cwd: outDir, env: { PORT: "0", PATH: Bun.env.PATH }, stdout: "pipe", stderr: "inherit" });
      try {
        const output = new TextDecoder().decode((await process.stdout.getReader().read()).value);
        const url = /http:\/\/127\.0\.0\.1:\d+/.exec(output)?.[0];
        expect(url).toBeDefined();
        expect(await (await fetch(url!)).text()).toContain("app-root");
        expect(new Uint8Array(await (await fetch(`${url}/icon.png`)).arrayBuffer())).toEqual(icon);
        const scriptUrl = `${url}/main-ABCDEFGH.js`;
        const root = { textContent: "" };
        const document = { querySelector: () => root };
        const runScript = async () => runInNewContext(await (await fetch(scriptUrl)).text(), { document });
        await runScript();
        expect(root.textContent).toBe("preview-before");
        const edited = Bun.file(join(outDir, manifest.preview!.editable));
        await Bun.write(edited, (await edited.text()).replace("preview-before", "preview-after"));
        await runScript();
        expect(root.textContent).toBe("preview-after");
      } finally {
        process.kill();
        await process.exited;
      }
    } finally {
      fixture.stop();
    }
  }, TIMEOUT);
});
