import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 6969,
    proxy: {
      "/api": {
        target: "http://localhost:6968",
        changeOrigin: true,
      },
      "/ws": {
        target: "ws://localhost:6968",
        ws: true,
      },
    },
  },
  build: {
    outDir: "dist",
  },
});
