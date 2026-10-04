import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  base: './', // file:// in packaged Electron can't resolve absolute /assets paths
  plugins: [react(), tailwindcss()],
  server: { port: 5199, strictPort: true },
})
