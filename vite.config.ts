/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// GitHub Pages serves this repo at /VENDORA/. Override with VITE_BASE for other hosts.
const base = process.env.VITE_BASE ?? '/VENDORA/';

export default defineConfig({
  base,
  plugins: [react()],
  build: { sourcemap: false, target: 'es2020' },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}', 'supabase/functions/**/*.test.ts'],
  },
});
