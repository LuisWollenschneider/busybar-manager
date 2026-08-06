import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { managerMockPlugin } from './src/mocks/devServer.js'

// Set VITE_MANAGER_MOCK=0 to develop against a real manager daemon running
// on 127.0.0.1:8321 instead of the built-in fake backend.
const useMock = process.env.VITE_MANAGER_MOCK !== '0'

export default defineConfig({
  plugins: [vue(), ...(useMock ? [managerMockPlugin()] : [])],
  base: '/',
  build: { outDir: 'dist', assetsDir: 'static', emptyOutDir: true },
  server: {
    proxy: useMock
      ? {}
      : ['/api', '/events'].reduce((a, p) => ((a[p] = 'http://127.0.0.1:8321'), a), {}),
  },
})
