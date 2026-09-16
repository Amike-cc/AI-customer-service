import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: '.',
  base: './',
  plugins: [react()],
  build: {
    outDir: '../dist/renderer',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
    minify: 'esbuild',
    rollupOptions: {
      output: {
        entryFileNames: 'assets/[name].js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name].[ext]',
        manualChunks: {
          'react-vendor': ['react', 'react-dom'],
          'icons': ['lucide-react'],
        },
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  esbuild: {
    drop: ['console', 'debugger'],
  },
});
