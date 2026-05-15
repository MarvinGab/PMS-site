import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react-swc'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

export default defineConfig({
  // Absolute base so asset URLs in index.html resolve from the root regardless
  // of which path the user is visiting (e.g. `/trio-infrastructure`). With
  // `./` (the previous value) the browser would look for `/trio-infrastructure/assets/*`
  // which doesn't exist and returns 404s after the path-based tenant switch.
  base: '/',
  plugins: [react()],
  server: {
    watch: {
      ignored: ['**/.env', '**/.env.*'],
    },
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
      },
    },
  },
})
