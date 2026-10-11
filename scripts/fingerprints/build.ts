import { rmSync } from "node:fs";
import { build, readRules } from "@reekeer/sigdb";
import { join, relative, resolve } from "node:path";
import { COMPONENT_INDEX, FINGERPRINTS_PATH, FUNCTION_INDEX } from "../../src/refine/fingerprint.ts";
import { buildIcons } from "./icons.ts";
import { componentRules, extractLibraries, FINGERPRINTS_BUILD, packageRules } from "./extract.ts";

const ROOT = resolve(import.meta.dir, "../..");
const CACHE = process.env.UNBUNDLE_FP_CACHE ?? join(ROOT, ".cache/fingerprints");
const SOURCES = join(ROOT, "sigdb");
const MODULES = join(CACHE, "node_modules");

const { files } = extractLibraries(MODULES);
const packages = packageRules(files);
rmSync(SOURCES, { recursive: true, force: true });
for (const pkg of packages) {
  await Bun.write(join(SOURCES, "files", pkg.source), `${JSON.stringify(pkg.files, null, 1)}\n`);
  await Bun.write(join(SOURCES, "functions", pkg.source), `${JSON.stringify(pkg.functions, null, 1)}\n`);
}
const components = componentRules(MODULES);
await Bun.write(join(SOURCES, "components.json"), `${JSON.stringify(components, null, 1)}\n`);
const { groups, indexes, metadata } = FINGERPRINTS_BUILD;
const result = build(readRules(join(SOURCES, "files")), FINGERPRINTS_PATH, {
  groups,
  indexes: {
    [FUNCTION_INDEX]: { rules: readRules(join(SOURCES, "functions")), groups: indexes[FUNCTION_INDEX]!.groups },
    [COMPONENT_INDEX]: { rules: components, groups: indexes[COMPONENT_INDEX]!.groups },
  },
  metadata: { ...metadata, packages: packages.map((p) => p.package).sort() },
});
console.log(`${Object.keys(components).length} library components`);
console.log(`wrote ${files.length} file prints (${(result.size / 1024).toFixed(0)} kB) to ${relative(ROOT, FINGERPRINTS_PATH)}, sources in ${relative(ROOT, SOURCES)}/`);
const icons = buildIcons(MODULES);
console.log(`wrote ${icons.icons} icon shapes (${(icons.size / 1024).toFixed(0)} kB) to icons.sigdb`);
