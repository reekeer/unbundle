import type { ModuleRecord } from "../types.ts";
import { behaviorNames, constantNames, factoryResultNames } from "./analyze.ts";
import { nameCommonJsWrappers } from "./cjs.ts";
import { displayNameExports, importPackageFunctions, outlineIifes, readableLocalExports, renameExports, renameLocals } from "./cleanup.ts";
import {
  buildFunctionIndex,
  entryExports,
  packageFamily,
  exportNames,
  hasForeignExport,
  identifyConcatenated,
  identifyByNames,
  packageFeatureSet,
  identifySmall,
  rankLocal,
  identifyModule,
  idiomPrints,
  libraryExports,
  matchFunctions,
  matchLocals,
  printModule,
  type FingerprintDb,
  type FunctionIndex,
  type Identification,
  type ModulePrint,
} from "./fingerprint.ts";

const ROUNDS = 4;

export interface IdentifyResult {
  identified: Map<string, Identification>;
  exportRenames: Map<string, Map<string, string>>;
  localRenames: Map<string, Map<string, string>>;
  libraryFunctions: Map<string, string>;
  libraryPackages: Map<string, number>;
  namespaces: Map<string, string>;
  mixed: Map<string, string>;
  warnings: Array<{ module: string; message: string }>;
}

type Match = { name: string; confidence?: number; package?: string };

function pick(matches: Iterable<[string, Match]>, taken: Set<string>): Map<string, string> {
  const renames = new Map<string, string>();
  for (const [from, match] of [...matches].sort((a, b) => (b[1].confidence ?? 0) - (a[1].confidence ?? 0))) {
    if (taken.has(match.name) || renames.has(from)) continue;
    taken.add(match.name);
    renames.set(from, match.name);
  }
  return renames;
}

export function nameModuleLocals(code: string): string {
  const factories = factoryResultNames(code);
  if (factories.size) code = renameLocals(code, factories);
  const print = printModule(code);
  const taken = new Set([...print.locals, ...print.exports].map((f) => f.name));
  const behavior = pick([...behaviorNames(code, print.locals.filter((l) => l.name.length <= 2).map((l) => l.name))].map(([k, name]) => [k, { name }] as [string, Match]), taken);
  if (behavior.size) code = renameLocals(code, behavior);
  const constants = constantNames(code);
  return constants.size ? renameLocals(code, constants) : code;
}

function readableNames(print: ModulePrint): Set<string> {
  return new Set([...print.known, ...[...print.locals, ...print.exports].map((f) => f.name).filter((n) => n.length > 2)]);
}

function renameRound(mod: ModuleRecord, print: ModulePrint, index: FunctionIndex, libraryFunctions: Map<string, string>, libraryPackages: Map<string, number>, last: boolean, entryOf: (pkg: string) => Set<string>) {
  const known = readableNames(print);
  const taken = new Set([...print.locals, ...print.exports].map((f) => f.name));
  const minifiedLocals = print.locals.filter((l) => l.name.length <= 2 || /^_?(Component|Context)\d+$/.test(l.name));
  const minifiedExports = print.exports.filter((e) => e.name.length <= 2);
  const localMatches = new Map<string, Match>(matchLocals(minifiedLocals, index, known));
  const exportMatches = new Map<string, Match>(matchLocals(minifiedExports, index, known));
  for (const match of [...localMatches.values(), ...exportMatches.values()]) libraryFunctions.set(match.name, match.package ?? libraryFunctions.get(match.name) ?? "");
  if (last) {
    const readable = [...print.locals, ...print.exports].filter((f) => f.name.length > 2 && !libraryFunctions.has(f.name));
    for (const [name, match] of matchLocals(readable, index, known)) {
      if (match.name === name || (/^_Component\d*$/.test(name) && match.confidence >= 0.9)) libraryFunctions.set(name, match.package);
    }
    const detected = [...libraryPackages].filter(([, n]) => n >= 3).map(([pkg]) => pkg);
    for (const fn of readable) {
      if (libraryFunctions.has(fn.name) || !fn.links?.length) continue;
      const owner = detected.find((pkg) => entryOf(pkg).has(fn.name) && fn.links!.some((l) => libraryFunctions.get(l) === pkg));
      if (owner) libraryFunctions.set(fn.name, owner);
    }
    const idioms = idiomPrints();
    if (mod.origin === "bundle" || mod.origin === "app") {
      for (const [from, match] of matchFunctions(minifiedLocals.filter((l) => !localMatches.has(l.name)), idioms)) localMatches.set(from, match);
    }
    for (const [from, match] of matchFunctions(minifiedExports.filter((e) => !exportMatches.has(e.name)), idioms)) exportMatches.set(from, match);
  }
  const locals = pick(localMatches, taken);
  const exports = pick(exportMatches, taken);
  const confident = new Map<string, string>();
  for (const [from, to] of [...locals, ...exports]) {
    const match = localMatches.get(from) ?? exportMatches.get(from);
    const pkg = match?.package;
    if (pkg && match?.name === to) {
      libraryPackages.set(pkg, (libraryPackages.get(pkg) ?? 0) + 1);
      if ((match.confidence ?? 0) >= 0.95) confident.set(to, pkg);
    }
  }
  return { locals, exports, confident };
}

