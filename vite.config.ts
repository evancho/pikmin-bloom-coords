import react from '@vitejs/plugin-react'
import { writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import { VitePWA } from 'vite-plugin-pwa'

const __dirname = dirname(fileURLToPath(import.meta.url))
const APP_BUILD = 'v1.2.7-update'

/** GitHub Pages: https://evancho.github.io/pikmin-bloom-coords/ */
const GH_PAGES_BASE = '/pikmin-bloom-coords/'

function writeVersionJson() {
  return {
    name: 'write-version-json',
    closeBundle() {
      const out = resolve(__dirname, 'dist/version.json')
      writeFileSync(out, `${JSON.stringify({ build: APP_BUILD }, null, 2)}\n`)
    },
  }
}

export default defineConfig(({ command }) => ({
  base: process.env.VITE_BASE ?? (command === 'serve' ? '/' : GH_PAGES_BASE),
  plugins: [
    react(),
    writeVersionJson(),
    VitePWA({
      // Prompt only: do not skipWaiting until the user taps 重新載入.
      registerType: 'prompt',
      injectRegister: false,
      includeAssets: [
        'favicon.svg',
        'apple-touch-icon.png',
        'icon-192.png',
        'icon-512.png',
      ],
      manifest: {
        name: 'Bloom Pin — Pikmin Bloom 座標',
        short_name: 'Bloom Pin',
        description:
          '從 Pikmin Bloom 截圖找出座標，編輯後用愛心歸檔；可同步到其他手機',
        theme_color: '#2f6b4f',
        background_color: '#e7f0e4',
        display: 'standalone',
        orientation: 'portrait-primary',
        lang: 'zh-Hant',
        start_url: './',
        scope: './',
        icons: [
          {
            src: 'icon-192.png',
            sizes: '192x192',
            type: 'image/png',
          },
          {
            src: 'icon-512.png',
            sizes: '512x512',
            type: 'image/png',
          },
          {
            src: 'icon-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        // New cache name so installs still on the autoUpdate precache pick up
        // this prompt-banner build once, then wait for the in-app reload.
        cacheId: 'bloom-pin-v1.2.7',
        skipWaiting: false,
        clientsClaim: true,
        cleanupOutdatedCaches: true,
        // Keep version.json out of precache so update checks always hit network.
        globPatterns: ['**/*.{js,css,html,svg,png,ico,woff2}'],
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/fonts\.googleapis\.com\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'google-fonts-css',
              expiration: { maxEntries: 10, maxAgeSeconds: 60 * 60 * 24 * 365 },
            },
          },
          {
            urlPattern: /^https:\/\/fonts\.gstatic\.com\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'google-fonts-webfonts',
              expiration: { maxEntries: 20, maxAgeSeconds: 60 * 60 * 24 * 365 },
            },
          },
        ],
      },
    }),
  ],
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
  server: {
    proxy: {
      '/api/nominatim': {
        target: 'https://nominatim.openstreetmap.org',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/nominatim/, ''),
        headers: {
          'User-Agent': 'BloomPin/1.0 (Pikmin Bloom coords helper)',
          'Accept-Language': 'ja,en',
        },
      },
    },
  },
  preview: {
    // Allow temporary tunnels (e.g. trycloudflare.com) for pre-merge phone tests.
    allowedHosts: true,
    proxy: {
      '/api/nominatim': {
        target: 'https://nominatim.openstreetmap.org',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/nominatim/, ''),
        headers: {
          'User-Agent': 'BloomPin/1.0 (Pikmin Bloom coords helper)',
          'Accept-Language': 'ja,en',
        },
      },
    },
  },
}))
