import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig, type Plugin } from 'vite'

// production CSP — injected only into the BUILT index.html (dev needs the
// inline react-refresh preamble, so the dev server stays unrestricted)
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'", // React inline style props + dynamic styles
  "img-src 'self' data: blob: http://127.0.0.1:8766", // media server + qr/previews
  "media-src 'self' blob: http://127.0.0.1:8766",
  "connect-src 'self' ws://127.0.0.1:8765 http://127.0.0.1:8766",
  "font-src 'self' data:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ')

const cspPlugin = (): Plugin => ({
  name: 'quapp-csp',
  apply: 'build',
  transformIndexHtml: (html) =>
    html.replace('</title>', `</title>\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`),
})

export default defineConfig({
  base: './', // file:// in packaged Electron can't resolve absolute /assets paths
  plugins: [react(), tailwindcss(), cspPlugin()],
  server: { port: 5199, strictPort: true },
})
