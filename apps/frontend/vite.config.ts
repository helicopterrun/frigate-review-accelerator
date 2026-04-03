import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    allowedHosts: ["frigatebird.pondhouse.cloud"],
    proxy: {
      // Socket.IO — must proxy with ws:true so WebSocket upgrade is forwarded.
      // Without this, useSocket.js connects to :5173 (Vite) and gets HTML back.
      "/socket.io": {
        target: "http://localhost:4010",
        changeOrigin: true,
        ws: true,
      },
      // Core server REST endpoints (health, etc.)
      "/health": {
        target: "http://localhost:4010",
        changeOrigin: true,
      },
      // Media service — frames, preview strips, clips
      "/media": {
        target: "http://localhost:4020",
        changeOrigin: true,
      },
      "/api-media": {
        target: "http://localhost:4020",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api-media/, ""),
      },
    },
  },
});
