export interface Options {
  url: URL;
  outDir: string;
  adapter?: string;
  sourceMaps: boolean;
  rename: boolean;
  webcrack: boolean;
  format: boolean;
  concurrency: number;
  workers: number;
  retries: number;
  timeoutMs: number;
  maxBytes: number;
  maxPages: number;
  crawlDepth: number;
  includeExternal: boolean;
  standalone?: boolean;
}

export type ResourceType = "document" | "script" | "module" | "style" | "manifest" | "worker" | "sourcemap" | "fetch" | "other";

export interface Page {
  requestedUrl: URL;
  url: URL;
  baseUrl: URL;
  status: number;
  headers: Headers;
  html: string;
}

export interface AssetRef {
  url: string;
  type: ResourceType;
  initiator: string;
  optional?: boolean;
}

export interface Asset {
  ref: AssetRef;
  finalUrl: string;
  contentType: string;
  headers: Headers;
  body: string;
}

export interface SourceFile {
  path: string;
  originalPath: string;
  content: string;
}

export interface SourceMapResult {
  assetUrl: string;
  mapUrl: string;
  raw: string;
  sources: SourceFile[];
  missingContent: string[];
}

export interface ModuleRecord {
  id: string;
  namespace: string;
  origin?: "app" | "library" | "bundle";
  nameHint?: string;
  package?: { name: string; specifier: string; version?: string };
  chunkUrl: string;
  code: string;
  deps: string[];
}

export type ParseLevel = "full" | "partial" | "raw";

export interface ChunkDiagnostics {
  level: ParseLevel;
  shape: string;
  containers: number;
  recognized: number;
  skipped: Array<{ id: string; reason: string }>;
  notes: string[];
}

export interface ChunkParseResult {
  format: string;
  chunkIds: string[];
  modules: ModuleRecord[];
  diagnostics: ChunkDiagnostics;
}

export interface ModuleHint {
  id: string;
  name: string;
  weight: number;
  reason: string;
  file?: string;
}

export interface Detection {
  score: number;
  evidence: string[];
}

export interface DiscoverContext {
  pages: readonly Page[];
  all: ReadonlyMap<string, Asset>;
  fresh: readonly Asset[];
}

export interface ChunkEnv {
  importMap: ReadonlyMap<string, string>;
}

export interface BundlerAdapter {
  readonly name: string;
  detect(page: Page): Detection;
  detectAssets?(assets: readonly Asset[]): Detection;
  collectAssets(page: Page): AssetRef[];
  discover?(ctx: DiscoverContext): AssetRef[];
  scopePath?(page: Page): string | null;
  ownsUrl?(url: URL, page: Page): boolean;
  parseChunk(asset: Asset, env: ChunkEnv): ChunkParseResult | null;
  normalizeSourcePath?(source: string): string;
  moduleHints?(ctx: DiscoverContext): ModuleHint[];
  pageData?(page: Page): Array<{ suffix: string; content: string }>;
  isRuntime?(asset: Asset): boolean;
  coverage?(ctx: DiscoverContext): { unfetchedChunkIds: string[] };
}

export type OutputKind = "page" | "data" | "source" | "module" | "style" | "script" | "raw";

export interface OutputFile {
  path: string;
  content: string;
  kind: OutputKind;
  renamable: boolean;
  library?: boolean;
  noFormat?: boolean;
}

export interface StylesOutput {
  app: string | null;
  tailwind: { path: string; version: string | null; rules: number; bytes: number } | null;
  sources: Set<string>;
}

export interface Quality {
  readableModuleNames: number;
  mangledIdentifiers: { app: number; library: number };
  boilerplate: { defineExports: number; exportsAssignments: number; requireCalls: number; indirectCalls: number };
  identifiedPackages: string[];
  degradedChunks: number;
}

export interface LoaderFinding {
  kind: string;
  file: string;
  line: number;
  snippet: string;
  regionStrings?: string[];
  regionName?: string;
}

export interface Coverage {
  status: "complete" | "possibly-incomplete";
  unresolvedLoaders: LoaderFinding[];
  libraryLoaders: LoaderFinding[];
  missingModules: Array<{ module: string; missingId: string; chunkUrl: string }>;
  unfetchedChunkIds: string[];
  seenButNotLoaded: Array<{ url: string; file: string; line: number }>;
  failedResources: string[];
}

export interface Issue {
  stage: string;
  url?: string;
  path?: string;
  message: string;
}

export interface FileEntry {
  url: string;
  localPath: string | null;
  type: ResourceType;
  status: "ok" | "failed" | "skipped" | "duplicate";
  via?: "sourcemap" | "unpack" | "deminify" | "copy";
  initiator?: string;
  sourceMap?: string;
  modules?: string[];
  standalone?: StandaloneResult;
  parse?: ParseLevel;
  parseNotes?: string[];
  duplicateOf?: string;
  error?: string;
}

export interface Manifest {
  tool: { name: string; version: string };
  createdAt: string;
  input: string;
  finalUrl: string;
  bundler: { adapter: string | null; score: number; evidence: string[]; forced: boolean };
  summary: {
    pages: number;
    requests: number;
    scripts: number;
    styles: number;
    chunks: number;
    modules: number;
    sourceMaps: { maps: number; sources: number; missingContent: number };
    renamedIdentifiers: number;
    degraded: number;
    quality: Quality;
    strings: number;
    endpoints: number;
    errors: number;
    warnings: number;
    durationMs: number;
  };
  files: FileEntry[];
  sources: Array<{ source: string; localPath: string; mapUrl: string }>;
  modules: Array<{
    id: string;
    namespace: string;
    name: string;
    group: "app" | "library";
    localPath: string | null;
    parts?: string[];
    exports?: Record<string, string>;
    dropped?: string;
    identifiedAs?: { package: string; file: string; confidence: number };
    renamedExports?: Record<string, string>;
    chunkUrl: string;
    deps: string[];
  }>;
  coverage: Coverage;
  findings: Array<{ kind: "crypto" | "proof-of-work" | "webcrypto" | "auth" | "captcha" | "mini-app"; name: string; file: string; line: number; detail: string }>;
  errors: Issue[];
  warnings: Issue[];
}

export type VirtualNode =
  | { type: "host"; tag: string; props: Record<string, unknown>; children: VirtualNode[] }
  | { type: "text"; value: string }
  | { type: "fragment"; children: VirtualNode[] }
  | { type: "suspense"; children: VirtualNode[] }
  | { type: "boundary"; name: string; src: string | null; moduleId: string; children: VirtualNode[] };

export interface ResolvedComponent {
  name: string;
  src: string | null;
}

export interface ExtractContext {
  resolveComponent(moduleId: string, exportName: string): ResolvedComponent;
}

export type Applicability = { applicable: true } | { applicable: false; reason: string };

export interface TreeExtractor {
  readonly name: string;
  applies(page: Page, bundler: string | null): Applicability;
  extract(page: Page, ctx: ExtractContext): VirtualNode[];
  prepareDom?(html: string): string;
  annotate?(root: import("node-html-parser").HTMLElement, page: Page, ctx: ExtractContext): Array<{ component: string; src: string | null; nodes: number }>;
}

export interface StandaloneResult {
  status: "annotated" | "not-applicable" | "failed";
  extractor?: string;
  reason?: string;
  localPath?: string;
  annotations?: Array<{ component: string; src: string | null; nodes: number }>;
  unaligned?: Array<{ component: string; reason: string }>;
}
