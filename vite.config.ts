import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      // Ship a new service worker as soon as one is built. There is no state
      // worth preserving across versions — the shelf is read, not edited — so
      // asking the reader to confirm an update would be noise.
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      // Relative, like `base`, so an install works under the Pages project
      // path as well as at a domain root.
      manifest: {
        name: 'מדף — קריאה והורדה',
        short_name: 'מדף',
        description: 'עיון בקטלוג הספרייה של דיקטה והורדת הספרים כ-EPUB, Word או PDF.',
        lang: 'he',
        dir: 'rtl',
        start_url: '.',
        scope: './',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#f7f4ed',
        theme_color: '#7a2e2e',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          // Full bleed, for the shapes Android crops launcher icons to.
          {
            src: 'icon-maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        // The shell and the fonts, which are what make it start offline. The
        // catalogues are deliberately absent: they are megabytes of JSON, and
        // precaching them would make every update re-download the lot.
        globPatterns: ['**/*.{js,css,html,svg,woff2,ttf}', 'icon-*.png'],
        // The lazy export chunk carries three document builders and a font.
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
        navigateFallback: 'index.html',
        runtimeCaching: [
          {
            // Served from our own origin, and revised only when the catalogue
            // is rebuilt: show what we have, fetch a fresh copy behind it.
            urlPattern: ({ url, sameOrigin }) => sameOrigin && url.pathname.endsWith('.json'),
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'catalogue',
              expiration: { maxEntries: 8, maxAgeSeconds: 60 * 60 * 24 * 30 },
            },
          },
          {
            // A scanned book never changes, so once read it can be reread on
            // a train. Capped, because each archive is megabytes.
            urlPattern: ({ url }) => url.hostname === 'files.dicta.org.il',
            handler: 'CacheFirst',
            options: {
              cacheName: 'books-dicta',
              expiration: { maxEntries: 20, maxAgeSeconds: 60 * 60 * 24 * 90 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            // Sefaria's texts do get corrected, so prefer the network and fall
            // back to what was read last time.
            urlPattern: ({ url }) => url.hostname.endsWith('sefaria.org'),
            handler: 'NetworkFirst',
            options: {
              cacheName: 'books-sefaria',
              networkTimeoutSeconds: 5,
              expiration: { maxEntries: 60, maxAgeSeconds: 60 * 60 * 24 * 30 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
      // So `npm run dev` behaves like the built app rather than diverging.
      devOptions: { enabled: false },
    }),
  ],
  // Relative base so the build works under any GitHub Pages project path
  // (https://<user>.github.io/<repo>/) without hard-coding the repo name.
  base: './',
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
