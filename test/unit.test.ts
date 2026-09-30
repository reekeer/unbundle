import { describe, expect, test } from "bun:test";
import { flightOf, normalizeNextSource } from "../src/adapters/next.ts";
import { CookieJar } from "../src/browser/browser.ts";
import { scanLoaders } from "../src/browser/coverage.ts";
import { htmlResources, linkHeaderResources, scriptResources, styleResources } from "../src/browser/discover.ts";
import { Layout, OutputTree, resolveInside, safeRelativePath, writeTree } from "../src/output.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tightenText } from "../src/refine/format.ts";
import { quoteAttributes } from "../src/refine/astro.ts";
import { extractLocaleDictionaries } from "../src/refine/localize.ts";
import { inScope, routeCandidates } from "../src/pipeline.ts";
import { behaviorNames, classifyString, isDataOnlyScript, suggestModuleNames } from "../src/refine/analyze.ts";
import { finalizeModule, importPackageFunctions, normalizeExports, outlineIifes, renameExports, trivialModule } from "../src/refine/cleanup.ts";
import { buildFunctionIndex, hasForeignExport, identifyModule, idiomPrints, loadFingerprints, matchFunctions, matchLocals, packageFeatureSet, printModule } from "../src/refine/fingerprint.ts";
import { deminifyCode } from "../src/refine/deminify.ts";
import { analyzeIcons, iconName, replaceIcons } from "../src/refine/icons.ts";
import { organizeModules } from "../src/refine/organize.ts";
import { adoptVendorAliases, publishReadableExports, tidyExports } from "../src/refine/exports.ts";
import { detectTypeScript, projectLayout } from "../src/layout.ts";
import { absorbLoneClient, absorbShared, nameStoreFiles } from "../src/refine/absorb.ts";
import { readablePage } from "../src/refine/html.ts";
import { usageRenames } from "../src/refine/usage.ts";
import { preloadDeps } from "../src/adapters/vite.ts";
import { nameCryptoCode, scanCrypto } from "../src/refine/crypto.ts";
import { scanServices } from "../src/refine/services.ts";
import { constantNames } from "../src/refine/analyze.ts";
import { splitHoisted } from "../src/unpack/hoisted.ts";
import vite from "../src/adapters/vite.ts";
import { bindingViolations, renameIdentifiers, snapshotBindings } from "../src/refine/rename.ts";
import { parseProgram, t } from "../src/unpack/ast.ts";
import { refineAll } from "../src/refine/worker.ts";
import { unpackTurbopackChunk } from "../src/unpack/turbopack.ts";
import { findEnsureChunkIds, readChunkUrlTemplates, unpackWebpackChunk } from "../src/unpack/webpack.ts";
import { lazyRequireTarget, unpackEsmChunk, unpackWrappedBundle } from "../src/unpack/wrappers.ts";

describe("paths", () => {
  test("never escapes the output directory", () => {
    expect(safeRelativePath("../../etc/passwd")).toBe("etc/passwd");
    expect(safeRelativePath("/a/./b/../c")).toBe("a/c");
    expect(safeRelativePath("..%2F..%2Fx").split("/")).not.toContain("..");
    expect(() => resolveInside("/tmp/out", "../escape")).toThrow();
  });

  test("lays files out as html, css, js and raw .chunks", () => {
    const layout = new Layout(new URL("https://h.test/t/tttt"), "/t/tttt", "/t/tttt/_next/static/");
    expect(layout.page(new URL("https://h.test/t/tttt"))).toBe("html/index.html");
    expect(layout.page(new URL("https://h.test/t/tttt/about/"))).toBe("html/about.html");
    expect(layout.pageData(new URL("https://h.test/t/tttt/about/"), "rsc.txt")).toBe("html/about.rsc.txt");
    expect(layout.style("https://h.test/t/tttt/_next/static/css/a.css")).toBe("css/a.css");
    expect(layout.script("https://h.test/t/tttt/_next/static/chunks/webpack-1.js")).toBe("js/scripts/webpack-1.js");
    expect(layout.script("https://cdn.test/x.js")).toBe("js/scripts/_external/cdn.test/x.js");
    expect(layout.raw("https://h.test/t/tttt/_next/static/chunks/app/page-1.js")).toBe(".chunks/_next/static/chunks/app/page-1.js");
    expect(layout.source("components/Counter.jsx")).toBe("js/components/Counter.jsx");
    expect(layout.module("app", "HomePage")).toBe("js/HomePage.js");
    expect(layout.module("library", "parsePath")).toBe("js/node_modules/parsePath.js");
    expect(layout.packageFile("react/index.js")).toBe("js/node_modules/react/index.js");
  });

  test("output tree resolves file/directory collisions", () => {
    const tree = new OutputTree();
    tree.add({ path: "a", content: "1", kind: "script", renamable: false });
    const nested = tree.add({ path: "a/b.js", content: "2", kind: "script", renamable: false });
    expect(nested.path).not.toBe("a/b.js");
  });

  test("normalizes bundler source prefixes", () => {
    expect(normalizeNextSource("webpack://_N_E/./components/Counter.jsx")).toBe("components/Counter.jsx");
    expect(normalizeNextSource("turbopack:///[project]/lib/math.js")).toBe("lib/math.js");
    expect(normalizeNextSource("turbopack:///[turbopack]/shared/runtime.ts")).toBe("_turbopack/shared/runtime.ts");
  });
});

describe("crawl scope", () => {
  test("stays inside the base path", () => {
    const origin = new URL("https://h.test/t/tttt");
    expect(inScope(new URL("https://h.test/t/tttt/about"), origin, "/t/tttt")).toBe(true);
    expect(inScope(new URL("https://h.test/t/tttttt"), origin, "/t/tttt")).toBe(false);
    expect(inScope(new URL("https://h.test/other"), origin, "/t/tttt")).toBe(false);
    expect(inScope(new URL("https://evil.test/t/tttt/x"), origin, "/t/tttt")).toBe(false);
  });
});

describe("routes from code", () => {
  test("finds navigations, skips assets, dynamic segments and risky endpoints", () => {
    const code = `router.push("/settings");l("/about/");q="/index";r="/a/b";x="/api/users";y="/logout";z="/img/a.png";w="/blog/[slug]";v="/_app";u="//cdn.x/a";t="/t/tttt/docs"`;
    const origin = new URL("https://h.test/t/tttt");
    expect(routeCandidates(code, origin, "/t/tttt").map((u) => u.pathname)).toEqual(["/t/tttt/settings", "/t/tttt/about/", "/t/tttt/docs"]);
  });
});

describe("webpack runtime", () => {
  test("evaluates chunk url templates without executing code", () => {
    const code = `(()=>{var s={};s.u=e=>"static/chunks/"+({12:"about"}[e]||e)+"."+{12:"aa11",34:"bb22"}[e]+".js",s.miniCssF=e=>"static/css/"+{34:"cc33"}[e]+".css";s.e(34)})()`;
    const templates = readChunkUrlTemplates(code)!;
    expect(templates.script?.("12")).toBe("static/chunks/about.aa11.js");
    expect(templates.script?.("34")).toBe("static/chunks/34.bb22.js");
    expect(templates.style?.("34")).toBe("static/css/cc33.css");
    expect(templates.knownIds.sort()).toEqual(["12", "34"]);
    expect(findEnsureChunkIds(code)).toEqual(["34"]);
  });

  test("ignores hostile templates", () => {
    const templates = readChunkUrlTemplates(`s.u=e=>(globalThis.pwned=1,fetch("x"))`);
    expect(templates?.script?.("1")).toBeUndefined();
    expect((globalThis as Record<string, unknown>).pwned).toBeUndefined();
  });
});

describe("format zoo: every known chunk shape parses, unknown ones degrade loudly", () => {
  const webpack = (code: string) => unpackWebpackChunk(code, "x")!;
  const turbo = (code: string) => unpackTurbopackChunk(code, "x")!;

  test("webpack 5 object map", () => {
    const r = webpack(`(self.webpackChunk_app=self.webpackChunk_app||[]).push([[1],{7:(e,t,r)=>{r.d(t,{a:()=>1})},8:function(e){e.exports=2}}]);`);
    expect(r.diagnostics).toMatchObject({ level: "full", shape: "webpack5-jsonp", recognized: 2 });
  });

  test("webpack 4 legacy jsonp with array map and entries", () => {
    const r = webpack(`(window.webpackJsonp=window.webpackJsonp||[]).push([[0],[function(e,t,n){n(1)},function(e,t){e.exports=1}],[[0,1]]]);`);
    expect(r.diagnostics).toMatchObject({ level: "full", shape: "webpack4-jsonp+entries+array", recognized: 2 });
    expect(r.modules[0]!.deps).toEqual(["1"]);
  });

  test("module values given by reference are still recognized", () => {
    const r = webpack(`function m(e,t,r){r.d(t,{x:()=>1})}(self.webpackChunk_a=self.webpackChunk_a||[]).push([[2],{5:m}]);`);
    expect(r.diagnostics.level).toBe("full");
    expect(r.modules.map((m) => m.id)).toEqual(["5"]);
  });

  test("an unexpected module value makes the chunk partial with a reason", () => {
    const r = webpack(`(self.webpackChunk_a=self.webpackChunk_a||[]).push([[3],{1:(e)=>{e.exports=1},2:someFactory()}]);`);
    expect(r.diagnostics.level).toBe("partial");
    expect(r.diagnostics.skipped).toEqual([{ id: "2", reason: "module value is CallExpression" }]);
  });

  test("an unknown payload shape is raw, not a silent miss", () => {
    const r = webpack(`(self.webpackChunk_a=self.webpackChunk_a||[]).push({ids:[1],modules:{}});`);
    expect(r.diagnostics.level).toBe("raw");
    expect(r.diagnostics.notes[0]).toContain("unknown webpackChunk_a.push payload");
  });

  test("a runtime that only defines the global is not a chunk", () => {
    expect(unpackWebpackChunk(`(()=>{var e=self.webpackChunk_a=self.webpackChunk_a||[];e.forEach(x=>x)})()`, "x")).toBeNull();
  });

  test("turbopack flat, object and runtime shapes", () => {
    expect(turbo(`(globalThis.TURBOPACK||(globalThis.TURBOPACK=[])).push([document.currentScript,1,t=>{t.s(["a",0,1])}]);`).diagnostics).toMatchObject({ level: "full", shape: "turbopack-flat" });
    expect(turbo(`(globalThis.TURBOPACK=globalThis.TURBOPACK||[]).push(["static/chunks/a.js",{"[project]/a.js":(t)=>{t.s(["a",0,1])}}]);`).diagnostics).toMatchObject({ level: "full", shape: "turbopack-object" });
    expect(turbo(`(globalThis.TURBOPACK||(globalThis.TURBOPACK=[])).push([document.currentScript,{otherChunks:["a.js"],runtimeModuleIds:[1]}]);`).diagnostics).toMatchObject({ level: "full", shape: "turbopack-runtime" });
  });

  test("turbopack drift is reported", () => {
    const r = turbo(`(globalThis.TURBOPACK||(globalThis.TURBOPACK=[])).push([document.currentScript,5,t=>{},6,[1,2]]);`);
    expect(r.diagnostics.level).toBe("partial");
    expect(r.diagnostics.skipped[0]).toEqual({ id: "6", reason: "unexpected ArrayExpression in TURBOPACK.push" });
    expect(turbo(`globalThis.TURBOPACK.push("weird")`).diagnostics.level).toBe("raw");
  });

  test("webpack 4 chunk url function without __webpack_require__.u", () => {
    const templates = readChunkUrlTemplates(`!function(e){function a(e){return c.p+"static/js/"+({}[e]||e)+"."+{3:"ab12"}[e]+".chunk.js"}var c={};c.p="/"}()`);
    expect(templates?.script?.("3")).toBe("static/js/3.ab12.chunk.js");
  });
});

