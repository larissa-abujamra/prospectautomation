import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// O deploy atual é no Vercel, servido na RAIZ do domínio → base '/'.
// (base relativo './' quebrava rotas profundas como /login, porque os assets
// passavam a ser resolvidos contra /login/assets/…).
// Para um deploy futuro no GitHub Pages (subdiretório /<repo>/), basta buildar
// com BASE_PATH, ex.: `BASE_PATH=/prospectautomation/ npm run build`.
// https://vite.dev/config/
export default defineConfig({
  base: process.env.BASE_PATH ?? '/',
  plugins: [react()],
})
