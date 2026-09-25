import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: resolve("src/main/index.ts"),
      },
    },
  },
  preload: {
    // Sandboxed preloads may only require Electron and built-in modules.
    // Bundle our narrow clipboard bridge instead of leaving a workspace
    // package import for Electron's restricted preload loader.
    plugins: [
      externalizeDepsPlugin({
        exclude: ["@vibecook/ghosttea-electron", "@vibecook/ghosttea-protocol"],
      }),
    ],
    build: {
      rollupOptions: {
        input: resolve("src/preload/index.ts"),
        output: { format: "cjs", entryFileNames: "[name].cjs" },
      },
    },
  },
  renderer: {
    root: resolve("src/renderer"),
    plugins: [react()],
  },
});