describe("commonjs wrappers and ES module chunks", () => {
  test("esbuild __commonJS modules become separate modules, callers import them", () => {
    const code = `import{a as w,b as toESM}from"./chunk-AAAAAAAA.js";var lib=w(ex=>{ex.hello=function(){return "HELLO"}});var other=w((ex,mod)=>{mod.exports={v:1}});var x=toESM(lib());console.log((0,x.hello)(),other().v);`;
    const result = unpackWrappedBundle(code, "http://h/assets/main-BBBBBBBB.js", "esbuild")!;
    expect(result.diagnostics).toMatchObject({ level: "full", containers: 2 });
    const entry = result.modules.find((m) => m.id === "main-BBBBBBBB")!;
    expect(entry.origin).toBe("bundle");
    expect(entry.code).toContain('import * as libModule from "./main-BBBBBBBB~lib.js"');
    expect(entry.deps.sort()).toEqual(["chunk-AAAAAAAA", "main-BBBBBBBB~lib", "main-BBBBBBBB~other"]);
    expect(result.modules.find((m) => m.id === "main-BBBBBBBB~lib")!.code).toContain("exports.hello");
  });

  test("webpack .cw wrappers inside the runtime IIFE, (module, exports) order", () => {
    const code = `(()=>{var e={};function n(r){}n.cw=e=>()=>{};var r=n.cw(function(e,t){e.exports={k:1}}),o=n.cw(function(e,t){t.z=r().k});console.log(o().z)})();`;
    const result = unpackWrappedBundle(code, "http://h/static/js/main.12345678.js", "webpack")!;
    expect(result.modules.map((m) => m.id).sort()).toEqual(["main.12345678", "main.12345678~o", "main.12345678~r", "main.12345678~runtime"]);
    expect(result.modules.find((m) => m.id === "main.12345678~runtime")).toMatchObject({ origin: "library", nameHint: "webpack-runtime" });
    expect(result.modules.find((m) => m.id === "main.12345678")!.code).toContain('import { __webpack_require__ as n } from "./main.12345678~runtime.js"');
    expect(result.modules.find((m) => m.id === "main.12345678~o")!.code).toContain("exports.z");
  });

  test("lazy require forms: bind and arrow", () => {
    const parse = (code: string) => ((parseProgram(code).program.body[0] as t.ExpressionStatement).expression as t.CallExpression);
    expect(lazyRequireTarget(parse("n.e(462).then(n.bind(n, 462))"))).toBe("462");
    expect(lazyRequireTarget(parse("n.e(462).then(() => n(462))"))).toBe("462");
    expect(lazyRequireTarget(parse("Promise.all([n.e(1)]).then(n.t.bind(n, 9, 23))"))).toBe("9");
    expect(lazyRequireTarget(parse("x.then(() => y(1))"))).toBeNull();
  });

  test("vite: rolldown __commonJS wrappers are split out of the entry chunk", () => {
    const code = `var s=(e,t)=>()=>(t||(e((t={exports:{}}).exports,t),e=null),t.exports);var f=s(e=>{e.useState=function(){return 1}}),g=s((e,t)=>{t.exports=f()});import"./x-ABCDEFGH.js";var S=g();console.log(S.useState());`;
    const result = vite.parseChunk!({ ref: { url: "http://h/assets/index-XXXXXXXX.js", type: "module" }, body: code } as never)!;
    expect(result.modules.map((m) => m.id).sort()).toEqual(["index-XXXXXXXX", "index-XXXXXXXX~f", "index-XXXXXXXX~g"]);
    expect(result.modules.find((m) => m.id === "index-XXXXXXXX")!.origin).toBe("bundle");
  });

  test("ES module chunks keep their relative imports as dependencies", () => {
    const result = unpackEsmChunk(`import{a}from"./vendor-ABCDEFGH.js";export const b=a+1;import("./lazy-12345678.js");`, "http://h/assets/index-XXXXXXXX.js", "vite")!;
    expect(result.modules[0]).toMatchObject({ id: "index-XXXXXXXX", origin: "bundle" });
    expect(result.modules[0]!.deps.sort()).toEqual(["lazy-12345678", "vendor-ABCDEFGH"]);
  });
});

describe("module namespaces", () => {
  test("webpack modules carry their build's chunk global", () => {
    const a = unpackWebpackChunk(`(self.webpackChunk_N_E=self.webpackChunk_N_E||[]).push([[1],{7:(e,t,r)=>{r.d(t,{a:()=>1})}}]);`, "a")!;
    const b = unpackWebpackChunk(`(self.webpackChunk_shop=self.webpackChunk_shop||[]).push([[1],{7:(e,t,r)=>{r.d(t,{b:()=>2})}}]);`, "b")!;
    expect(a.modules[0]!.namespace).toBe("webpackChunk_N_E");
    expect(b.modules[0]!.namespace).toBe("webpackChunk_shop");
  });
});

describe("refine worker pool", () => {
  test("returns results in job order across workers", async () => {
    const jobs = ["var a=!0;", "b&&c();", "(0,d)(1);"].map((code, id) => ({ id, code, webcrack: false, rename: false }));
    const pooled = await refineAll(jobs, 2, () => {});
    expect(pooled.map((r) => r.id)).toEqual([0, 1, 2]);
    expect(pooled[0]!.code).toBe("var a=!0;");
  }, 60_000);

  test("a stuck worker job is redone on the main thread", async () => {
    const slow = await refineAll([{ id: 0, code: "x();", webcrack: true, rename: true }, { id: 1, code: "y();", webcrack: true, rename: true }], 2, () => {}, 1);
    expect(slow.map((r) => r.id)).toEqual([0, 1]);
    expect(slow.every((r) => r.warnings.some((w) => w.stage === "worker" && w.message.includes("timed out")))).toBe(true);
  }, 120_000);
});

describe("turbopack", () => {
  test("parses value, getter and setter bindings of esmExport", () => {
    const code = `(globalThis.TURBOPACK||(globalThis.TURBOPACK=[])).push(["x.js",1,t=>{"use strict";let a=1;function b(){}t.s(["a",()=>a,n=>{a=n},"b",0,b,"c",()=>b])},2,3,t=>{t.v(n=>Promise.all(["static/chunks/z.js"].map(n=>t.l(n))).then(()=>n(1)))}]);`;
    const result = unpackTurbopackChunk(code, "x")!;
    const mod = result.modules.find((m) => m.id === "1")!.code;
    expect(mod).toContain("export let a = 1");
    expect(mod).toContain("export { b as c }");
    expect(result.modules.find((m) => m.id === "2")!.code).toContain('export * from "./1.js"');
    expect(result.modules.find((m) => m.id === "3")!.code).toContain('export * from "./2.js"');
  });
});

describe("deminify", () => {
  test("expands compressed control flow", () => {
    const out = deminifyCode("function f(e){return a(),1===e?(g(),!0):!1}x&&y(),k?l():m();");
    expect(out).toContain("if (e === 1)");
    expect(out).toContain("return true");
    expect(out).toContain("if (x) {");
    expect(out).toContain("} else {");
    expect(out).not.toContain("!0");
  });

  test("unwraps (0, x.f)() only for module objects", () => {
    const out = deminifyCode("var m=r(12);(0,m.f)(1);(0,obj.g)(2);(0,h)(3);");
    expect(out).toContain("m.f(1)");
    expect(out).toContain("(0, obj.g)(2)");
    expect(out).toContain("h(3)");
  });

  test("keeps shadowed undefined", () => {
    expect(deminifyCode("function f(undefined){return void 0}")).toContain("void 0");
  });
});

