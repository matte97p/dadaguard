import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Backend port da env PORT (default 3001), letta anche da server/index.js: così
// backend e proxy restano sincronizzati. Cambi porta una volta: PORT=4000 npm run dev
const API_PORT = process.env.PORT || 3001

export default defineConfig({
  root: '.',
  plugins: [react()],
  build: {
    // Separiamo i vendor grossi in chunk propri: React Flow (~180 kB) nel suo (serve solo alla
    // Topologia) e antd a parte, così i vendor — che cambiano di rado — restano in cache del browser
    // tra un deploy e l'altro e cambia solo il piccolo chunk dell'app. antd da solo è ~800 kB
    // minificato (gzip ~250): è la maggior parte del peso e non si spezza utilmente — per una
    // dashboard interna è accettabile, quindi il limite di warning è tarato sopra quella soglia.
    chunkSizeWarningLimit: 950, // antd con tutti i componenti usati (filtri, drawer, preset) sta ~880 kB
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return
          if (id.includes('reactflow') || id.includes('@reactflow') || id.includes('@xyflow') || id.includes('dagre'))
            return 'flow'
          if (id.includes('antd') || id.includes('@ant-design') || id.includes('rc-')) return 'antd'
          if (id.includes('react') || id.includes('scheduler')) return 'react'
          return 'vendor'
        },
      },
    },
  },
  server: {
    // Ascolta su 0.0.0.0/:: (non solo localhost): senza, dentro un dev container / VM il browser
    // dell'host non raggiunge il dev-server → ERR_CONNECTION_REFUSED. In locale su Mac resta invariato.
    host: true,
    port: 5173,
    proxy: {
      '/api': `http://localhost:${API_PORT}`,
    },
  },
})
