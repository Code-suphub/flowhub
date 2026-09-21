import { defineConfig } from 'vite';
import tailwind from '@tailwindcss/vite';
export default defineConfig({
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  plugins: [tailwind()],
  build: {
    outDir: 'ui/react', emptyOutDir: true,
    lib: { entry: 'src/main.tsx', name: 'FlowHubUI', formats: ['iife'], fileName: () => 'host.js', cssFileName: 'host' },
  },
});