describe("heuristic rename", () => {
  test("names hook state, callbacks and errors", () => {
    const { code } = renameIdentifiers(
      `import * as n from "./r.js";export default function a(){let[e,t]=n.useState([]);try{x()}catch(r){console.log(r)}return e.map(o=>o.id)}`,
    );
    expect(code).toContain("[items, setItems]");
    expect(code).toContain("catch (error)");
    expect(code).toContain("items.map(item => item.id)");
    expect(code).toContain("import * as React");
  });

  test("never shadows existing names", () => {
    const { code } = renameIdentifiers(`let items=1;function f(){let[e,t]=useState([]);return items+e}`);
    expect(code).toContain("items + items2");
  });

  test("parameters take the names of call-site arguments, results of normalize* calls are named", () => {
    const { code } = renameIdentifiers(`function h(e){return e.split(":")[0]}function l(e){const t=normalizeHost(e);return t}export function go(){return h(location.hostname)+l(location.host)}`);
    expect(code).toContain("function h(hostname)");
    expect(code).toContain("function l(host)");
    expect(code).toContain("const normalizedHost = normalizeHost(host)");
  });

  test("module state compared with a readable value, flags, optional callbacks", () => {
    const { code } = renameIdentifiers(`var d="";export function f(){const href=location.href;if(href!==d){d=href}}export function g(n){let e=!1;const o=()=>{e||(e=!0,n?.())};o()}`);
    expect(code).toContain("var lastHref");
    expect(code).toContain("let done = ");
    expect(code).toContain("function g(callback)");
  });

  test("components picked from an object map get PascalCase names", () => {
    const { code } = renameIdentifiers(`function a(){return <div/>}function b(){return <p/>}export function Page({tab}){const _={overview:a,profile:b}[tab];return <_/>}`);
    expect(code).toContain("function Overview()");
    expect(code).toContain("function Profile()");
  });

  test("constants named by durations, comparisons, timers and allowed lists", () => {
    const names = constantNames(`var Za=31557600000,Qa=50,u=700,d=["a_click","b_click"];export function f(c,goal){setTimeout(()=>{},u);return Date.now()-c.at>=Za&&Number(c?.total_votes||0)>=Qa&&d.includes(goal)}`);
    expect(Object.fromEntries(names)).toMatchObject({ Za: "ONE_YEAR_MS", Qa: "MIN_TOTAL_VOTES", u: "DELAY", d: "ALLOWED_GOALS" });
  });
});

describe("rsc payload", () => {
  test("extracts client references and build id", () => {
    const row = '1:I[1493,["974","static/chunks/app/page-x.js"],"default"]\n0:{"b":"BUILD"}\n:HL["/_next/static/css/a.css","style"]\n';
    const html = `<script>self.__next_f.push([1,${JSON.stringify(row)}])</script>`;
    const flight = flightOf(html);
    expect(flight.buildId).toBe("BUILD");
    expect(flight.styles).toEqual(["/_next/static/css/a.css"]);
    expect(flight.references[0]).toEqual({ moduleId: "1493", exportName: "default", chunkIds: ["974"], chunkPaths: ["static/chunks/app/page-x.js"] });
  });
});

describe("browser emulation", () => {
  const page = (html: string, headers: Record<string, string> = {}) => ({
    requestedUrl: new URL("https://h.test/t/app"),
    url: new URL("https://h.test/t/app"),
    baseUrl: new URL("https://h.test/t/app"),
    status: 200,
    headers: new Headers(headers),
    html,
  });

  test("finds what the HTML parser and preload scanner would request", () => {
    const refs = htmlResources(
      page(
        `<script type="module" src="./m.js"></script><script src="/c.js" nomodule></script><link rel="modulepreload" href="x/p.js">` +
          `<link rel="stylesheet" href="s.css"><link rel="manifest" href="/site.webmanifest"><script type="application/ld+json">{}</script>` +
          `<script type="module">import "./inline-dep.js"</script>`,
        { link: '</h.js>; rel=preload; as=script, </f.woff2>; rel=preload; as=font' },
      ),
    );
    const byUrl = Object.fromEntries(refs.map((r) => [r.url, r.type]));
    expect(byUrl).toEqual({
      "https://h.test/t/m.js": "module",
      "https://h.test/c.js": "script",
      "https://h.test/t/x/p.js": "module",
      "https://h.test/t/s.css": "style",
      "https://h.test/site.webmanifest": "manifest",
      "https://h.test/t/inline-dep.js": "module",
      "https://h.test/h.js": "script",
    });
  });

  test("follows the ES module graph, workers and css imports", () => {
    const refs = scriptResources(
      `import a from "./a.js";export * from "../b.js";const c=()=>import("./c.js");import x from "react";new Worker(new URL("./w.js", import.meta.url));navigator.serviceWorker.register("/sw.js")`,
      "https://h.test/assets/main.js",
      true,
    ).map((r) => `${r.type} ${r.url}`);
    expect(refs).toEqual([
      "module https://h.test/assets/a.js",
      "module https://h.test/b.js",
      "module https://h.test/assets/c.js",
      "worker https://h.test/assets/w.js",
      "worker https://h.test/sw.js",
    ]);
    expect(styleResources(`@import url("base.css");@import './t.css' screen;`, "https://h.test/s/main.css").map((r) => r.url)).toEqual([
      "https://h.test/s/base.css",
      "https://h.test/s/t.css",
    ]);
    expect(linkHeaderResources(new Headers({ link: "</m.js>; rel=modulepreload" }), new URL("https://h.test/")).map((r) => r.type)).toEqual(["module"]);
  });

  test("cookie jar keeps scope, expiry and SameSite", () => {
    const jar = new CookieJar();
    const url = new URL("https://h.test/t/app");
    jar.store(url, ["sid=1; Path=/; HttpOnly", "lax=2; Path=/t", "none=3; SameSite=None; Secure", "old=4; Max-Age=0", "evil=5; Domain=other.test"]);
    expect(jar.header(new URL("https://h.test/t/x.js"), false)).toBe("lax=2; none=3; sid=1");
    expect(jar.header(new URL("https://h.test/other.js"), false)).toBe("sid=1");
    expect(jar.header(new URL("https://h.test/t/x.js"), true)).toBe("none=3");
    expect(jar.header(new URL("https://other.test/"), false)).toBeNull();
  });
});

describe("cleanup: bundler boilerplate -> plain modules", () => {
  test("CommonJS/TypeScript exports become ES exports with real names", () => {
    const before = `Object.defineProperty(exports, "__esModule", { value: true });
Object.defineProperty(exports, "normalizePath", { enumerable: true, get: function () { return l; } });
let l = (e) => e.replace(/\\/$/, "");
exports.VERSION = "1.0";
if ((typeof exports.default == "function" || (typeof exports.default == "object" && exports.default !== null)) && exports.default.__esModule === undefined) { module.exports = exports.default; }`;
    const after = normalizeExports(before);
    expect(after).toContain("export let normalizePath = e =>");
    expect(after).toContain('export const VERSION = "1.0"');
    expect(after).not.toContain("__esModule");
    expect(after).not.toContain("defineProperty");
  });

  test("multi-export loops and helper calls are unrolled", () => {
    const loop = normalizeExports(`var n = { default: function () { return Link; }, useLinkStatus: function () { return s; } };
for (var key in n) Object.defineProperty(exports, key, { enumerable: true, get: n[key] });
function Link() {} function s() {}`);
    expect(loop).toContain("export default function Link()");
    expect(loop).toContain("export function useLinkStatus()");
    const helper = normalizeExports(`function _e(e, t) { for (var n in t) Object.defineProperty(e, n, { enumerable: true, get: t[n] }); }
_e(exports, { a: function () { return x; } }); const x = 1;`);
    expect(helper).not.toContain("_e(");
    expect(helper).toContain("export const a = 1");
  });

  test("interop requires become imports, namespaces become named imports", () => {
    const normalized = normalizeExports(`import * as h from "./9.js";
require("./1.js");
let c = h._(require("./2.js"));
export function f() { return c.useState(0) + c.default.version; }`);
    const specifiers: Record<string, string> = { "1": "./polyfill.js", "2": "react", "9": "./interop.js" };
    const out = finalizeModule(normalized, { specifierFor: (id) => specifiers[id] ?? null, defaultNameFor: (s) => (s === "react" ? "React" : null) });
    expect(out).toContain('import "./polyfill.js";');
    expect(out).toContain('import React, { useState } from "react";');
    expect(out).toContain("return useState(0) + React.version;");
    expect(out).not.toContain("interop.js");
  });

  test("namespace member aliases and JSX members collapse, fragments shorten", () => {
    const out = finalizeModule(
      `import * as ns from "./5.js";
import * as rt from "./6.js";
let createFromFetch = ns.createFromFetch;
export function A() { return <rt.Fragment><p>{createFromFetch()}</p></rt.Fragment>; }`,
      { specifierFor: (id) => (id === "5" ? "./client.js" : id === "6" ? "react/jsx-runtime" : null) },
    );
    expect(out).toContain('import { createFromFetch } from "./client.js";');
    expect(out).toContain("<><p>{createFromFetch()}</p></>");
    expect(out).not.toContain("jsx-runtime");
  });

  test("wrapper modules are detected so they can be folded", () => {
    expect(trivialModule(`export * from "./12.js";`)).toEqual({ kind: "alias", target: "12" });
    expect(trivialModule(`import("./7875.js");`)).toEqual({ kind: "stub", targets: ["7875"] });
    expect(trivialModule(`import "./1.js";\nimport "./2.js";`)).toEqual({ kind: "stub", targets: ["1", "2"] });
    expect(trivialModule(``)).toEqual({ kind: "stub", targets: [] });
    expect(trivialModule(`export const a = 1;`)).toBeNull();
  });

  test("module names come from exports, importers and content", () => {
    const names = suggestModuleNames([
      { id: "1", code: "export function q(e){return Math.min(e,1)}\nexport function B(e){return e}" },
      { id: "2", code: 'import * as React from "./3.js";\nexport default function A(){return React.useState()}' },
      { id: "3", code: "export const Fragment = 1;" },
      { id: "4", code: "export const A = 1;\nexport const b = 2;" },
    ]);
    expect(names.get("1")).toBe("utils");
    expect(names.get("3")).toBe("react");
    expect(names.get("4")).toBe("constants");
  });
});

describe("empty and import-only modules", () => {
  test("an empty module is inlined as {} wherever it is required or imported", () => {
    const out = finalizeModule(`import * as a from "./1.js";\nimport { b } from "./1.js";\nlet c = require("./1.js");\nexport const d = [a, b, c, import("./1.js")];`, {
      specifierFor: () => null,
      isEmptyModule: (id) => id === "1",
    });
    expect(out).not.toContain("./1.js");
    expect(out).toContain("const a = {}");
    expect(out).toContain("const b = undefined");
    expect(out).toContain("let c = {}");
    expect(out).toContain("Promise.resolve({})");
  });

  test("an import-only module is replaced by the modules it loads", () => {
    const out = finalizeModule(`import "./5.js";\nexport const x = 1;`, { specifierFor: (id) => `./m${id}.js`, sideEffectsFor: (id) => (id === "5" ? ["./6.js", "./7.js"] : null) });
    expect(out).toContain('import "./m6.js";');
    expect(out).toContain('import "./m7.js";');
    expect(out).not.toContain("m5.js");
  });

  test("helpers-only modules and default re-exports are recognized as wrappers", () => {
    expect(trivialModule(`import * as m from "./8.js";\nexport default m.default;`)).toEqual({ kind: "alias", target: "8" });
    expect(trivialModule(`import d from "./9.js";\nexport default d;`)).toEqual({ kind: "alias", target: "9" });
    expect(trivialModule(`import d from "./9.js";\nexport default d + 1;`)).toBeNull();
  });
});

