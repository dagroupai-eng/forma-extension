import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

export default defineConfig({
  base: '/forma-extension/',
  plugins: [preact()],
  server: {
    port: 5173,
    cors: true,
  },
  define: {
    global: 'globalThis',
  },
});
