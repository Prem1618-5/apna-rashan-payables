// Production build: bundle src/ plus the @arad/* workspace packages (whose "main" is TypeScript source)
// into dist/*.js that run with plain `node`. npm dependencies stay external (installed in node_modules).
// @arad/extraction is optional: bundled when it can be resolved, otherwise left as a runtime import
// that fails softly (see src/extraction.ts). No code splitting: import.meta.url must stay in dist/ so
// ../migrations resolves to services/api/migrations.
import { build } from "esbuild";
import { createRequire } from "node:module";
import { rmSync } from "node:fs";

const require = createRequire(import.meta.url);

const workspace = {
  name: "workspace-deps",
  setup(b) {
    b.onResolve({ filter: /^[^./]/ }, async (args) => {
      if (args.path.startsWith("node:")) return { external: true };
      if (args.path.startsWith("@arad/")) {
        if (args.path === "@arad/extraction") {
          try {
            require.resolve("@arad/extraction");
          } catch {
            console.warn("note: @arad/extraction not found; building without it (dev falls back to the mock)");
            return { external: true };
          }
        }
        return undefined; // let esbuild resolve and bundle it
      }
      return { external: true };
    });
  },
};

rmSync(new URL("./dist/", import.meta.url), { recursive: true, force: true });
await build({
  entryPoints: ["src/server.ts", "src/worker-main.ts", "src/migrate-cli.ts", "src/seed-cli.ts"],
  outdir: "dist",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: true,
  plugins: [workspace],
  logLevel: "info",
});
