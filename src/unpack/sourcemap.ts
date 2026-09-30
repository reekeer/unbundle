import { AnyMap, type SourceMapInput } from "@jridgewell/trace-mapping";
import type { Asset, SourceFile, SourceMapResult } from "../types.ts";

const JS_MAP_COMMENT = /\/\/[#@]\s*sourceMappingURL=([^\s'"]+)\s*$/;
const CSS_MAP_COMMENT = /\/\*[#@]\s*sourceMappingURL=([^\s*]+)\s*\*\/\s*$/;

export interface MapCandidate {
  url: string;
  explicit: boolean;
}

export function sourceMapCandidates(asset: Asset): MapCandidate[] {
  const candidates: string[] = [];
  const header = asset.headers.get("sourcemap") ?? asset.headers.get("x-sourcemap");
  if (header) candidates.push(header);
  const tail = asset.body.slice(-4096).trimEnd();
  const lastLine = tail.slice(tail.lastIndexOf("\n") + 1);
  const match = JS_MAP_COMMENT.exec(lastLine) ?? CSS_MAP_COMMENT.exec(lastLine);
  if (match?.[1]) candidates.push(match[1]);
  else if (!asset.body.includes("sourceMappingURL=data:")) {
    const comment = findTrailingComment(asset.body);
    if (comment) candidates.push(comment);
  }
  const explicitCount = candidates.length;
  candidates.push(`${new URL(asset.finalUrl).pathname.split("/").pop()}.map`);

  const resolved: MapCandidate[] = [];
  candidates.forEach((candidate, index) => {
    const explicit = index < explicitCount;
    if (candidate.startsWith("data:")) {
      resolved.push({ url: candidate, explicit });
      return;
    }
    const url = URL.parse(candidate, asset.finalUrl);
    if (url && (url.protocol === "http:" || url.protocol === "https:") && !resolved.some((r) => r.url === url.href)) {
      resolved.push({ url: url.href, explicit });
    }
  });
  return resolved;
}

function findTrailingComment(body: string): string | undefined {
  const tail = body.slice(-4096);
  const matches = [...tail.matchAll(/[#@]\s*sourceMappingURL=([^\s'"*]+)/g)];
  return matches.at(-1)?.[1];
}

export function decodeDataUrl(url: string): string | null {
  const comma = url.indexOf(",");
  if (comma < 0) return null;
  const meta = url.slice(5, comma);
  const data = url.slice(comma + 1);
  try {
    return meta.endsWith(";base64") ? Buffer.from(data, "base64").toString("utf8") : decodeURIComponent(data);
  } catch {
    return null;
  }
}

const XSSI_PREFIX = /^\)\]\}'?\n/;

export function looksLikeSourceMap(text: string): boolean {
  const body = text.trimStart().replace(XSSI_PREFIX, "");
  return body.startsWith("{") && /"(mappings|sections)"\s*:/.test(body);
}

export function unpackSourceMap(
  text: string,
  mapUrl: string,
  assetUrl: string,
  normalize: (source: string) => string,
): SourceMapResult {
  const json = JSON.parse(text.trimStart().replace(XSSI_PREFIX, "")) as SourceMapInput;
  const map = new AnyMap(json, mapUrl.startsWith("data:") ? assetUrl : mapUrl);
  const sources: SourceFile[] = [];
  const missingContent: string[] = [];
  const seen = new Set<string>();

  map.sources.forEach((original, index) => {
    const name = original ?? map.resolvedSources[index] ?? `source-${index}`;
    const content = map.sourcesContent?.[index];
    if (content == null) {
      missingContent.push(name);
      return;
    }
    const path = normalize(name);
    if (seen.has(path)) return;
    seen.add(path);
    sources.push({ path, originalPath: name, content });
  });

  return { assetUrl, mapUrl, raw: text, sources, missingContent };
}
