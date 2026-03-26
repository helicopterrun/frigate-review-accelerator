import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // Proxy media requests to the Python media service
      "/media": {
        target: "http://localhost:4020",
        changeOrigin: true,
      },
    },
  },
});
