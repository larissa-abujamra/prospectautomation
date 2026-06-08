import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

// Fonte Fustat (design system da Squad) via @fontsource.
import '@fontsource/fustat/400.css'
import '@fontsource/fustat/500.css'
import '@fontsource/fustat/600.css'
import '@fontsource/fustat/700.css'

// Design system primeiro (tokens + classes), depois o shell do app.
import './styles/tokens.css'
import './index.css'

import App from './App.tsx'

const queryClient = new QueryClient()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
)
