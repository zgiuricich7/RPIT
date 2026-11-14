import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  platform: "node",
  target: "node22",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  // node:sqlite only exists with the node: prefix, so keep it.
  removeNodeProtocol: false,
  // Bundle the workspace package (it ships TypeScript source); keep real deps external.
  noExternal: ["@tasktree/shared"],
});