describe("webpack interop", () => {
  test("__webpack_require__.n(ns) becomes the default import with a known name", () => {
    const normalized = normalizeExports(`import * as link from "./8500.js";
var o = __webpack_require__.n(link);
export default function Nav() { const C = o(); return <C href="/">x</C>; }
export const a = __webpack_require__.n(link).a;`);
    expect(normalized).not.toContain("__webpack_require__");
    const out = finalizeModule(normalized, { specifierFor: (id) => (id === "8500" ? "next/link" : null), defaultNameFor: (s) => (s === "next/link" ? "Link" : null) });
    expect(out).toContain('import Link from "next/link";');
    expect(out).toContain('<Link href="/">x</Link>');
    expect(out).not.toContain("const C");
  });
});

describe("lucide icons", () => {
  const data = `[["path", { d: "M5 12h14", key: "1ays0h" }], ["path", { d: "m12 5 7 7-7 7", key: "xquz4c" }]]`;

  test("kebab, PascalCase and object icon definitions are recognized", () => {
    expect(iconName("arrow-right")).toBe("ArrowRight");
    expect(iconName("ArrowRight")).toBe("ArrowRight");
    expect(iconName("arrow-down-0-1")).toBe("ArrowDown01");
    const kebab = analyzeIcons(`import { A } from "./5.js";\nconst s = A("arrow-right", ${data});\nexport { s as B };`, "react");
    expect(kebab).toMatchObject({ icons: 1, onlyIcons: true, factories: [{ id: "5", name: "A", package: "lucide-react" }] });
    expect([...kebab!.exported]).toEqual([["B", "ArrowRight"]]);
    const pascal = analyzeIcons(`import * as f from "./5.js";\nconst s = (0, f.A)("Search", [["circle", { cx: "11", cy: "11", r: "8", key: "4ej97u" }]]);\nexport default s;`, "react");
    expect([...pascal!.exported]).toEqual([["default", "Search"]]);
    const object = analyzeIcons(`import { A } from "./5.js";\nlet l = { name: "bell", size: 24, node: ${data} };\nl.node;\nexport let c = A(l);`, "react");
    expect(object).toMatchObject({ icons: 1, onlyIcons: true });
    expect([...object!.exported]).toEqual([["c", "Bell"]]);
  });

  test("icons inside app code become lucide-react imports with JSX names", () => {
    const out = replaceIcons(`import { A } from "./5.js";
let l = { name: "search", size: 24, node: [["circle", { cx: "11", cy: "11", r: "8", key: "4ej97u" }]] };
l.node;
let _Component = A(l);
const K = A("arrow-right", ${data});
export default function Bar() { return <div><_Component className="h-4" /><K /></div>; }`, "react");
    expect(out).toContain('import { Search, ArrowRight } from "lucide-react";');
    expect(out).toContain('<Search className="h-4" />');
    expect(out).toContain("<ArrowRight />");
    expect(out).not.toContain("./5.js");
    expect(out).not.toContain("node:");
  });

  test("arrays that are not SVG icon nodes are left alone", () => {
    expect(analyzeIcons(`const x = f("a", [["div", { key: "1" }]]);`, "react")).toBeNull();
    expect(analyzeIcons(`const x = f("a", [["path", { d: "M0" }]]);`, "react")).toBeNull();
  });
});

