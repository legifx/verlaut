import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

// Verlaut PWA — installierbar auf Handy + PC, ausgeliefert vom eigenen Server
// (Tailscale-HTTPS). Keine externen CDNs, alles self-hosted (Privacy + CSP).
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      // "prompt": kein stilles Auto-Update — wir zeigen ein Popup, sobald der
      // Server neue Assets ausliefert (siehe src/update.ts).
      registerType: "prompt",
      // WASM muss vom Service Worker mit-gecacht werden.
      workbox: {
        globPatterns: ["**/*.{js,css,html,wasm,svg,png,woff2}"],
        // libsignal-WASM ist ~4 MB -> Precache-Limit anheben (offline-fähig).
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
      },
      manifest: {
        name: "Verlaut",
        short_name: "Verlaut",
        description: "Ende-zu-Ende-verschlüsselter Messenger — self-hosted.",
        theme_color: "#0b0f14",
        background_color: "#0b0f14",
        display: "standalone",
        orientation: "portrait",
        start_url: "/",
        icons: [
          { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "/icons/icon-maskable.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
    }),
  ],
  build: {
    target: "es2022",
    sourcemap: false,
  },
  // WASM (top-level await / ESM) sauber einbinden.
  worker: { format: "es" },
});
