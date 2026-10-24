import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev server (npm run dev:web) proxies the API; production build is served by Express.
export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true, sourcemap: false },
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: { "/api": `http://127.0.0.1:${process.env.VS_PORT ?? 4700}` },
  },
});
