import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Backend port da env PORT (default 3001), letta anche da server/index.js: così
// backend e proxy restano sincronizzati. Cambi porta una volta: PORT=4000 npm run dev
const API_PORT = process.env.PORT || 3001

export default defineConfig({
  root: '.',
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': `http://localhost:${API_PORT}`,
    },
  },
})
