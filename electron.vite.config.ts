import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    build: {
      // electron-store is ESM-only; bundle it (and its deps) into the CJS main
      // bundle instead of require()-ing it at runtime.
      externalizeDeps: { exclude: ['electron-store'] }
    }
  },
  preload: {
    build: {
      externalizeDeps: true
    }
  },
  renderer: {
    root: 'src/renderer',
    build: {
      minify: true,
      rollupOptions: {
        input: resolve(__dirname, 'src/renderer/index.html')
      }
    },
    plugins: [react()]
  }
})
