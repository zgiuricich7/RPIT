import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        // The Markdown renderer (unified/remark/micromark) is large and rarely changes:
        // keep it in its own cacheable chunk.
        manualChunks: (id: string) =>
          /node_modules[\\/](react-markdown|remark-|rehype-|micromark|mdast-|hast-|unified|unist-|vfile|property-information|space-separated|comma-separated|decode-named|character-|trim-lines|devlop|bail|trough|zwitch|longest-streak|markdown-table|ccount|escape-string|html-url|style-to|inline-style|estree-|is-plain-obj|extend)/.test(
            id,
          )
            ? "markdown"
            : undefined,
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:3001",
    },
  },
});