function apiRenames(print: ModulePrint, own: FunctionIndex, api: Set<string>, taken: Set<string>): Map<string, string> {
  const known = readableNames(print);
  const out = new Map<string, string>();
  const ranked = print.exports
    .filter((e) => e.name.length <= 2 && e.features.length > 0)
    .map((fn) => ({ fn, list: rankLocal(fn, own, known).filter((c) => api.has(c.name)) }))
    .sort((a, b) => (b.list[0]?.score ?? 0) - (a.list[0]?.score ?? 0));
  for (const { fn, list } of ranked) {
    const [best] = list;
    const second = list.find((c) => c.name !== best?.name);
    if (!best || best.score < 0.75 || (second && best.score - second.score < 0.2) || taken.has(best.name)) continue;
    out.set(fn.name, best.name);
    taken.add(best.name);
  }
  return out;
}

function merge(into: Map<string, Map<string, string>>, key: string, renames: Map<string, string>): void {
  if (renames.size) into.set(key, new Map([...(into.get(key) ?? []), ...renames]));
}

export function identifyAndRename(modules: ModuleRecord[], keyOf: (m: ModuleRecord) => string, db: FingerprintDb): IdentifyResult {
  const result: IdentifyResult = { identified: new Map(), exportRenames: new Map(), localRenames: new Map(), libraryFunctions: new Map(), libraryPackages: new Map(), namespaces: new Map(), mixed: new Map(), warnings: [] };
  const index = buildFunctionIndex(db);
  const families = new Map<string, FunctionIndex>();
  const familyIndex = (name: string) => {
    let found = families.get(name);
    if (!found) families.set(name, (found = buildFunctionIndex(db, packageFamily(name))));
    return found;
  };
  const prints = new Map<string, ModulePrint>();
  const byFeatures = new Map<string, Identification>();
  for (const mod of modules) {
    if (mod.origin === "bundle" || mod.origin === "app") continue;
    try {
      const print = printModule(mod.code);
      prints.set(keyOf(mod), print);
      const library = identifyModule(print, db, exportNames(mod.code)) ?? identifyConcatenated(print, db);
      if (library) byFeatures.set(keyOf(mod), library);
    } catch (err) {
      result.warnings.push({ module: mod.id, message: err instanceof Error ? err.message : String(err) });
    }
  }
  const knownFeatures = packageFeatureSet(db, new Set([...byFeatures.values()].map((l) => l.package)));
  for (const mod of modules) {
    const key = keyOf(mod);
    const library = byFeatures.get(key);
    if (!library || !hasForeignExport(mod.code, knownFeatures)) continue;
    byFeatures.delete(key);
    result.mixed.set(key, library.package);
    result.libraryPackages.set(library.package, (result.libraryPackages.get(library.package) ?? 0) + 3);
  }
  const packages = new Set([...byFeatures.values()].map((l) => l.package));
  const byNames = new Map<string, Identification>();
  for (const mod of modules) {
    const key = keyOf(mod);
    if (!prints.has(key) || byFeatures.has(key) || result.mixed.has(key)) continue;
    try {
      const library = identifyByNames(exportNames(mod.code), prints.get(key)!, db, packages) ?? identifySmall(prints.get(key)!, db, packages);
      if (library) byNames.set(key, library);
    } catch {
      continue;
    }
  }

  for (const mod of modules) {
    const key = keyOf(mod);
    try {
      let print = prints.get(key) ?? printModule(mod.code);
      const found = byFeatures.get(key) ?? byNames.get(key);
      if (!mod.package && found && /^@vue\/runtime-(dom|core)$/.test(found.package) && (/runtime-dom/.test(mod.id) || print.exports.length >= 40)) {
        mod.package = { name: "vue", specifier: "vue" };
        const vue = { package: "vue", file: "index.js", entry: true, specifier: "vue", confidence: found.confidence };
        if (byFeatures.has(key)) byFeatures.set(key, vue);
        else byNames.set(key, vue);
      }
      const own = mod.package ? familyIndex(mod.package.name) : null;
      const library = byFeatures.get(key) ?? byNames.get(key) ?? null;
      const owner = byFeatures.get(key) ?? byNames.get(key) ?? (result.mixed.has(key) ? { package: result.mixed.get(key)! } : undefined);
      let probeCache: { code: string; print: ModulePrint } | null = null;
      mod.code = outlineIifes(mod.code, (probe, i) => {
        if (probeCache?.code !== probe) probeCache = { code: probe, print: printModule(probe) };
        const probed = probeCache.print;
        const fn = probed.locals.find((l) => l.name === `__iife_${i}`);
        if (!fn || fn.features.length < 8) return null;
        const [best, second] = rankLocal(fn, index, readableNames(probed));
        if (!best) return null;
        const related = owner && (best.package === owner.package || best.package.split("/")[0] === owner.package.split("/")[0]);
        const confident = best.score >= 0.85 && best.score - (second?.score ?? 0) >= 0.1;
        if (!confident && !(related && best.score >= 0.4 && best.score >= (second?.score ?? 0) * 1.3)) return null;
        result.libraryFunctions.set(best.name, best.package);
        return best.name;
      });
      const displayNames = displayNameExports(mod.code);
      if (displayNames.size) {
        mod.code = renameExports(mod.code, displayNames);
        merge(result.exportRenames, key, displayNames);
        print = printModule(mod.code);
      }
      if (library) {
        result.identified.set(key, library);
        const mangled = print.exports.filter((e) => e.name.length <= 2);
        const matches = new Map<string, Match>(matchFunctions(mangled, libraryExports(db, library)));
        for (const [from, match] of matchLocals(mangled.filter((e) => !matches.has(e.name)), own?.functions.length ? own : index, readableNames(print))) matches.set(from, match);
        const renames = pick(matches, new Set(print.exports.map((e) => e.name)));
        if (renames.size) mod.code = renameExports(mod.code, renames);
        merge(result.exportRenames, key, renames);
        if (own?.functions.length && mod.package) {
          print = printModule(mod.code);
          const api = apiRenames(print, own, entryExports(db, mod.package.specifier), new Set([...print.exports, ...print.locals].map((f) => f.name)));
          if (api.size) mod.code = renameExports(mod.code, api);
          merge(result.exportRenames, key, api);
        }
        continue;
      }

      const wrapped = nameCommonJsWrappers(mod.code, (body) => identifyModule(printModule(body), db));
      if (wrapped.found.length) {
        mod.code = wrapped.code;
        for (const [name, specifier] of wrapped.namespaces) result.namespaces.set(name, specifier);
        for (const found of wrapped.found) {
          result.libraryFunctions.set(found.fn, found.package);
          result.libraryPackages.set(found.package, (result.libraryPackages.get(found.package) ?? 0) + 3);
        }
        print = printModule(mod.code);
      }
      const confidentAll = new Map<string, string>();
      for (let round = 0; round < ROUNDS; round++) {
        const last = round === ROUNDS - 1;
        const { locals, exports, confident } = renameRound(mod, print, own?.functions.length ? own : index, result.libraryFunctions, result.libraryPackages, last, (pkg) => entryExports(db, pkg));
        for (const [name, pkg] of confident) confidentAll.set(name, pkg);
        if (locals.size) mod.code = renameLocals(mod.code, locals);
        if (exports.size) mod.code = renameExports(mod.code, exports);
        merge(result.localRenames, key, locals);
        merge(result.exportRenames, key, exports);
        if (!locals.size && !exports.size && !last) {
          round = ROUNDS - 2;
          continue;
        }
        print = printModule(mod.code);
      }

      if (own?.functions.length && mod.package) {
        const api = apiRenames(print, own, entryExports(db, mod.package.specifier), new Set([...print.exports, ...print.locals].map((f) => f.name)));
        if (api.size) mod.code = renameExports(mod.code, api);
        merge(result.exportRenames, key, api);
      }
      const packageImports = new Map([...confidentAll].filter(([name, pkg]) => entryExports(db, pkg).has(name)));
      if (packageImports.size && !mod.package && !byFeatures.has(key) && !byNames.has(key)) mod.code = importPackageFunctions(mod.code, packageImports);
      const factoryNames = factoryResultNames(mod.code);
      if (factoryNames.size) {
        mod.code = renameLocals(mod.code, factoryNames);
        merge(result.localRenames, key, factoryNames);
      }
      const readable = readableLocalExports(mod.code);
      if (readable.size) mod.code = renameExports(mod.code, readable);
      merge(result.exportRenames, key, readable);
      print = printModule(mod.code);
      const taken = new Set([...print.locals, ...print.exports].map((f) => f.name));
      const short = print.locals.filter((l) => l.name.length <= 3).length;
      const crowded = short >= 10 && (short >= print.locals.length * 0.5 || print.locals.filter((l) => l.name.length <= 2).length >= 100);
      const threeLetter = new Set(crowded ? print.locals.filter((l) => /^[A-Za-z_$][\w$]{2}$/.test(l.name)).map((l) => l.name) : []);
      const behaviorLocals = pick(
        [...behaviorNames(mod.code, print.locals.filter((l) => l.name.length <= 2 || threeLetter.has(l.name)).map((l) => l.name), threeLetter)].map(([k, name]) => [k, { name }] as [string, Match]),
        taken,
      );
      if (behaviorLocals.size && (mod.origin === "bundle" || mod.origin === "app")) {
        mod.code = renameLocals(mod.code, behaviorLocals);
        merge(result.localRenames, key, behaviorLocals);
      }
      const behaviorExports = pick(
        [...behaviorNames(mod.code, print.exports.filter((e) => e.name.length <= 2 || (crowded && /^[A-Za-z_$][\w$]{2}$/.test(e.name))).map((e) => e.name), new Set(crowded ? print.exports.filter((e) => /^[A-Za-z_$][\w$]{2}$/.test(e.name)).map((e) => e.name) : []))].map(([k, name]) => [k, { name }] as [string, Match]),
        taken,
      );
      if (behaviorExports.size) mod.code = renameExports(mod.code, behaviorExports);
      merge(result.exportRenames, key, behaviorExports);
      if (mod.origin === "bundle" || mod.origin === "app") {
        const constants = constantNames(mod.code);
        if (constants.size) {
          mod.code = renameLocals(mod.code, constants);
          merge(result.localRenames, key, constants);
        }
      }
    } catch (err) {
      result.warnings.push({ module: mod.id, message: err instanceof Error ? err.message : String(err) });
    }
  }
  return result;
}
