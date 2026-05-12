import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Preact/compat actúa como drop-in de React. Bundle ~10x más chico y render
// más rápido sin tocar el código (sigue siendo JSX + hooks idénticos).
// Si algún componente rompe, comentar las dos líneas de alias y volverá a React.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      react: 'preact/compat',
      'react-dom': 'preact/compat',
      'react/jsx-runtime': 'preact/jsx-runtime',
    },
  },
  build: {
    target: 'es2020',
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules')) {
            if (id.includes('lucide-react')) return 'icons';
            return 'vendor';
          }
        },
      },
    },
  },
});
