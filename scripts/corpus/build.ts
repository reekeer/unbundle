import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../..");
const OUT = join(ROOT, ".cache/corpus");

type Files = Record<string, string>;

interface CorpusApp {
  name: string;
  files: Files;
  build: string[][];
  output: string;
}

async function run(cmd: string[], cwd: string): Promise<void> {
  const proc = Bun.spawn(cmd, { cwd, stdout: "inherit", stderr: "inherit", env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" } });
  if ((await proc.exited) !== 0) throw new Error(`${cmd.join(" ")} failed in ${cwd}`);
}

const nextLibs: CorpusApp = {
  name: "next-libs",
  output: "out",
  build: [["bun", "install"], ["bun", "--bun", "node_modules/next/dist/bin/next", "build", "--webpack"]],
  files: {
    "package.json": JSON.stringify({
      name: "corpus-next-libs",
      private: true,
      dependencies: {
        next: "16.3.6",
        react: "19.3.0",
        "react-dom": "19.3.0",
        zustand: "5.0.15",
        "@tanstack/react-query": "5.103.2",
        "@radix-ui/react-dialog": "1.1.23",
        axios: "1.20.0",
        clsx: "2.1.1",
      },
      trustedDependencies: [],
    }),
    "next.config.mjs": `export default { output: "export", turbopack: { root: import.meta.dirname } };`,
    "app/layout.jsx": `import Providers from "../components/Providers";
export const metadata = { title: "Corpus" };
export default function RootLayout({ children }) {
  return <html lang="en"><body><nav><a href="/">Home</a> <a href="/dashboard/">Dashboard</a> <a href="/settings/">Settings</a> <a href="/users/1/">User</a> <a href="/dialog/">Dialog</a></nav><Providers>{children}</Providers></body></html>;
}`,
    "components/Providers.jsx": `"use client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
export default function Providers({ children }) {
  const [client] = useState(() => new QueryClient());
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}`,
    "lib/store.js": `import { create } from "zustand";
export const useSession = create((set) => ({ user: null, login: (user) => set({ user }), logout: () => set({ user: null }) }));`,
    "lib/api.js": `import axios from "axios";
export const api = axios.create({ baseURL: "/api/v1" });
export async function fetchUser(id) { const { data } = await api.get(\`/users/\${id}\`); return data; }
export async function fetchStats() { const { data } = await api.get("/stats"); return data; }`,
    "app/page.jsx": `import Welcome from "../components/Welcome";
export default function Home() { return <main><h1>CORPUS_HOME</h1><Welcome /></main>; }`,
    "components/Welcome.jsx": `"use client";
import clsx from "clsx";
import { useSession } from "../lib/store";
export default function Welcome() {
  const user = useSession((s) => s.user);
  const login = useSession((s) => s.login);
  return <section className={clsx("welcome", user && "signed-in")}>{user ? \`CORPUS_HELLO \${user}\` : <button onClick={() => login("ada")}>Sign in</button>}</section>;
}`,
    "app/dashboard/page.jsx": `import Stats from "../../components/Stats";
export default function Dashboard() { return <main><h1>CORPUS_DASHBOARD</h1><Stats /></main>; }`,
    "components/Stats.jsx": `"use client";
import { useQuery } from "@tanstack/react-query";
import { fetchStats } from "../lib/api";
export default function Stats() {
  const { data, isLoading } = useQuery({ queryKey: ["stats"], queryFn: fetchStats });
  return <p>{isLoading ? "CORPUS_LOADING" : JSON.stringify(data)}</p>;
}`,
    "app/settings/page.jsx": `import SettingsForm from "../../components/SettingsForm";
export default function Settings() { return <main><h1>CORPUS_SETTINGS</h1><SettingsForm /></main>; }`,
    "components/SettingsForm.jsx": `"use client";
import { useState } from "react";
export default function SettingsForm() {
  const [theme, setTheme] = useState("light");
  const [saved, setSaved] = useState(false);
  async function save() { const { persist } = await import("../lib/persist"); persist({ theme }); setSaved(true); }
  return <form onSubmit={(e) => { e.preventDefault(); save(); }}><select value={theme} onChange={(e) => setTheme(e.target.value)}><option>light</option><option>dark</option></select><button>Save</button>{saved && <span>CORPUS_SAVED</span>}</form>;
}`,
    "lib/persist.js": `export function persist(settings) { localStorage.setItem("corpus-settings", JSON.stringify(settings)); return "CORPUS_PERSISTED"; }`,
    "app/users/[id]/page.jsx": `import UserCard from "../../../components/UserCard";
export function generateStaticParams() { return [{ id: "1" }, { id: "2" }]; }
export default async function User({ params }) { const { id } = await params; return <main><h1>CORPUS_USER</h1><UserCard id={id} /></main>; }`,
    "components/UserCard.jsx": `"use client";
import { useQuery } from "@tanstack/react-query";
import { fetchUser } from "../lib/api";
export default function UserCard({ id }) {
  const { data } = useQuery({ queryKey: ["user", id], queryFn: () => fetchUser(id) });
  return <article>{data?.name ?? \`CORPUS_USER_\${id}\`}</article>;
}`,
    "app/dialog/page.jsx": `import ConfirmDialog from "../../components/ConfirmDialog";
export default function DialogPage() { return <main><h1>CORPUS_DIALOG</h1><ConfirmDialog /></main>; }`,
    "components/ConfirmDialog.jsx": `"use client";
import * as Dialog from "@radix-ui/react-dialog";
export default function ConfirmDialog() {
  return <Dialog.Root><Dialog.Trigger>Open</Dialog.Trigger><Dialog.Portal><Dialog.Overlay /><Dialog.Content><Dialog.Title>CORPUS_CONFIRM</Dialog.Title><Dialog.Close>Close</Dialog.Close></Dialog.Content></Dialog.Portal></Dialog.Root>;
}`,
  },
};

const viteRouter: CorpusApp = {
  name: "vite-router",
  output: "dist",
  build: [["bun", "install"], ["bun", "--bun", "node_modules/vite/bin/vite.js", "build"]],
  files: {
    "package.json": JSON.stringify({
      name: "corpus-vite-router",
      private: true,
      type: "module",
      dependencies: { react: "19.3.0", "react-dom": "19.3.0", "react-router": "8.4.0", axios: "1.20.0", zustand: "5.0.15" },
      devDependencies: { vite: "^7" },
      trustedDependencies: ["esbuild"],
    }),
    "index.html": `<!doctype html><html><head><title>Corpus Vite</title></head><body><div id="root"></div><script type="module" src="/src/main.js"></script></body></html>`,
    "vite.config.js": `export default { logLevel: "warn" };`,
    "src/main.js": `import { createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router";
import Layout from "./Layout.js";
const router = createBrowserRouter([{ path: "/", element: h(Layout), children: [
  { index: true, lazy: () => import("./routes/home.js") },
  { path: "users", lazy: () => import("./routes/users.js") },
  { path: "about", lazy: () => import("./routes/about.js") },
] }]);
createRoot(document.getElementById("root")).render(h(RouterProvider, { router }));`,
    "src/Layout.js": `import { createElement as h } from "react";
import { Link, Outlet } from "react-router";
import { useCart } from "./store.js";
export default function Layout() { const count = useCart((s) => s.items.length); return h("div", null, h("nav", null, h(Link, { to: "/" }, "Home"), h(Link, { to: "/users" }, "Users"), h(Link, { to: "/about" }, "About"), \`VITE_CART \${count}\`), h(Outlet)); }`,
    "src/store.js": `import { create } from "zustand";
export const useCart = create((set) => ({ items: [], add: (item) => set((s) => ({ items: [...s.items, item] })) }));`,
    "src/api.js": `import axios from "axios";
export const client = axios.create({ baseURL: "/api" });
export const listUsers = () => client.get("/users").then((r) => r.data);`,
    "src/routes/home.js": `import { createElement as h } from "react";
export function Component() { return h("h1", null, "VITE_HOME"); }`,
    "src/routes/users.js": `import { createElement as h, useEffect, useState } from "react";
import { listUsers } from "../api.js";
export function Component() { const [users, setUsers] = useState([]); useEffect(() => { listUsers().then(setUsers); }, []); return h("ul", null, users.map((u) => h("li", { key: u.id }, u.name)), "VITE_USERS"); }`,
    "src/routes/about.js": `import { createElement as h } from "react";
import { useCart } from "../store.js";
export function Component() { const add = useCart((s) => s.add); return h("button", { onClick: () => add("book") }, "VITE_ABOUT"); }`,
  },
};

const nextTailwindLucide: CorpusApp = {
  name: "next-tailwind-lucide",
  output: "out",
  build: [["bun", "install"], ["bun", "--bun", "node_modules/next/dist/bin/next", "build", "--webpack"]],
  files: {
    "package.json": JSON.stringify({
      name: "corpus-next-tailwind-lucide",
      private: true,
      dependencies: { next: "16.3.6", react: "19.3.0", "react-dom": "19.3.0", "lucide-react": "0.460.0", zustand: "5.0.15", clsx: "2.1.1" },
      devDependencies: { tailwindcss: "^4", "@tailwindcss/postcss": "^4", postcss: "^8" },
      trustedDependencies: ["@tailwindcss/oxide"],
    }),
    "next.config.mjs": `export default { output: "export", images: { unoptimized: true }, turbopack: { root: import.meta.dirname } };`,
    "postcss.config.mjs": `export default { plugins: { "@tailwindcss/postcss": {} } };`,
    "app/globals.css": `@import "tailwindcss";\n.tg-card { box-shadow: 0 1px 2px rgb(0 0 0 / 0.08); }\n`,
    "app/layout.jsx": `import "./globals.css";
import Script from "next/script";
import Nav from "../components/Nav";
export const metadata = { title: "Corpus Telegram" };
export default function RootLayout({ children }) {
  return <html lang="en"><body className="bg-slate-50 text-slate-900"><Script src="https://telegram.org/js/telegram-web-app.js" strategy="beforeInteractive" /><Nav />{children}</body></html>;
}`,
    "components/Nav.jsx": `"use client";
import Link from "next/link";
import { House, User, Wallet } from "lucide-react";
export default function Nav() {
  return <nav className="flex gap-3 p-3"><Link href="/" className="flex items-center gap-1"><House className="h-4 w-4" />Home</Link><Link href="/profile/" className="flex items-center gap-1"><User className="h-4 w-4" />Profile</Link><Link href="/wallet/" className="flex items-center gap-1"><Wallet className="h-4 w-4" />Wallet</Link></nav>;
}`,
    "lib/store.js": `import { create } from "zustand";
export const useBalance = create((set) => ({ coins: 10, spend: (n) => set((s) => ({ coins: Math.max(0, s.coins - n) })) }));`,
    "lib/format.js": `export function formatCoins(n) { return n === 1 ? "TG_ONE_COIN" : \`\${n} TG_COINS\`; }
export function shorten(text, max) { return text.length > max ? text.slice(0, max - 1) + "…" : text; }`,
    "app/page.jsx": `import Hero from "../components/Hero";
export default function Home() { return <main className="p-4"><h1 className="text-xl font-semibold">TG_HOME</h1><Hero /></main>; }`,
    "components/Hero.jsx": `"use client";
import clsx from "clsx";
import { useState } from "react";
import { Sparkles, ChevronRight, Bell } from "lucide-react";
import { useBalance } from "../lib/store";
import { formatCoins } from "../lib/format";
function Badge({ children }) { return <span className="rounded-full bg-sky-100 px-2 text-xs text-sky-700">{children}</span>; }
export default function Hero() {
  const coins = useBalance((s) => s.coins);
  const [muted, setMuted] = useState(false);
  return <section className="tg-card mt-3 rounded-xl bg-white p-4"><div className="flex items-center gap-2"><Sparkles className="h-5 w-5 text-amber-500" /><Badge>{formatCoins(coins)}</Badge><button onClick={() => setMuted(!muted)} className={clsx("ml-auto", muted && "opacity-50")}><Bell className="h-4 w-4" /></button></div><a href="/wallet/" className="mt-2 flex items-center text-sm">TG_OPEN_WALLET <ChevronRight className="h-4 w-4" /></a></section>;
}`,
    "app/profile/page.jsx": `import ProfileCard from "../../components/ProfileCard";
export default function Profile() { return <main className="p-4"><h1>TG_PROFILE</h1><ProfileCard /></main>; }`,
    "components/ProfileCard.jsx": `"use client";
import { useEffect, useState } from "react";
import { Copy, Check } from "lucide-react";
import { shorten } from "../lib/format";
function TelegramLogo() { return <svg viewBox="0 0 24 24" width="20" height="20" aria-label="Telegram"><path d="M2 12l20-9-4 18-6-5-4 4z" fill="#229ED9" /></svg>; }
export default function ProfileCard() {
  const [name, setName] = useState("TG_GUEST");
  const [copied, setCopied] = useState(false);
  useEffect(() => { const user = window.Telegram?.WebApp?.initDataUnsafe?.user; if (user) setName(user.first_name); }, []);
  return <div className="tg-card rounded-xl bg-white p-4"><TelegramLogo /><p>{shorten(name, 12)}</p><button onClick={() => setCopied(true)} className="inline-flex items-center gap-1">{copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}TG_COPY_ID</button></div>;
}`,
    "app/wallet/page.jsx": `import WalletPanel from "../../components/WalletPanel";
export default function WalletPage() { return <main className="p-4"><h1>TG_WALLET</h1><WalletPanel /></main>; }`,
    "components/WalletPanel.jsx": `"use client";
import { ArrowDownLeft, ArrowUpRight, Wallet } from "lucide-react";
import { useBalance } from "../lib/store";
import { formatCoins } from "../lib/format";
export default function WalletPanel() {
  const coins = useBalance((s) => s.coins);
  const spend = useBalance((s) => s.spend);
  return <div className="grid gap-2"><div className="flex items-center gap-2"><Wallet className="h-5 w-5" />{formatCoins(coins)}</div><button onClick={() => spend(1)} className="flex items-center gap-1"><ArrowUpRight className="h-4 w-4" />TG_SEND</button><button className="flex items-center gap-1"><ArrowDownLeft className="h-4 w-4" />TG_RECEIVE</button></div>;
}`,
  },
};

const landingComponents: Files = {
  "components/landing/Button.jsx": `export default function Button({ children, onClick }) { return <button onClick={onClick} className="rounded-md bg-indigo-600 px-4 py-2 text-white">{children}</button>; }`,
  "components/landing/Avatar.jsx": `export default function Avatar({ name }) { return <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-slate-200 text-xs">{name.slice(0, 2)}</span>; }`,
  "components/landing/Header.jsx": `import Button from "./Button";
export default function Header({ onSignup }) { return <header className="flex items-center justify-between p-4"><a href="/" className="font-bold">MANY_BRAND</a><Button onClick={onSignup}>Sign up</Button></header>; }`,
  "components/landing/Hero.jsx": `import Button from "./Button";
export default function Hero({ onSignup }) { return <section className="py-16 text-center"><h1 className="text-4xl font-bold">MANY_HERO_TITLE</h1><p className="mt-2 text-slate-600">Build faster</p><Button onClick={onSignup}>Get started</Button></section>; }`,
  "components/landing/FeatureCard.jsx": `export default function FeatureCard({ title, text }) { return <div className="rounded-lg border p-4"><h3 className="font-semibold">{title}</h3><p className="text-sm">{text}</p></div>; }`,
  "components/landing/Features.jsx": `import FeatureCard from "./FeatureCard";
const items = [{ title: "Fast", text: "MANY_FEATURE_FAST" }, { title: "Safe", text: "MANY_FEATURE_SAFE" }, { title: "Cheap", text: "MANY_FEATURE_CHEAP" }];
export default function Features() { return <section id="features" className="grid grid-cols-3 gap-4 p-8"><h2 className="col-span-3 text-2xl">Features</h2>{items.map((i) => <FeatureCard key={i.title} {...i} />)}</section>; }`,
  "components/landing/PriceCard.jsx": `import Button from "./Button";
export default function PriceCard({ plan, price, onPick }) { return <div className="rounded-xl border p-6"><h3 className="text-lg">{plan}</h3><p className="text-3xl">\${price}</p><Button onClick={() => onPick(plan)}>Choose</Button></div>; }`,
  "components/landing/Pricing.jsx": `import { useState } from "react";
import PriceCard from "./PriceCard";
export default function Pricing() { const [picked, setPicked] = useState(null); return <section id="pricing" className="flex gap-4 p-8"><h2 className="text-2xl">Pricing plans</h2><PriceCard plan="Free" price={0} onPick={setPicked} /><PriceCard plan="Pro" price={19} onPick={setPicked} />{picked && <p className="text-green-600">MANY_PICKED {picked}</p>}</section>; }`,
  "components/landing/Testimonial.jsx": `import Avatar from "./Avatar";
export default function Testimonial({ name, quote }) { return <figure className="rounded-lg bg-white p-4 shadow"><blockquote>{quote}</blockquote><figcaption className="mt-2 flex items-center gap-2"><Avatar name={name} />{name}</figcaption></figure>; }`,
  "components/landing/Testimonials.jsx": `import Testimonial from "./Testimonial";
export default function Testimonials() { return <section aria-label="Customer testimonials" className="grid gap-4 p-8"><Testimonial name="Ada" quote="MANY_QUOTE_ADA" /><Testimonial name="Linus" quote="MANY_QUOTE_LINUS" /></section>; }`,
  "components/landing/FaqItem.jsx": `import { useState } from "react";
export default function FaqItem({ q, a }) { const [open, setOpen] = useState(false); return <div className="border-b py-2"><button onClick={() => setOpen(!open)} className="w-full text-left">{q}</button>{open && <p className="text-sm">{a}</p>}</div>; }`,
  "components/landing/Faq.jsx": `import FaqItem from "./FaqItem";
export default function Faq() { return <section className="p-8"><h2 className="text-2xl">Frequently asked questions</h2><FaqItem q="Is it free?" a="MANY_FAQ_FREE" /><FaqItem q="Can I cancel?" a="MANY_FAQ_CANCEL" /></section>; }`,
  "components/landing/Newsletter.jsx": `import { useState } from "react";
import Button from "./Button";
export default function Newsletter() { const [email, setEmail] = useState(""); const [done, setDone] = useState(false); return <form onSubmit={(e) => { e.preventDefault(); setDone(true); }} className="flex gap-2 p-8"><input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Your email" className="rounded border px-2" /><Button>Subscribe</Button>{done && <span>MANY_SUBSCRIBED</span>}</form>; }`,
  "components/landing/Footer.jsx": `export default function Footer() { return <footer className="p-4 text-center text-xs text-slate-500">MANY_FOOTER</footer>; }`,
  "components/landing/Landing.jsx": `"use client";
import { useState } from "react";
import Header from "./Header";
import Hero from "./Hero";
import Features from "./Features";
import Pricing from "./Pricing";
import Testimonials from "./Testimonials";
import Faq from "./Faq";
import Newsletter from "./Newsletter";
import Footer from "./Footer";
export default function Landing() { const [signups, setSignups] = useState(0); const signup = () => setSignups((n) => n + 1); return <div className="min-h-screen"><Header onSignup={signup} /><Hero onSignup={signup} /><p className="text-center">MANY_SIGNUPS {signups}</p><Features /><Pricing /><Testimonials /><Faq /><Newsletter /><Footer /></div>; }`,
};

const nextManyComponents: CorpusApp = {
  name: "next-many-components",
  output: "out",
  build: [["bun", "install"], ["bun", "--bun", "node_modules/next/dist/bin/next", "build", "--webpack"]],
  files: {
    "package.json": JSON.stringify({
      name: "corpus-next-many-components",
      private: true,
      dependencies: { next: "16.3.6", react: "19.3.0", "react-dom": "19.3.0" },
      devDependencies: { tailwindcss: "^4", "@tailwindcss/postcss": "^4", postcss: "^8" },
      trustedDependencies: ["@tailwindcss/oxide"],
    }),
    "next.config.mjs": `export default { output: "export", turbopack: { root: import.meta.dirname } };`,
    "postcss.config.mjs": `export default { plugins: { "@tailwindcss/postcss": {} } };`,
    "app/globals.css": `@import "tailwindcss";\n`,
    "app/layout.jsx": `import "./globals.css";
export default function RootLayout({ children }) { return <html lang="en"><body>{children}</body></html>; }`,
    "app/page.jsx": `import Landing from "../components/landing/Landing";
export default function Home() { return <main><Landing /></main>; }`,
    ...landingComponents,
  },
};

const STRESS_ROUTES = 300;
const stressFiles: Files = {
  "package.json": JSON.stringify({
    name: "corpus-webpack-stress",
    private: true,
    dependencies: { react: "19.3.0", "react-dom": "19.3.0" },
    devDependencies: { webpack: "^5", "webpack-cli": "^6" },
    trustedDependencies: [],
  }),
  "webpack.config.cjs": `const path = require("node:path");
module.exports = { mode: "production", entry: "./src/main.js", output: { path: path.resolve(__dirname, "dist/static/js"), filename: "main.[contenthash:8].js", chunkFilename: "[id].[contenthash:8].chunk.js", publicPath: "/static/js/", clean: true } };`,
  "src/main.js": `import { createElement as h, useState } from "react";
import { createRoot } from "react-dom/client";
const routes = [${Array.from({ length: STRESS_ROUTES }, (_, i) => `() => import("./routes/r${i}.js")`).join(",")}];
function App() { const [text, setText] = useState("STRESS_MAIN"); return h("button", { onClick: async () => { const m = await routes[Math.floor(Math.random() * routes.length)](); setText(m.render()); } }, text); }
createRoot(document.getElementById("root")).render(h(App));`,
};
for (let i = 0; i < STRESS_ROUTES; i++) {
  stressFiles[`src/routes/r${i}.js`] = `export function render() { return "STRESS_ROUTE_${i}_" + ${i} * 7; }`;
}
const webpackStress: CorpusApp = {
  name: "webpack-stress",
  output: "dist",
  build: [["bun", "install"], ["bun", "node_modules/webpack-cli/bin/cli.js", "--config", "webpack.config.cjs"]],
  files: stressFiles,
};

async function buildApp(app: CorpusApp): Promise<void> {
  const work = await mkdtemp(join(tmpdir(), `unbundle-corpus-${app.name}-`));
  try {
    for (const [file, content] of Object.entries(app.files)) await Bun.write(join(work, file), content);
    for (const cmd of app.build) await run(cmd, work);
    if (app.name === "webpack-stress") {
      const main = (await Array.fromAsync(new Bun.Glob("main.*.js").scan(join(work, "dist/static/js"))))[0]!;
      await Bun.write(join(work, "dist/index.html"), `<!doctype html><html><head><title>Stress</title></head><body><div id="root"></div><script defer src="/static/js/${main}"></script></body></html>`);
    }
    const target = join(OUT, app.name, "site");
    await rm(join(OUT, app.name), { recursive: true, force: true });
    await mkdir(join(OUT, app.name), { recursive: true });
    await cp(join(work, app.output), target, { recursive: true });
    console.log(`built ${app.name} -> ${target}`);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

const only = Bun.argv.slice(2);
for (const app of [nextLibs, viteRouter, webpackStress, nextTailwindLucide, nextManyComponents]) {
  if (only.length && !only.includes(app.name)) continue;
  await buildApp(app);
}
