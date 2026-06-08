import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// base do app:
// - Vercel/raiz do domínio (default) → '/'. Necessário para o BrowserRouter:
//   ao acessar/atualizar uma rota direta (ex. /mapa), os assets resolvem a
//   partir da raiz, não do caminho da rota.
// - GitHub Pages em subdiretório (/<repo>/) → buildar com BASE_PATH=/<repo>/.
// https://vite.dev/config/
export default defineConfig({
  base: process.env.BASE_PATH || '/',
  plugins: [react()],
})
