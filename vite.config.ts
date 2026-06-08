import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// base relativo ('./') para o build estático funcionar no GitHub Pages,
// onde o app é servido a partir de um subdiretório (/<repo>/).
// https://vite.dev/config/
export default defineConfig({
  base: './',
  plugins: [react()],
})
