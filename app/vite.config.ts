import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

// Served from a GitHub Pages project site: https://wakey1210.github.io/FPL-hub/
export default defineConfig({
  base: '/FPL-hub/',
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg'],
      manifest: {
        name: 'FPL Hub',
        short_name: 'FPL Hub',
        description: 'Personal Fantasy Premier League assistant',
        theme_color: '#c17f2e',
        background_color: '#0b0f14',
        display: 'standalone',
        start_url: '/FPL-hub/',
        scope: '/FPL-hub/',
        icons: [
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
        ],
      },
    }),
  ],
})
