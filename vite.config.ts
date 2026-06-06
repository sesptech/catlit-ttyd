import { defineConfig } from "vite";
import { resolve } from "node:path";
import dts from "vite-plugin-dts";

// Library build for catlit-ttyd.
//
// Produces a single ESM entry at `dist/catlit-ttyd.js` plus a generated
// `dist/catlit-ttyd.d.ts` from the TypeScript sources. lit is declared
// as a peer dependency and is therefore externalized; xterm + addons
// are bundled so consumers don't have to wire them up themselves
// (and so the runtime version matches what we tested against).
//
// Why not also externalize xterm? Two reasons:
//
//   1. The ttyd wire protocol implementation depends on a specific
//      shape of xterm's `onData`/`onResize`/`write` API. Pinning
//      xterm at build time avoids "works at compile, breaks at run"
//      surprises when a consumer ships a different minor.
//
//   2. xterm + addons are ~100 KB gzipped together; consumers that
//      lazy-load `catlit-ttyd` (e.g. a dynamic import behind a route)
//      get the cost only when the terminal is actually rendered.

export default defineConfig({
  plugins: [
    dts({
      rollupTypes: false,
      include: ["src"],
    }),
  ],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
    target: "es2022",
    lib: {
      entry: resolve(import.meta.dirname, "src/catlit-ttyd.ts"),
      name: "CatlitTtyd",
      formats: ["es"],
      fileName: () => "catlit-ttyd.js",
    },
    rollupOptions: {
      external: ["lit", /^lit\//],
      output: {
        // Inline all non-lit assets (CSS via ?inline, etc).
        inlineDynamicImports: true,
      },
    },
  },
});
