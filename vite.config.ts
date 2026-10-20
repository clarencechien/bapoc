import { defineConfig } from 'vite';

// GitHub Pages serves the repo at /bapoc/.
export default defineConfig({ base: process.env.PAGES_BASE ?? '/bapoc/', build: { chunkSizeWarningLimit: 1200 } });
