/**
 * Builds the component harness: real Tailwind CSS plus an IIFE bundle of the real screens.
 *
 * IIFE rather than ESM so the page loads from file:// with no server — the harness stubs
 * every request anyway, so a server would only add a moving part.
 *
 * The stubs are injected by resolver, not by editing the components. If a screen ever stops
 * compiling against these shims that is worth knowing, because it means the screen grew a
 * dependency on something only the Next server provides.
 */
import esbuild from "esbuild";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");

// ── CSS ───────────────────────────────────────────────────────────────────────
// Sourced explicitly at src/ so utilities used only in one screen are still emitted;
// auto-detection missed them when driven through postcss directly.
const base = fs.readFileSync(path.join(ROOT, "src/app/globals.css"), "utf8")
  .replace('@import "tailwindcss";', "");
const cssIn = '@import "tailwindcss" source(none);\n@source "../../src";\n' + base;
const css = await postcss([tailwind]).process(cssIn, {
  from: path.join(HERE, "_tw.css"),
  to: path.join(HERE, "app.css"),
});
fs.writeFileSync(path.join(HERE, "app.css"), css.css);

// ── Stubs ─────────────────────────────────────────────────────────────────────
const STUBS = {
  "next/link": `
    import React from "react";
    export default function Link({ href, children, ...rest }) {
      return React.createElement("a", { href: typeof href === "string" ? href : "#", ...rest }, children);
    }
  `,
  "next/navigation": `
    export function useParams() { return (window.__PARAMS__ ?? { id: "lead-1" }); }
    export function useRouter() {
      return { push: (u) => { window.__NAV__ = u; }, replace: (u) => { window.__NAV__ = u; },
               back: () => {}, refresh: () => {} };
    }
    export function useSearchParams() {
      return new URLSearchParams(window.__SEARCH__ ?? "");
    }
  `,
  "i18n-context": `
    import { translations } from "@/lib/i18n/translations";
    export function useI18n() {
      const lang = window.__LANG__ ?? "ar";
      return {
        lang,
        t: (k) => {
          const e = translations?.[k];
          if (!e) return k;
          return lang === "ar" ? (e.ar ?? k) : (e.en ?? k);
        },
      };
    }
  `,
  "user-context": `
    export function useUser() { return window.__USER__ ?? null; }
  `,
};

const stubPlugin = {
  name: "harness-stubs",
  setup(build) {
    build.onResolve({ filter: /^next\/link$/ }, () => ({ path: "next/link", namespace: "stub" }));
    build.onResolve({ filter: /^next\/navigation$/ }, () => ({ path: "next/navigation", namespace: "stub" }));
    build.onResolve({ filter: /i18n\/context$/ }, () => ({ path: "i18n-context", namespace: "stub" }));
    build.onResolve({ filter: /user-context$/ }, () => ({ path: "user-context", namespace: "stub" }));
    build.onLoad({ filter: /.*/, namespace: "stub" }, (args) => ({
      contents: STUBS[args.path],
      loader: "tsx",
      resolveDir: ROOT,
    }));
  },
};

const result = await esbuild.build({
  entryPoints: [path.join(HERE, "entry.tsx")],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2022",
  jsx: "automatic",
  outfile: path.join(HERE, "bundle.js"),
  plugins: [stubPlugin],
  alias: { "@": path.join(ROOT, "src") },
  define: { "process.env.NODE_ENV": '"development"' },
  logLevel: "error",
});

console.log("css bytes   :", css.css.length);
console.log("bundle bytes:", fs.statSync(path.join(HERE, "bundle.js")).size);
console.log("errors      :", result.errors.length);
