import { defineConfig } from 'vite';
import tailwind from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  plugins: [tailwind()],
  build: {
    outDir: 'ui/react', emptyOutDir: true,
    lib: { entry: 'src/main.tsx', name: 'FlowHubUI', formats: ['iife'], fileName: () => 'host.js', cssFileName: 'host' },
  },
});
