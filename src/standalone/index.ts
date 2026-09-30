import { join } from "node:path";
import { parse } from "node-html-parser";
import type { Layout, OutputTree } from "../output.ts";
import type { Manifest, Page, ResolvedComponent, StandaloneResult, StylesOutput, TreeExtractor } from "../types.ts";
import { Aligner, applyAnnotations } from "./align.ts";
import { standaloneDocument } from "./document.ts";

function isExtractor(value: unknown): value is TreeExtractor {
  const v = value as Partial<TreeExtractor> | null;
  return !!v && typeof v.name === "string" && typeof v.applies === "function" && typeof v.extract === "function";
}

export async function loadExtractors(dir = join(import.meta.dir, "extractors")): Promise<TreeExtractor[]> {
  const extractors: TreeExtractor[] = [];
  for await (const file of new Bun.Glob("*.ts").scan({ cwd: dir, onlyFiles: true })) {
    const mod = (await import(join(dir, file))) as { default?: unknown };
    if (!isExtractor(mod.default)) throw new Error(`tree extractor ${file} has no valid default export`);
    extractors.push(mod.default);
  }
  return extractors.sort((a, b) => a.name.localeCompare(b.name));
}

export interface StandaloneInput {
  pages: Page[];
  bundler: string | null;
  modules: Manifest["modules"];
  styles: StylesOutput;
  layout: Layout;
  tree: OutputTree;
  extractors: TreeExtractor[];
}

export function componentResolver(modules: Manifest["modules"]) {
  return (moduleId: string, exportName: string): ResolvedComponent => {
    const mod = modules.find((m) => m.id === moduleId && m.localPath);
    const named = exportName && exportName !== "default" && exportName !== "*" ? exportName : null;
    if (mod) return { name: named ?? mod.name, src: mod.exports?.[exportName] ?? mod.localPath };
    return { name: named ?? `ClientComponent${moduleId}`, src: null };
  };
}

export function renderStandalone(input: StandaloneInput): Map<string, StandaloneResult> {
  const results = new Map<string, StandaloneResult>();
  const resolveComponent = componentResolver(input.modules);
  for (const page of input.pages) {
    const verdicts = input.extractors.map((extractor) => ({ extractor, verdict: extractor.applies(page, input.bundler) }));
    const chosen = verdicts.find((v) => v.verdict.applicable);
    if (!chosen) {
      const reason = verdicts.map((v) => (v.verdict.applicable ? "" : v.verdict.reason)).filter(Boolean).join("; ") || "no tree extractor available";
      results.set(page.url.href, { status: "not-applicable", reason });
      continue;
    }
    const { extractor } = chosen;
    try {
      const html = extractor.prepareDom ? extractor.prepareDom(page.html) : page.html;
      const root = parse(html, { comment: true, blockTextElements: { script: true, style: true, noscript: true, pre: true, textarea: true } });
      const aligner = new Aligner();
      const annotations = extractor.annotate ? extractor.annotate(root, page, { resolveComponent }) : (aligner.align(extractor.extract(page, { resolveComponent }), root.childNodes, 0, root.childNodes.length, "server"), applyAnnotations(aligner.result));
      const path = input.layout.pageData(page.url, "standalone.html");
      const file = input.tree.add({ path, content: standaloneDocument(root, page.url, input.styles, path), kind: "data", renamable: false });
      results.set(page.url.href, {
        status: "annotated",
        extractor: extractor.name,
        localPath: file.path,
        annotations,
        ...(aligner.result.skipped.length ? { unaligned: aligner.result.skipped } : {}),
        ...(annotations.length ? {} : { reason: extractor.annotate ? "no interactive island on this page" : "no Client Component boundary on this page: server-rendered markup is left unannotated by design" }),
      });
    } catch (err) {
      results.set(page.url.href, { status: "failed", extractor: extractor.name, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  return results;
}
