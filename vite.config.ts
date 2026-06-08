/// <reference types="vitest/config" />
import { defineConfig } from 'vitest/config'
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
  // Vitest roda só os testes de unidade em src/. Os testes E2E (Playwright) em
  // e2e/ têm runner próprio (npx playwright test) e NÃO são coletados aqui.
  test: {
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['e2e/**', 'node_modules/**', 'dist/**'],
  },
})
