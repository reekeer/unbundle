import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BASE, identified, runSite, serve, serveDirectory, TIMEOUT } from "./support/e2e.ts";
import { brokenImports, exists, modulePath, read, runOn, unresolvedModules } from "./support/run.ts";

describe("nuxt", () => {
  test(
    "compiled SFCs come back as .vue files, pages follow the route table, Nuxt runtime stays library",
    async () => {
      const server = serve("site-nuxt", { serveMaps: false });
      const { outDir, manifest } = await runOn(server.url);
      expect(await brokenImports(outDir)).toEqual([]);
      expect(await unresolvedModules(outDir)).toEqual([]);
      expect(manifest.bundler.adapter).toBe("nuxt");
      expect(manifest.coverage.status).toBe("complete");
      expect(manifest.summary.quality.identifiedPackages).toEqual(expect.arrayContaining(["nuxt", "pinia", "vue-router", "vue"]));

      const app = await read(outDir, "app/app.vue");
      expect(app).toContain('import { House, Info } from "lucide-vue-next";');
      expect(app).toContain('<NuxtLink to="/" class="inline-flex items-center gap-1">');
      expect(app).toContain("<NuxtPage />");
      expect(app).not.toMatch(/import .*Nuxt(Link|Page)/);

      const index = await read(outDir, "app/pages/index.vue");
      expect(index).toContain('<Counter :initial="3" />');
      expect(index).toContain('import Counter from "@/components/Counter.vue";');
      const counter = await read(outDir, "app/components/Counter.vue");
      expect(counter).not.toContain('from "vue"');
      expect(counter).toMatch(/ref\(props\.initial\)/);
      expect(await read(outDir, "app/auto-imports.d.ts")).toContain("const computed:");
      expect(counter).toContain('import { Plus, Minus } from "lucide-vue-next";');
      expect(counter).toContain("const props = defineProps({");
      expect(counter).toMatch(/<strong v-if="\w+">NUXT_COUNTER_MAX<\/strong>/);
      expect(counter).toMatch(/<style scoped>\s*\.counter \{/);

      const about = await read(outDir, "app/pages/about.vue");
      expect(about).toContain("<TodoList />");
      expect(about).toMatch(/<ItemCard :item="\w+" :extra="\{ 'data-kind': 'demo' \}" @remove="\w+">/);
      expect(about).toContain('<template #title="{ text }">');
      expect(about).toMatch(/<component :is="tag">NUXT_REMOVED \{\{ \w+ \}\}<\/component>/);
      expect(about).toContain('var tag = "aside";');
      const card = await read(outDir, "app/components/ItemCard.vue");
      expect(card).toContain('const emit = defineEmits(["remove"]);');
      expect(card).toContain(`<button @click="emit('remove', item.id)">NUXT_REMOVE</button>`);
      expect(card).toContain('<slot name="title" :text="item.text">{{ item.text }}</slot>');
      const todo = await read(outDir, "app/components/TodoList.vue");
      expect(todo).toMatch(/<input v-model="\w+" placeholder="NUXT_TODO_PLACEHOLDER"/);
      expect(todo).toContain('import { Trash2 } from "lucide-vue-next";');
      const store = await read(outDir, "app/stores/todos.js");
      expect(store).not.toContain('from "pinia"');
      expect(store).toContain('defineStore("todos"');

      const vueFiles = (await Array.fromAsync(new Bun.Glob("app/**/*.vue").scan({ cwd: outDir }))).sort();
      expect(vueFiles).toEqual(["app/app.vue", "app/components/Counter.vue", "app/components/ItemCard.vue", "app/components/TodoList.vue", "app/pages/about.vue", "app/pages/index.vue"]);
      expect(await read(outDir, ".chunks/html/index.nuxt.json")).toContain('"serverRendered"');
    },
    TIMEOUT,
  );
});
