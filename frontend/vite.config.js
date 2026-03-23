import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: './src/test/setup.js',
  },
  server: {
    port: 5173,
    watch: {
      // Exclude backend runtime directories from Vite's file watcher.
      // Without this, SQLite WAL files written to backend/data/ and log
      // files in logs/ trigger hot-reload every ~30s, causing a React
      // remount that resets selectedCamera and playbackTarget.
      // TODO: if backend/data/ is moved outside the project root, revisit.
      ignored: ['**/backend/data/**', '**/logs/**', '**/.pids/**'],
    },
    proxy: {
      '/api': {
        target: 'http://localhost:8100',
        changeOrigin: true,
      },
    },
  },
})
