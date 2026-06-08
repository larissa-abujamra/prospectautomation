import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// base do app:
// - Vercel/raiz do domínio (default) → '/'. Necessário para o BrowserRouter:
//   ao acessar/atualizar uma rota direta (ex. /mapa), os assets resolvem a
//   partir da raiz, não do caminho da rota.
// - GitHub Pages em subdiretório (/<repo>/) → buildar com BASE_PATH=/<repo>/.
// https://vite.dev/config/
//
// NOTA: a config do Vitest NÃO vive aqui. Importar `defineConfig` de
// 'vitest/config' puxa uma segunda cópia do Vite e quebra o type-check do
// plugin react no build. O Vitest é escopado a src/ pelo script de teste
// (`vitest run src`), e os testes E2E (Playwright) em e2e/ têm runner próprio.
export default defineConfig({
  base: process.env.BASE_PATH || '/',
  plugins: [react()],
})