describe("organize: app code laid out by kind", () => {
  const organize = (files: Record<string, string>, pages: string[] = [], library: string[] = []) => {
    const tree = new OutputTree();
    for (const [path, content] of Object.entries(files)) tree.add({ path, content, kind: "module", renamable: false });
    const modules = Object.keys(files).map((path, i) => ({ id: String(i), namespace: "", name: path, group: "app" as const, localPath: path, chunkUrl: "", deps: [] }));
    const result = organizeModules(tree, modules, new Set(pages), new Map(library.map((n) => [n, "lib"])));
    return { result, files: new Map(tree.all().map((f) => [f.path, f.content])) };
  };

  test("components, hooks, stores, functions, constants and icons get their own files", () => {
    const { files } = organize({
      "js/Home.js": `import { useState } from "react";
import { create } from "zustand";
export const API_URL = "/api";
export const useCart = create((set) => ({ items: [] }));
export function useToggle(initial) { const [on, setOn] = useState(initial); return [on, () => setOn(!on)]; }
export function formatPrice(value) { return value.toFixed(2); }
export function parsePrice(text) { return Number(text); }
function _Component() { return <svg aria-label="Cart icon"><path d="M0 0" /></svg>; }
export default function Home() { const [on] = useToggle(false); return <main><_Component />{formatPrice(1)}{on && API_URL}</main>; }`,
      "js/main.js": `import Home, { parsePrice, useCart } from "./Home.js";\nconsole.log(Home, parsePrice("1"), useCart);`,
    });
    expect([...files.keys()].sort()).toEqual([
      "js/components/Home.jsx",
      "js/constants/API_URL.js",
      "js/functions/formatPrice.js",
      "js/functions/parsePrice.js",
      "js/hooks/useToggle.js",
      "js/icons/CartIcon.jsx",
      "js/main.js",
      "js/stores/useCart.js",
    ]);
    const home = files.get("js/components/Home.jsx")!;
    expect(home).toContain('import { useToggle } from "../hooks/useToggle.js";');
    expect(home).toContain('import { CartIcon } from "../icons/CartIcon.jsx";');
    expect(home).toContain("<CartIcon />");
    expect(home).toContain("export default function Home()");
    expect(files.get("js/icons/CartIcon.jsx")).toContain("export function CartIcon()");
    expect(files.get("js/stores/useCart.js")).toContain('import { create } from "zustand";');
    const main = files.get("js/main.js")!;
    expect(main).toContain('import Home from "./components/Home.jsx";');
    expect(main).toContain('import { parsePrice } from "./functions/parsePrice.js";');
    expect(main).toContain('import { useCart } from "./stores/useCart.js";');
  });

  test("unnamed components are named from markup, children from their parent", () => {
    const { files } = organize({
      "js/Page.js": `function a({ children }) { return <button className="rounded px-2">{children}</button>; }
function b({ t }) { return <div className="rounded-lg border p-4">{t}</div>; }
function c() { return <section id="features" className="p-8">{[1, 2].map((n) => <b t={n} key={n} />)}</section>; }
function d() { return <section className="p-8"><h2>Frequently asked questions</h2><a>x</a></section>; }
function e() { return <form className="flex"><input placeholder="Email" /><a>Subscribe</a></form>; }
function f() { return <footer className="p-4">f</footer>; }
export default function Page() { return <div className="min-h-screen"><c /><d /><e /><f /><a>go</a></div>; }`.replace(/<(\/?)([a-f])( |>|\/)/g, (m, slash, n, rest) => `<${slash}_${n.toUpperCase()}${rest}`).replace(/function ([a-f])\(/g, (m, n) => `function _${n.toUpperCase()}(`),
    });
    const paths = [...files.keys()].sort();
    expect(paths).toEqual(expect.arrayContaining(["js/components/Button.jsx", "js/components/Features.jsx", "js/components/FeatureCard.jsx", "js/components/Faq.jsx", "js/components/Footer.jsx"]));
    expect(paths.some((p) => /Form\.jsx$/.test(p))).toBe(true);
    expect(files.get("js/components/Page.jsx")).toContain('import { Features } from "./Features.jsx";');
  });

  test("code that reassigns shared module state stays in the original module", () => {
    const { files } = organize({
      "js/counter.js": `let count = 0;\nexport function increment() { count++; return count; }\nexport function read() { return count; }\nexport function double(x) { return x * 2; }`,
    });
    const rest = files.get("js/functions/counter.js")!;
    expect(rest).toContain("export function double(x)");
    expect(rest).toContain("export function increment()");
    expect(rest).toContain("let count = 0");
  });

  test("library code stays together, app code may import it lazily", () => {
    const { files } = organize(
      {
        "js/index.js": `function useStore() { return state(); }
function state() { return 1; }
function helperOne() { return state(); }
function Counter() { return <p>{useStore()}</p>; }
render(<Counter />);`,
      },
      [],
      ["useStore", "state", "helperOne"],
    );
    const counter = files.get("js/components/Counter.jsx")!;
    expect(counter).toContain('import { useStore } from "../index.js";');
    expect(files.get("js/index.js")).toContain("function state()");
    expect(files.get("js/index.js")).toContain('import { Counter } from "./components/Counter.jsx";');
  });

  test("utility-only modules move whole to js/functions and every kind of load follows them", () => {
    const { files } = organize({
      "js/heavy.js": `export function summarize(items) { return items.length; }`,
      "js/util.js": `export function one() { return 1; }\nexport function two() { return 2; }`,
      "js/App.js": `import * as u from "./util.js";\nexport default function App() { const go = async () => { const { summarize } = await import("./heavy.js"); return summarize([]) + u.one(); }; return <b onClick={go} />; }`,
    });
    expect(files.has("js/heavy.js")).toBe(false);
    expect(files.get("js/components/App.jsx")).toContain('await import("../functions/heavy.js")');
    expect(files.get("js/components/App.jsx")).toContain('import * as u from "../functions/util.js";');
    expect(files.get("js/functions/util.js")).toContain("export function two()");
    expect(files.has("js/util.js")).toBe(false);
  });
});

describe("vue render functions", () => {
  const compiled = (render: string) => `import { o, c, a, t, e, Fragment, toDisplayString, renderList, vShow, withDirectives, S } from "./runtime.js";
export const View = {
  __name: "Status",
  props: { items: Array, mode: String, open: Boolean },
  setup(p) {
    const n = S(0);
    function toggle() { n.value++; }
    return (_ctx, _cache) => {
      o();
      return ${render};
    };
  },
};
function helper() { return (o(), c("p", null, "x")); }
export const Other = { __name: "Other", setup() { return (_ctx, _cache) => (o(), c("div", null, [a("b", null, "b", -1), e(View), t("text", -1)])); } };
const total = S(1);
`;

  test("conditions, lists, v-show and events become template syntax", () => {
    const tree = new OutputTree();
    tree.add({
      path: "js/index.js",
      content: compiled(`c("div", { class: "status" }, [
        p.mode === "a" ? (o(), c("span", { key: 0 }, "A")) : p.mode === "b" ? (o(), c("span", { key: 1 }, "B")) : (o(), c("span", { key: 2 }, "other")),
        (o(true), c(Fragment, null, renderList(p.items, (item, index) => (o(), c("li", { key: item.id, onClick: toggle }, toDisplayString(index) + ": " + toDisplayString(item.name), 1))), 128)),
        (o(true), c(Fragment, null, renderList(p.items, (item) => (o(), c(Fragment, { key: item.id }, [a("dt", null, "k"), a("dd", null, "v")], 64))), 128)),
        withDirectives(a("em", null, "shown", 512), [[vShow, p.open]]),
        a("i", null, toDisplayString(n.value), 1)
      ])`),
      kind: "module",
      renamable: false,
    });
    const modules = [{ id: "1", namespace: "", name: "index", group: "app" as const, localPath: "js/index.js", chunkUrl: "", deps: [] }];
    organizeModules(tree, modules, new Set());
    const files = new Map(tree.all().map((f) => [f.path, f.content]));
    const view = files.get("js/components/Status.vue")!;
    expect(view).toContain('<span v-if="mode === \'a\'">A</span>');
    expect(view).toContain('<span v-else-if="mode === \'b\'">B</span>');
    expect(view).toContain("<span v-else>other</span>");
    expect(view).toContain('<li v-for="(item, index) in items" :key="item.id" @click="toggle">{{ index }}: {{ item.name }}</li>');
    expect(view).toMatch(/<template v-for="item in items" :key="item\.id">\s*<dt>k<\/dt>\s*<dd>v<\/dd>\s*<\/template>/);
    expect(view).toContain('<em v-show="open">shown</em>');
    expect(view).toContain("<i>{{ count }}</i>");
    expect(view).toContain("const count = ref(0);");
    expect(view).toContain("const props = defineProps({");
    const other = files.get("js/components/Other.vue")!;
    expect(other).toContain("<b>b</b>");
    expect(other).toContain("<Status />");
    expect(other).toContain('import Status from "./Status.vue";');
  });

  test("a render function with an unknown node stays JavaScript", () => {
    const tree = new OutputTree();
    tree.add({ path: "js/index.js", content: compiled(`c("div", null, [mystery()])`), kind: "module", renamable: false });
    organizeModules(tree, [{ id: "1", namespace: "", name: "index", group: "app" as const, localPath: "js/index.js", chunkUrl: "", deps: [] }], new Set());
    const paths = tree.all().map((f) => f.path);
    expect(paths).toContain("js/components/Status.js");
    expect(tree.all().find((f) => f.path === "js/components/Status.js")!.content).toContain("mystery()");
    expect(paths).toContain("js/components/Other.vue");
  });
});

describe("inlined libraries and stores", () => {
  test("terser's inlined factory call is folded back into a plain call", () => {
    const out = normalizeExports(`let l;\nlet r = (t) => t;\nlet c = (l = (t) => ({ total: 0 })) ? r(l) : r;\nexport { c };`);
    expect(out).toContain("export let c = r(t => ({");
    expect(out).not.toMatch(/\bl\b\s*=/);
  });

  test("a store built with inlined zustand goes to js/stores, zustand itself to js/vendor", () => {
    const tree = new OutputTree();
    tree.add({
      path: "js/Page.js",
      content: `let createStoreImpl = (e) => { let s; const setState = (v) => { s = v; }; return { setState, getState: () => s }; };
let r = (e) => { const api = createStoreImpl(e); return (sel) => sel(api.getState()); };
let c = r((set) => ({ coins: 10, spend: (n) => set(n) }));
export default function Page() { const coins = c((s) => s.coins); return <p>{coins}</p>; }`,
      kind: "module",
      renamable: false,
    });
    organizeModules(tree, [{ id: "1", namespace: "", name: "Page", group: "app" as const, localPath: "js/Page.js", chunkUrl: "", deps: [] }], new Set(), new Map([["createStoreImpl", "zustand"]]));
    const files = new Map(tree.all().map((f) => [f.path, f.content]));
    expect(files.get("js/stores/useCoinsStore.js")).toContain('import { create } from "zustand";');
    expect(files.get("js/stores/useCoinsStore.js")).toContain("export let useCoinsStore = create(");
    expect(files.get("js/node_modules/zustand/chunk.js")).toContain("let create =");
    expect(files.get("js/components/Page.jsx")).toContain('import { useCoinsStore } from "../stores/useCoinsStore.js";');
    expect(files.has("js/Page.js")).toBe(false);
  });

  test("store selectors name their results", () => {
    const out = renameIdentifiers(`import * as s from "./1.js";\nexport function f() { const a = (0, s.A)((e) => e.coins); const b = [1].map((e) => e.coins); return [a, b]; }`).code;
    expect(out).toContain("const coins =");
    expect(out).not.toMatch(/const coins2|let coins2/);
  });

  test("an identified library module that also exports app state is treated as app code", async () => {
    const db = await loadFingerprints();
    const known = packageFeatureSet(db, new Set(["zustand"]));
    expect(hasForeignExport(`export let A = n((e) => ({ coins: 10, spend: (t) => e({ coins: t }) }));`, known)).toBe(true);
    expect(hasForeignExport(`export let A = (e) => e ? createStoreImpl(e) : createStoreImpl;`, known)).toBe(false);
  });

  test("a confidently recognized leaf library function becomes a package import", () => {
    const out = importPackageFunctions(`let clsx = function () { return [...arguments].join(" "); };\nlet other = function () { return clsx(); };\nexport function f() { return clsx("a") + other(); }`, new Map([["clsx", "clsx"], ["other", "x"]]));
    expect(out).toContain('import { clsx } from "clsx";');
    expect(out).not.toContain("let clsx");
    expect(out).toContain("let other");
  });
});

describe("library exports", () => {
  test("mangled value exports match by their call signature, aliases prefer their own name", () => {
    const lib = printModule(`const createSlot = (n) => () => n;\nconst Slot = createSlot("Slot");\nconst Slottable = createSlot("Slottable");\nexport { Slot, Slot as Root, Slottable };`);
    const mine = printModule(`const f = (n) => () => n;\nexport var DX = f("Slot");\nexport var q = f("Slottable");`);
    const matched = matchFunctions(mine.exports, lib.exports);
    expect(matched.get("DX")?.name).toBe("Slot");
    expect(matched.get("q")?.name).toBe("Slottable");
  });

  test("calls in app code name mangled TanStack exports", () => {
    const renames = usageRenames(
      [{ code: `import * as q from "./9.js";\nexport function A() { q.I({ queryKey: ["x"], queryFn: f }); q.M({ mutationFn: g }); q.P({ queryKey: ["y"], getNextPageParam: h }); }` }],
      new Map([["9", { id: "9", package: "@tanstack/react-query" }]]),
      (id) => id,
    );
    expect([...renames.get("9")!]).toEqual([["I", "useQuery"], ["M", "useMutation"], ["P", "useInfiniteQuery"]]);
  });

  test("names exported by a package entry are imported from the package", () => {
    const out = finalizeModule(`import * as q from "./9.js";\nexport function A() { return q.useQuery({}) + q.x; }`, {
      specifierFor: (id) => (id === "9" ? "./node_modules/q.js" : null),
      bareImport: (id, name) => (id === "9" && name === "useQuery" ? "@tanstack/react-query" : null),
    });
    expect(out).toContain('import { useQuery } from "@tanstack/react-query";');
    expect(out).toContain('import { x } from "./node_modules/q.js";');
  });

  test("member use of a mangled export marks it as the package default import", () => {
    const renames = usageRenames([{ code: `import { A } from "./7.js";\nexport const api = A.create({ baseURL: "/api" });` }], new Map([["7", { id: "7", package: "axios" }]]), (id) => id);
    expect([...renames.get("7")!]).toEqual([["A", "default"]]);
    const out = finalizeModule(`import * as m from "./7.js";\nexport const api = m.default.create({});`, { specifierFor: () => "./node_modules/axios/lib/utils.js", bareImport: (id, name) => (name === "default" ? "axios" : null) });
    expect(out).toContain('import axios from "axios";');
    expect(out).toContain("export const api = axios.create({});");
  });

  test("a recognized function inlined as an IIFE is moved out under its name", () => {
    const out = outlineIifes(`export function useQuery(e, t) { return (function (a, b, c) { const x = a + 1; const y = b(x); return c ? y : x; })(e, 1, t); }\nexport function other(z) { return (function (q) { const w = q; const v = w; return v; })(z); }`, (_probe, i) => (i === 0 ? "useBaseQuery" : null));
    expect(out).toContain("return useBaseQuery(e, 1, t);");
    expect(out).toContain("function useBaseQuery(a, b, c)");
    expect(out).toMatch(/return \(?function \(q\)/);
  });

  test("vite preload dependencies include lazy CSS", () => {
    const body = `const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["assets/About-abc12345.js","assets/About-def67890.css"])))=>i.map(i=>d[i]);`;
    const refs = preloadDeps({ ref: { url: "https://s.test/app/assets/index-1.js", type: "module", initiator: "" }, finalUrl: "https://s.test/app/assets/index-1.js", contentType: "text/javascript", headers: new Headers(), body });
    expect(refs.map((r) => [r.url, r.type])).toEqual([
      ["https://s.test/app/assets/About-abc12345.js", "module"],
      ["https://s.test/app/assets/About-def67890.css", "style"],
    ]);
  });
});

describe("crypto constants", () => {
  test("hash implementations, tables and a nonce loop are named without running anything", () => {
    const code = nameCryptoCode(`const k = [1116352408, 1899447441, 3049323471];
function r(e, t) { return (e >>> t) | (e << (32 - t)); }
function F(x) { let a = 1779033703, b = 3144134277; return String(a + b + k[0] + r(x, 2)); }
async function q(salt, d) { let n = 0; while (true) { if (F(salt + n).startsWith("0".repeat(d))) return n; n++; } }
export { q };`);
    expect(code).toContain("const SHA256_K = [");
    expect(code).toContain("function rotr(e, t)");
    expect(code).toContain("function sha256(x)");
    expect(code).toContain("async function solveProofOfWork(salt, d)");
    const kinds = scanCrypto("a.js", code).map((f) => `${f.kind}:${f.name}`);
    expect(kinds).toEqual(expect.arrayContaining(["crypto:SHA-256", "proof-of-work:solveProofOfWork"]));
  });

  test("other algorithms are recognized by their constants", () => {
    const names = (code: string) => scanCrypto("a.js", code).map((f) => f.name);
    expect(names(`function a(){ return [3614090360, 3905402710]; }`)).toContain("MD5");
    expect(names(`function a(c){ return c ^ 3988292384; }`)).toContain("CRC-32");
    expect(names(`function a(){ return [3432918353, 461845907]; }`)).toContain("MurmurHash3");
    expect(names(`const t = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";`)).toContain("Base64 alphabet");
    expect(names(`function a(){ return [1, 2, 3, 4, 5]; }`)).toEqual([]);
  });
});

describe("fingerprints.sigdb", () => {
  test("the database loads from .sigdb with file and function prints and token lookup", async () => {
    const db = await loadFingerprints();
    expect(db.files.length).toBeGreaterThan(900);
    expect(Math.max(...db.files.filter((f) => f.package === "react-dom").map((f) => f.features.length))).toBeGreaterThan(500);
    expect(db.files.some((f) => f.exports.length && f.exports.some((e) => e.links?.length))).toBe(true);
    const clsx = db.files.find((f) => f.package === "clsx")!;
    const shared = db.shared!(clsx.features.filter((f) => f.startsWith("S:")));
    expect(shared.get(clsx)).toBeGreaterThan(0);
  });
});

describe("imports after the layout", () => {
  test("one import per name: repeated aliases of the same export are unified", () => {
    const tree = new OutputTree();
    tree.add({ path: "src/utils/a.js", content: `import { z as c, z as G } from "../lib.js";\nimport "./side.js";\nexport const total = c(1) + G(2);\n`, kind: "module", renamable: false });
    tree.add({ path: "src/lib.js", content: `export const z = (n) => n;\n`, kind: "module", renamable: false });
    tree.add({ path: "src/utils/side.js", content: `console.log(1);\n`, kind: "module", renamable: false });
    tidyExports(tree);
    const code = tree.all().find((f) => f.path === "src/utils/a.js")!.content;
    expect(code).toContain('import { z as c } from "../lib.js"');
    expect(code).toContain('import "./side.js"');
    expect(code).toContain("c(1) + c(2)");
  });

  test("vendor exports take the name their importers agree on and come from the package", () => {
    const tree = new OutputTree();
    tree.add({ path: "vendor/vue/index.js", content: `const z = (e) => e;\nexport { z };\n`, kind: "module", renamable: false });
    tree.add({ path: "src/a.js", content: `import { z as computed } from "../vendor/vue/index.js";\nexport const a = computed(1);\n`, kind: "module", renamable: false });
    tree.add({ path: "src/b.js", content: `import { z as computed } from "../vendor/vue/index.js";\nexport const b = computed(2);\n`, kind: "module", renamable: false });
    tree.add({ path: "src/c.js", content: `import { z as S } from "../vendor/vue/index.js";\nexport const c = S(3);\n`, kind: "module", renamable: false });
    adoptVendorAliases(tree, (pkg, name) => (pkg === "vue" && name === "computed" ? "vue" : null));
    expect(tree.all().find((f) => f.path === "vendor/vue/index.js")!.content).toContain("z as computed");
    expect(tree.all().find((f) => f.path === "src/a.js")!.content).toContain('import { computed } from "vue"');
    expect(tree.all().find((f) => f.path === "src/c.js")!.content).toContain('import { computed } from "vue"');
    expect(tree.all().find((f) => f.path === "src/c.js")!.content).toContain("computed(3)");
  });
});

describe("sign-in, captcha and mini-app services", () => {
  test("found by their API calls and endpoints", () => {
    const found = scanServices("src/Login.jsx", `const a=1;\nwindow.Telegram.Login.auth({bot_id:1},cb);\nturnstile.render("#c");\nconst u=window.Telegram.WebApp.initDataUnsafe;\nfetch("/api/auth/session")`);
    expect(found.map((f) => [f.name, f.kind, f.line])).toEqual([
      ["Telegram Login Widget", "auth", 2],
      ["Telegram Mini App", "mini-app", 4],
      ["NextAuth", "auth", 5],
      ["Cloudflare Turnstile", "captcha", 3],
    ]);
    expect(scanServices("a.js", "const x = 1;")).toEqual([]);
  });
});

describe("hoisted chunks", () => {
  test("a namespace alias of an import is inlined, so every part imports the package itself", () => {
    const labels = new Map(["useConstant", "createPresence", "motionValue", "animateValue", "frameloop", "transformValue", "springValue", "mixValues", "interpolate"].map((name) => [name, { package: "motion-dom", name }]));
    const lib = [...labels.keys()].map((name) => `function ${name}(e){return S.useRef(e)}`).join("\n");
    const code = `import * as pModule from "./react.js";\nvar S = pModule;\n${lib}\nexport function App(){return S.useState(useConstant(1))}`;
    const parts = splitHoisted({ id: "X", namespace: "vite", origin: "bundle", chunkUrl: "x", code, deps: [] }, () => labels);
    if (!parts) return;
    for (const part of parts) expect(part.code).not.toMatch(/\bvar S = pModule\b/);
  });
});

describe("readable pages", () => {
  test("framework payloads, bootstrap scripts, preloads and React markers are removed; third-party scripts are labelled", () => {
    const html = `<!DOCTYPE html><html><head><link rel="preload" as="script" href="/_next/static/chunks/webpack.js"/><link rel="stylesheet" href="/_next/static/css/a.css"/><script src="/_next/static/chunks/main-app.js" async=""></script><script src="https://telegram.org/js/telegram-web-app.js"></script><script type="application/ld+json">{"@type":"Organization"}</script></head><body><div hidden=""><!--$--><!--/$--></div><main><!--$--><h1>Title</h1><!-- --><p>text</p><!--/$--></main><script>(self.__next_f=self.__next_f||[]).push([0])</script><script>self.__next_f.push([1,"0:{}"])</script><script>window.dataLayer=[];</script><script>(self.__next_s=self.__next_s||[]).push(["https://cdn.example.org/sdk.js",{}])</script></body></html>`;
    const { html: out, removedScripts, thirdParty } = readablePage(html, {
      pageUrl: new URL("https://site.test/"),
      filePath: "html/index.html",
      owned: (url) => url.origin === "https://site.test",
      styles: { app: "css/app.css", tailwind: null, sources: new Set(["https://site.test/_next/static/css/a.css"]) },
    });
    expect(removedScripts).toBe(4);
    expect(thirdParty).toEqual(["https://telegram.org/js/telegram-web-app.js", "https://cdn.example.org/sdk.js"]);
    expect(out).toContain('<!-- third-party script (next/script): cdn.example.org --><script src="https://cdn.example.org/sdk.js"></script>');
    expect(out).toContain('<!-- third-party script: telegram.org (Telegram Mini App SDK) --><script src="https://telegram.org/js/telegram-web-app.js"></script>');
    expect(out).toContain("application/ld+json");
    expect(out).toContain("window.dataLayer=[]");
    expect(out).toContain('<link rel="stylesheet" href="../css/app.css">');
    expect(out).toContain("<main><h1>Title</h1><p>text</p></main>");
    expect(out).not.toContain("__next_f");
    expect(out).not.toContain("preload");
    expect(out).not.toContain("<!--$");
    expect(out).not.toContain("hidden");
    expect(out).toContain("../.chunks/html/index.html");
  });
});

describe("coverage: loaders the emulator cannot follow", () => {
  test("flags computed loaders, ignores static ones", () => {
    const code = `
const s = document.createElement("script"); s.src = base + "/x.js"; document.head.appendChild(s);
const ok = document.createElement("script"); ok.src = "/static/ok.js";
el.setAttribute("src", "/nope.png");
import(\`/mod-\${v}.js\`); import("./fine.js");
new Worker(url); new Worker(new URL("./w.js", import.meta.url));
new URL(name, import.meta.url);
importScripts(dep);
eval(code); new Function(body);
require.ensure([], cb); System.import(x);
document.body.insertAdjacentHTML("beforeend", "<script src=/a.js></script>");
__webpack_require__(id); __webpack_require__(12);`;
    const { loaders, urls } = scanLoaders("js/app.js", code);
    expect(loaders.map((l) => l.kind).sort()).toEqual(
      ["dynamic-import", "dynamic-require", "eval", "eval", "import-scripts", "inject-html", "require-ensure", "script-element", "system-import", "url-import-meta", "worker"].sort(),
    );
    expect(loaders.find((l) => l.kind === "script-element")).toMatchObject({ file: "js/app.js", line: 2 });
    expect(urls.map((u) => u.value)).toEqual(["/x.js", "/static/ok.js"]);
  });
});

describe("fingerprints", () => {
  test("features survive minification: names are ignored, properties and strings are kept", () => {
    const a = printModule("export function clamp(value, min, max) { return Math.min(Math.max(value, min), max); }").exports[0]!;
    const b = printModule("export function q(e,t,r){return Math.min(Math.max(e,t),r)}").exports[0]!;
    expect(b.features).toEqual(a.features);
  });

  test("idioms rename mangled app exports", () => {
    const mine = printModule("export function q(e,t,r){return Math.max(t,Math.min(e,r))}\nexport function B(e){return e+1}").exports;
    const matches = matchFunctions(mine, idiomPrints());
    expect(matches.get("q")?.name).toBe("clamp");
    expect(matches.has("B")).toBe(false);
    expect(renameExports("export function q(e,t,r){return 1}", new Map([["q", "clamp"]]))).toContain("export function clamp(");
  });

  test("library modules and inlined library functions are recognized from the bundled database", async () => {
    const db = await loadFingerprints();
    expect(db.files.length).toBeGreaterThan(100);
    const zustandVanilla = db.files.find((f) => f.package === "zustand" && f.file.includes("vanilla"))!;
    const code = await Bun.file(`${process.env.UNBUNDLE_SOURCE_ROOT ?? `${import.meta.dir}/..`}/.cache/fingerprints/node_modules/zustand/esm/vanilla.mjs`).text().catch(() => "");
    if (code) {
      const minified = new Bun.Transpiler({ loader: "js", minifyWhitespace: true }).transformSync(code);
      expect(identifyModule(printModule(minified), db)?.package).toBe("zustand");
    }
    const inlined = printModule(`let u = (t) => { let e; let set = new Set(); let setState = (t, l) => { let i = typeof t == "function" ? t(e) : t; if (!Object.is(i, e)) { let t = e; e = (l ?? (typeof i != "object" || i === null)) ? i : Object.assign({}, e, i); set.forEach((item) => item(e, t)); } }; let getState = () => e; let a = { setState, getState, getInitialState: () => s, subscribe: (t) => { set.add(t); return () => set.delete(t); } }; let s = (e = t(setState, getState, a)); return a; };`);
    expect(matchLocals(inlined.locals, buildFunctionIndex(db)).get("u")?.name).toBe("createStoreImpl");
    expect(zustandVanilla).toBeTruthy();
  });
});

describe("graph-level naming", () => {
  test("mangled app exports get names from what they return", () => {
    const names = behaviorNames(
      "export function B(e){return e===1?\"ONE\":`${e} items`}\nexport function C(count){return count>3}\nexport const D=(item)=><li>{item}</li>;\nexport function E(x){return x.map(y=>y)}",
      ["B", "C", "D", "E"],
    );
    expect(Object.fromEntries(names)).toEqual({ B: "formatValue", C: "isCount", D: "renderItem" });
  });

  test("renames that would change what a reference points to are detected", () => {
    const ast = parseProgram("let a = 1; function f(b) { return a + b; }");
    const snapshot = snapshotBindings(ast);
    expect(bindingViolations(ast, snapshot)).toEqual([]);
    const fn = ast.program.body[1] as t.FunctionDeclaration;
    (fn.params[0] as t.Identifier).name = "a";
    expect(bindingViolations(ast, snapshot).length).toBeGreaterThan(0);
  });

  test("the heuristic renamer keeps every reference bound as before", () => {
    const result = renameIdentifiers(`import * as n from "./r.js";let items=1;export default function a(){let[e,t]=n.useState([]);try{x()}catch(r){console.log(r,items)}return e.map(o=>o.id+items)}`);
    expect(result.violations).toBeUndefined();
    expect(result.renamed).toBeGreaterThan(0);
  });
});

describe("standalone: Flight payload and streaming", () => {
  test("rows: JSON, imports, hints and length-prefixed text rows with newlines", async () => {
    const { parseRows } = await import("../src/standalone/extractors/next-rsc.ts");
    const text = 'a:I[12,["1","static/chunks/x.js"],"default"]\n:HL["/a.css","style"]\n5:T5,ab\ncd0:["$","div",null,{"children":"$5"}]\n';
    const rows = parseRows(text);
    expect(rows.get("a")).toEqual({ tag: "I", value: [12, ["1", "static/chunks/x.js"], "default"] });
    expect(rows.get("5")).toEqual({ tag: "T", value: "ab\ncd" });
    expect(rows.get("0")?.value).toEqual(["$", "div", null, { children: "$5" }]);
  });

  test("streamed Suspense segments are reconciled into the final tree", async () => {
    const { reconcileStreaming } = await import("../src/standalone/extractors/next-rsc.ts");
    const html = '<main><!--$?--><template id="B:0"></template><p class="fallback">wait</p><!--/$--></main><div hidden id="S:0"><b>done</b></div><script>$RC("B:0","S:0")</script>';
    const out = reconcileStreaming(html);
    expect(out).toContain("<main><!--$--><b>done</b><!--/$--></main>");
    expect(out).not.toContain("wait");
    expect(out).not.toContain('id="S:0"');
  });
});

describe("stylesheets", () => {
  test("tailwind v4 output is split from the site's own rules", async () => {
    const { mergeStyles } = await import("../src/refine/styles.ts");
    const css = '/*! tailwindcss v4.3.3 | MIT */@layer theme{:root{--color-white:#fff}}@layer base{*{margin:0}}@layer utilities{.bg-white{background:#fff}.md\\:p-4{padding:1rem}}@property --tw-font-weight{syntax:"*";inherits:false}.card{padding:4px}body{font-family:serif}.flex.custom-box{gap:1px}';
    const merged = mergeStyles([{ url: "a.css", css }]);
    expect(merged.tailwind?.version).toBe("4.3.3");
    expect(merged.tailwind?.rules).toBe(4);
    expect(merged.app.css).toBe(".card{padding:4px}\nbody{font-family:serif}\n.flex.custom-box{gap:1px}");
  });

  test("tailwind v3 preflight and utilities are recognized without layers", async () => {
    const { mergeStyles } = await import("../src/refine/styles.ts");
    const css = "/*! tailwindcss v3.4.1 | MIT */*,:after,:before{box-sizing:border-box}html{line-height:1.5}.container{width:100%}.mt-2{margin-top:.5rem}.hover\\:underline:hover{text-decoration:underline}.hero-title{font-size:3rem}";
    const merged = mergeStyles([{ url: "a.css", css }, { url: "b.css", css }]);
    expect(merged.sources).toEqual(["a.css"]);
    expect(merged.app.css).toBe(".hero-title{font-size:3rem}");
  });

  test("plain CSS without tailwind is merged as is", async () => {
    const { mergeStyles } = await import("../src/refine/styles.ts");
    const merged = mergeStyles([{ url: "a.css", css: ".a{color:red}" }, { url: "b.css", css: "@media (min-width:1px){.b{color:blue}}" }]);
    expect(merged.tailwind).toBeNull();
    expect(merged.app.rules).toBe(2);
  });
});

describe("inline scripts", () => {
  test("recognizes data-only payload scripts", () => {
    expect(isDataOnlyScript(`(self.__next_f=self.__next_f||[]).push([0])`)).toBe(true);
    expect(isDataOnlyScript(`self.__next_f.push([1,"0:{}"])`)).toBe(true);
    expect(isDataOnlyScript(`window.__DATA__={"a":[1,2,{"b":null}]}`)).toBe(true);
    expect(isDataOnlyScript(`gtag("config", id)`)).toBe(false);
    expect(isDataOnlyScript(`document.title="x";run()`)).toBe(false);
  });
});

describe("strings", () => {
  test("classifies endpoints and urls", () => {
    expect(classifyString("/api/users")).toBe("endpoint");
    expect(classifyString("https://x.test/a")).toBe("url");
    expect(classifyString("/about")).toBe("path");
    expect(classifyString("hello")).toBe("text");
  });
});

describe("readable exports across the output", () => {
  test("mangled export names give way to the local names, importers and templates follow", () => {
    const tree = new OutputTree();
    tree.add({
      path: "js/entry.js",
      content: `function useRoute() { return 1; }
function c(e, t = {}) { const head = t.head; return head ?? e; }
function z() { return { warning() {}, error() {} }; }
const aU = Object.assign({ __name: "UiModal", setup() {} }, {});
function useProjectRepositoryStore() { return {}; }
function eg(e) { return e; }
export function D() { const e = useProjectRepositoryStore(); return { ...e, ...eg(e) }; }
export function E() { return { ...eg(1) }; }
export { useRoute, useRoute as a, c, z };
export { aU };
`,
      kind: "module",
      renamable: false,
    });
    tree.add({
      path: "js/pages/login.vue",
      content: `<script setup>
import { a as j, c as H, z as ce, aU as M, D as P, E as Q } from "../entry.js";
const L = j();
const y = ce();
H({ ogTitle: "x", description: "y" });
y.warning("w");
y.error("e");
</script>

<template>
  <p :title="L" class="space-y-4">{{ L }} y</p>
</template>
`,
      kind: "module",
      renamable: false,
    });
    expect(publishReadableExports(tree)).toBeGreaterThan(0);
    const page = tree.all().find((f) => f.path === "js/pages/login.vue")!.content;
    expect(page).toContain('import { useRoute, useSeoMeta, useToast, UiModal, useProjectRepository, E as Q } from "../entry.js";');
    expect(page).toContain("const route = useRoute();");
    expect(page).toContain("const toast = useToast();");
    expect(page).toContain('<p :title="route" class="space-y-4">{{ route }} y</p>');
    const entry = tree.all().find((f) => f.path === "js/entry.js")!.content;
    expect(entry).toContain("function useSeoMeta(");
    expect(entry).not.toContain("useRoute as a");
  });
});

describe("project layout and language", () => {
  const vue = (props: string) => ({ path: "", content: `<script setup>\nconst props = defineProps({ ${props} });\n</script>\n<template><p /></template>\n`, kind: "module" as const, renamable: false });

  test("TypeScript is recognized from compiled traces, JavaScript stays JavaScript", () => {
    const typed = [{ ...vue("player: { default: null }"), path: "js/components/A.vue" }, { ...vue("open: { type: null, required: true }"), path: "js/components/B.vue" }];
    const plain = [{ ...vue("initial: { type: Number, default: 3 }"), path: "js/components/C.vue" }, { ...vue("item: Object"), path: "js/components/D.vue" }];
    expect(detectTypeScript(typed, [], "nuxt")).toBe(true);
    expect(detectTypeScript(plain, [], "nuxt")).toBe(false);
    expect(detectTypeScript([], ["webpack://app/src/App.tsx"], "next")).toBe(true);
    expect(detectTypeScript([{ path: "js/functions/level.js", content: 'var Level;\n(function (Level) {\n  Level[(Level.Low = 0)] = "Low";\n})(Level || (Level = {}));\n', kind: "module", renamable: false }], [], "vite")).toBe(true);
    expect(detectTypeScript([], [], "angular")).toBe(true);
  });

  test("a TypeScript project gets .ts/.tsx files and extensionless imports", () => {
    const tree = new OutputTree();
    tree.add({ path: "js/components/App.jsx", content: 'import { Counter } from "./Counter.jsx";\nexport function App() { return <Counter />; }\n', kind: "module", renamable: false });
    tree.add({ path: "js/components/Counter.jsx", content: "export function Counter() { return <p />; }\n", kind: "module", renamable: false });
    tree.add({ path: "js/functions/clamp.js", content: "export function clamp(v) { return v; }\n", kind: "module", renamable: false });
    tree.add({ path: "js/node_modules/react/index.js", content: "export const x = 1;\n", kind: "module", renamable: false });
    const moved = projectLayout(tree, "vite", true);
    expect(moved.get("js/components/App.jsx")).toBe("src/App.tsx");
    expect(moved.get("js/functions/clamp.js")).toBe("src/utils/clamp.ts");
    expect(moved.get("js/node_modules/react/index.js")).toBe("vendor/react/index.js");
    expect(tree.all().find((f) => f.path === "src/App.tsx")!.content).toContain('from "./components/Counter";');
  });
});

describe("entry leftovers become project files", () => {
  const mod = (tree: OutputTree, path: string, content: string) => tree.add({ path, content, kind: "module", renamable: false });

  test("stores, the api cluster and router guards leave shared.ts", () => {
    const tree = new OutputTree();
    mod(tree, "src/shared.ts", `import { defineStore } from "pinia";
import { ref } from "vue";
export const useToastStore = defineStore("toast", () => { const items = ref([]); function push(text) { items.value.push(text); } return { items, push }; });
const TOKEN_KEY = "app_token";
export function getToken() { return localStorage.getItem(TOKEN_KEY); }
async function request(path, options = {}) { const response = await fetch(\`/api/v1\${path}\`, { ...options, headers: { Authorization: getToken() } }); return response.json(); }
export const api = { get: (path) => request(path), post: (path, body) => request(path, { method: "POST", body: JSON.stringify(body) }) };
`);
    mod(tree, "src/router/index.ts", `import { createRouter, createWebHistory } from "vue-router";
import { getToken } from "../shared";
export const router = createRouter({ history: createWebHistory(), routes: [] });
router.beforeEach((to) => (to.meta.public || getToken() ? true : "/login"));
`);
    mod(tree, "src/components/Toasts.vue", `<script setup>
import { useToastStore, api } from "../shared";
const toastStore = useToastStore();
api.get("/me");
</script>
<template><p v-for="item in toastStore.items">{{ item }}</p></template>
`);
    absorbShared(tree, "src");
    nameStoreFiles(tree, "src");
    const file = (path: string) => tree.all().find((f) => f.path === path)?.content ?? "";
    expect(tree.all().some((f) => f.path === "src/shared.ts")).toBe(false);
    expect(file("src/stores/toast.ts")).toContain('defineStore("toast"');
    expect(file("src/utils/api.ts")).toContain("export const api");
    expect(file("src/utils/api.ts")).toContain("export function getToken");
    expect(file("src/router/index.ts")).toContain('import { getToken } from "../utils/api";');
    expect(file("src/components/Toasts.vue")).toContain('import { useToastStore } from "../stores/toast";');
    expect(file("src/components/Toasts.vue")).toContain('import { api } from "../utils/api";');
  });

  test("a lone error class in api/ joins utils/api", () => {
    const tree = new OutputTree();
    mod(tree, "src/api/HttpError.ts", "export class HttpError extends Error {\n  constructor(status, message) {\n    super(message);\n    this.status = status;\n  }\n}\n");
    mod(tree, "src/utils/api.ts", 'import { HttpError } from "../api/HttpError";\nexport async function request(path) {\n  const response = await fetch(path);\n  if (!response.ok) throw new HttpError(response.status, "failed");\n  return response.json();\n}\n');
    mod(tree, "src/views/LoginView.vue", '<script setup>\nimport { HttpError } from "../api/HttpError";\nconst isHttp = (e) => e instanceof HttpError;\n</script>\n<template><p /></template>\n');
    expect(absorbLoneClient(tree, "src")).toBe(1);
    const file = (path: string) => tree.all().find((f) => f.path === path)?.content ?? "";
    expect(tree.all().some((f) => f.path.startsWith("src/api/"))).toBe(false);
    expect(file("src/utils/api.ts")).toContain("export class HttpError extends Error");
    expect(file("src/utils/api.ts")).not.toContain("../api/HttpError");
    expect(file("src/views/LoginView.vue")).toContain('import { HttpError } from "../utils/api";');
  });

  test("views that only switch between components pull them into views/, feature parts share a folder", () => {
    const tree = new OutputTree();
    mod(tree, "js/router.js", 'import { createRouter } from "vue-router";\nexport const router = createRouter({ routes: [{ path: "/", component: () => import("./components/DashboardView.vue") }, { path: "/surveys/:id", component: () => import("./components/SurveyEditorView.vue") }] });\n');
    mod(tree, "js/components/DashboardView.vue", '<script setup>\nimport RootOverview from "./RootOverview.vue";\nimport AdminDashboard from "./AdminDashboard.vue";\nconst root = true;\n</script>\n<template>\n  <RootOverview v-if="root" />\n  <AdminDashboard v-else />\n</template>\n');
    mod(tree, "js/components/RootOverview.vue", "<template><p /></template>\n");
    mod(tree, "js/components/AdminDashboard.vue", "<template><p /></template>\n");
    mod(tree, "js/components/SurveyEditorView.vue", '<script setup>\nimport SurveyCanvas from "./SurveyCanvas.vue";\n</script>\n<template><SurveyCanvas /></template>\n');
    mod(tree, "js/components/SurveyCanvas.vue", '<script setup>\nimport StartNode from "./StartNode.vue";\nimport QuestionNode from "./QuestionNode.vue";\nimport ResultNode from "./ResultNode.vue";\nconst types = { start: StartNode, question: QuestionNode, result: ResultNode };\n</script>\n<template><div :data-types="types" /></template>\n');
    for (const name of ["StartNode", "QuestionNode", "ResultNode"]) mod(tree, `js/components/${name}.vue`, "<template><p /></template>\n");
    const moved = projectLayout(tree, "vite");
    expect(moved.get("js/components/DashboardView.vue")).toBe("src/views/DashboardView.vue");
    expect(moved.get("js/components/RootOverview.vue")).toBe("src/views/RootOverview.vue");
    expect(moved.get("js/components/AdminDashboard.vue")).toBe("src/views/AdminDashboard.vue");
    expect(moved.get("js/components/SurveyCanvas.vue")).toBe("src/components/survey/SurveyCanvas.vue");
    expect(moved.get("js/components/StartNode.vue")).toBe("src/components/survey/StartNode.vue");
    expect(tree.all().find((f) => f.path === "src/views/SurveyEditorView.vue")!.content).toContain('from "../components/survey/SurveyCanvas.vue"');
  });
});

describe("markup names and output helpers", () => {
  test("placeholder components are named by their markup", () => {
    const { code } = renameIdentifiers(`export function a({title:e,desc:t}){return <div><h1>{e}</h1>{t&&<p>{t}</p>}</div>}
export function _Component12({title:e,sub:t}){return <div className="col"><h3>{e}</h3>{t&&<span>{t}</span>}</div>}
export function b(e){return <h2>{e.title}</h2>}
export function c({title:e,children:n}){return <div><h2>{e}</h2>{n}</div>}`);
    expect(code).toContain("function PageHeader(");
    expect(code).toContain("function SectionHeader(");
    expect(code).toContain("function SectionTitle(");
    expect(code).toContain("function Section(");
    expect(code).not.toContain("function _Component12(");
  });

  test("a component registry with dynamic dispatch is split into components", () => {
    const tree = new OutputTree();
    tree.add({ path: "js/Home.js", kind: "module", renamable: false, content: `const tF = { max: function (e) { return <div className="max">{e.a}</div>; }, brawl: function (e) { return <div className="brawl">{e.b}</div>; }, wendy: (e) => <div className="wendy">{e.c}</div> };
export default function Home({ type }) { const View = tF[type]; return <main><View /></main>; }` });
    organizeModules(tree, [{ id: "0", namespace: "", name: "Home", group: "app" as const, localPath: "js/Home.js", chunkUrl: "", deps: [] }], new Set(["js/Home.js"]));
    const all = tree.all().map((f) => f.content).join("\n");
    expect(all).toMatch(/function Brawl\(/);
    expect(all).not.toContain("brawl: function");
  });

  test("text-only elements are joined back onto one line", () => {
    expect(tightenText(`<a href="/">\n  Home\n</a>`)).toBe(`<a href="/">Home</a>`);
    expect(tightenText(`<pre>\n  x\n</pre>`)).toBe(`<pre>\n  x\n</pre>`);
  });

  test("unquoted attributes get quotes", () => {
    expect(quoteAttributes(`<a href=/en/ class=x>Hi</a>`)).toBe(`<a href="/en/" class="x">Hi</a>`);
    expect(quoteAttributes(`<img src="a.png" alt=''>`)).toBe(`<img src="a.png" alt=''>`);
  });

  test("locale dictionaries move to i18n json files", () => {
    const tree = new OutputTree();
    const long = "x".repeat(250);
    tree.add({ path: "src/i18n.js", kind: "module", renamable: false, content: `const t = { en: { title: "Hello ${long}", cta: "Go" }, ru: { title: "Привет ${long}", cta: "Вперёд" } };\nexport function label(lang) { return t[lang].title; }\n` });
    expect(extractLocaleDictionaries(tree, "src")).toBe(1);
    const files = new Map(tree.all().map((f) => [f.path, f.content]));
    expect(JSON.parse(files.get("src/i18n/en.json")!).cta).toBe("Go");
    expect(JSON.parse(files.get("src/i18n/ru.json")!).cta).toBe("Вперёд");
    expect(files.get("src/i18n.js")).toContain('from "./i18n/en.json"');
  });

  test("writeTree only replaces its own output", async () => {
    const dir = await mkdtemp(join(tmpdir(), "unbundle-"));
    try {
      await Bun.write(join(dir, "site/manifest.json"), JSON.stringify({ name: "My PWA" }));
      await Bun.write(join(dir, "site/index.html"), "keep");
      await expect(writeTree(join(dir, "site"), [{ path: "a.js", content: "1" }])).rejects.toThrow("refusing to overwrite");
      expect(await Bun.file(join(dir, "site/index.html")).text()).toBe("keep");
      await Bun.write(join(dir, "old/manifest.json"), JSON.stringify({ tool: { name: "unbundle", version: "0.1.0" } }));
      await writeTree(join(dir, "old"), [{ path: "a.js", content: "1" }]);
      expect(await Bun.file(join(dir, "old/a.js")).text()).toBe("1");
      expect(await Bun.file(join(dir, "old/manifest.json")).exists()).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
