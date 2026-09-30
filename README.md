# unbundle

[![npm](https://img.shields.io/npm/v/@reekeer/unbundle)](https://www.npmjs.com/package/@reekeer/unbundle)
[![Status](https://img.shields.io/badge/status-beta-orange)](#status)
[![Bun](https://img.shields.io/badge/bun-%3E%3D1.4-black)](https://bun.sh/)
[![License](https://img.shields.io/badge/license-MIT-green)](#license)
[![CI](https://github.com/reekeer/unbundle/actions/workflows/release.yml/badge.svg)](https://github.com/reekeer/unbundle/actions/workflows/release.yml)

Opens a site the way a browser does and turns its production bundles back into a readable
project: modules split out of chunks, names restored, components one per file, libraries
recognized and imported from their packages. Works without source maps and never executes
the site's JavaScript.

## Install

```sh
bunx @reekeer/unbundle https://example.com
```

`npx @reekeer/unbundle` and `pnpm dlx @reekeer/unbundle` work too. The CLI runs on Bun; with
only Node installed, the `bin/unbundle.mjs` launcher uses a system `bun` or fetches it with
`npx bun`.

## Usage

```sh
unbundle <url> [options]
```

| option | meaning |
|---|---|
| `-o, --out <dir>` | output root (default: `unbun`) |
| `--depth <n>` | link depth to crawl (default: 2, 0 = only the given page) |
| `--max-pages <n>` | pages to crawl inside the site scope (default: 20) |
| `--include-external` | also load third-party scripts |
| `--standalone` | Next.js App Router: write `html/<page>.standalone.html` marking the DOM of each Client Component |
| `-v, --verbose` / `-q, --quiet` | every request / errors only |
| `--no-rename`, `--no-format` | debugging: keep minified names / skip prettier |

A site may live under a sub-path (`https://host/t/app`): every URL is resolved against the
page, the Next.js basePath is taken from where `/_next/` sits.

```
  unbundle v0.1.1  -> https://example.com/

[ + ] detected bundler: vite
[ + ] found 20 pages
[ + ] loaded 2 files in 25 requests
[ + ] split index-DHFlp4-Z into 9 modules: react, react/jsx-runtime, scheduler, react-dom, react-router, …
[ + ] restored 1947 names in 29 files
[ + ] recognized libraries: react, scheduler, react-dom, react-router, react-router-dom

[ + ] done
      bundler      vite
      pages        20 (27 requests)
      coverage     complete
      output       unbun/example.com
```

A failed request never stops the run; it is listed in `.unbundle/manifest.json`.

## Output

```
unbun/<host>/
  src/ (app/ for Nuxt)   the recovered project, .ts/.tsx when the site was written in TypeScript
    App.jsx | app.vue    root component
    pages/, routes/      routes (Nuxt route table, React Router / SvelteKit route modules)
    components/          one component per file (.jsx, .vue, Angular .component.ts)
    composables/, hooks/ use* functions
    stores/              zustand, Pinia
    api/                 the site's API client, models, errors, fetch*/create* functions
    utils/, constants/   helpers and shared values
    icons/               the site's own SVG icons (known icon libraries are imported instead)
    layouts/, middleware/, plugins/   Nuxt
    assets/css/          app.css (site rules) + tailwind.css
    _chunks/             what could not be split: bootstrap code, shared state, runtime
  i18n/locales/          vue-i18n messages turned back into strings
  vendor/                library code under real package paths (react/…, next/dist/client/…)
  package.json           recognized packages with versions, scripts for the framework
  tsconfig.json | jsconfig.json, nuxt.config.ts, astro.config.mjs, vite.config.ts …
  .chunks/               everything exactly as downloaded, page data (RSC payload, Nuxt payload)
  .unbundle/
    manifest.json        URL → file, bundler, modules, coverage, findings, errors, quality
    strings.json         every string literal, endpoints and URLs first
    network.har          every request made (DevTools → Network → Import HAR)
```

The output opens in VS Code as a project: relative imports resolve, library code lives in
`vendor/` so `npm install` can add real packages and types without touching it.

`manifest.json` also reports:

- `coverage`: loaders the emulator could not follow (`import(x)`, `script.src = …`, workers)
  with file and line, modules that were imported but never loaded, failed resources;
- `findings`: hash and cipher implementations recognized by their constants (SHA-256, MD5,
  ChaCha20, AES …), proof-of-work loops, `crypto.subtle`, sign-in and captcha integrations
  (Telegram Login Widget and Mini App, TON Connect, Google, Apple, VK, Yandex, OAuth, passkeys,
  Firebase, Supabase, Clerk, Auth0, NextAuth, Turnstile, reCAPTCHA, hCaptcha);
- `summary.quality`: readable module names, share of 1–2 letter identifiers, recognized
  packages.

## Supported bundlers and frameworks

| adapter | recognized by | recovered |
|---|---|---|
| `next` | `/_next/static/`, RSC payload, `__NEXT_DATA__` | webpack and Turbopack chunks, RSC client references, Pages Router |
| `nuxt` | `/_nuxt/`, `__NUXT_DATA__`, import map `#entry` | `.vue` files with `<script setup>`, route table → `pages/`, layouts, middleware, plugins, i18n |
| `react-router` | `__reactRouterContext`, `__remixContext` | route modules with `meta`, `loader`, `clientLoader`, `Layout` |
| `astro` | `<astro-island>` | `.astro` pages with a shared layout, islands per framework |
| `sveltekit` | `__sveltekit_*`, `/_app/immutable/` | `+page`, `+layout`, `+error` by the route dictionary |
| `angular` | Ivy definitions, `main-<HASH>.js`, `<app-*>` | components with templates (`@if`, `@for`, bindings), pipes, services, routes |
| `webpack`, `rspack` | JSONP chunks, runtime, `.cw` wrappers | module map, lazy chunks (webpack 4 and 5, Rspack) |
| `vite` | `/assets/<name>-<hash>.js`, preload helpers | ES chunks, rolldown `__commonJS` wrappers, lazy chunks via `__vite__mapDeps` |
| `esbuild` | `__commonJS` helpers, `chunk-<HASH>.js` | commonjs wrappers, ES chunks |

Import maps are honoured like a browser does. A new bundler is one file,
`src/adapters/<name>.ts` with `export default defineAdapter({ … })`; the registry loads
every file in that directory.

## How it works

`src/pipeline.ts` is the whole flow, top to bottom:

| step | what happens |
|---|---|
| open | GET the page with Chrome's headers, cookies, redirects, meta refresh |
| detect | every adapter scores the page, then the loaded scripts if nothing fits |
| crawl | links inside the site scope, then routes found as strings in the code (`router.push("/settings")`), skipping risky ones such as `/logout` |
| load | scripts, module graph, preloads, `Link` headers, CSS `@import`, workers, lazy chunks the adapter finds in the code |
| source maps | `sourceMappingURL`, `SourceMap` header, `<file>.map` → `sourcesContent` |
| unpack | chunks are split into modules and rewritten to `import`/`export` |
| refine | deminify, JSX recovery (webcrack), renaming by usage (a rename never changes what a reference points to), library fingerprints, icons folded back into imports |
| lay out | app code split by kind into `components/`, `pages/`, `hooks/`, `stores/`, `utils/` …; compiled Vue SFCs become `.vue` files; React namespaces become named imports |
| format | prettier |
| write | the project, `.chunks/`, `.unbundle/` |

### Library fingerprints

`fingerprints.sigdb` is built with [`@reekeer/sigdb`](https://github.com/reekeer/sigdb-ts)
from about 300 npm packages: one item per library file and one per exported or local function,
plus the component names of Vue kits (reka-ui, Nuxt UI, element-plus, vuetify, naive-ui …).
Recognized modules go to `vendor/<package>/…` and the site's imports come from the package:
`import { computed } from "vue"`, `import { useQuery } from "@tanstack/react-query"`.

### Icons

Icon definitions become imports of their library: lucide (react, vue, svelte), tabler,
phosphor, MUI, Ant Design, Font Awesome and simple-icons by their names; heroicons,
react-icons, Radix, Remix, Feather, Bootstrap, Octicons and MDI by the shape of the SVG,
looked up in `icons.sigdb` (about 68 000 icons).

### `--standalone`

For Next.js App Router pages, `html/<page>.standalone.html` is the server HTML where every DOM
node rendered by a Client Component carries `data-component="Name"` and
`data-component-src="…"`, with an overlay that outlines them on hover. Server Component names
are gone from the Flight payload by design, so server markup stays unannotated; ambiguous
spans are listed under `unaligned` instead of guessed.

## Development

```sh
bun install
bun run unbundle https://example.com
bun run typecheck
bun run test             # unit + end-to-end, all test files in parallel
bun run test:unit        # a few seconds
bun run test:e2e
bun run fixtures [app]   # rebuild the fixture sites from test/fixtures/apps/*.tar.gz
bun run fingerprints     # rebuild fingerprints.sigdb and icons.sigdb
```

`bun run test` mirrors the sources, tests, fixtures and databases into
`~/.cache/unbundle-test` (`UNBUNDLE_TEST_DIR` overrides it) and runs `bun test --parallel`
there, so a checkout on a network share stays fast; extra arguments go to `bun test`.

Fixtures are four apps stored as source archives in `test/fixtures/apps/`, built into
`test/fixtures/sites/<site>.tar.gz`:

| app | sites | covers |
|---|---|---|
| `next-app` | `site-next`, `site-next-turbopack` | Next 16 App Router and Pages Router under `/t/tttt`, Tailwind, lucide-react, zustand, TanStack Query, Suspense streaming |
| `nuxt-app` | `site-nuxt` | Nuxt 4, Pinia, lucide-vue-next, scoped styles, slots, `v-model` |
| `vite-app` | `site-vite`, `site-rr7`, `site-astro`, `site-sveltekit`, `site-angular` | React SPA, React Router 7, Astro islands, SvelteKit, Angular |
| `webpack-app` | `site-webpack`, `site-rspack` | webpack 5 and Rspack builds, an inlined SHA-256 proof-of-work |

`bun run fingerprints` installs the packages into `.cache/fingerprints`; on a slow disk point
`UNBUNDLE_FP_CACHE` at a local directory with the same `package.json`.

`.github/workflows/release.yml` typechecks and tests every push and pull request; a `v*` tag
also publishes the packed tarball to npm (trusted publishing) and to a GitHub release.

## License

MIT, see [LICENSE](LICENSE).
