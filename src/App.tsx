import { Suspense, lazy } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { RequireAuth } from './auth/RequireAuth'
import { AppShell } from './components/AppShell'
import Login from './pages/Login'
import Buscar from './pages/Buscar'
import Enriquecer from './pages/Enriquecer'

// Páginas pesadas: code-split para não inflacionar o bundle inicial.
const Mapa = lazy(() => import('./pages/Mapa'))
const Olivia = lazy(() => import('./pages/Olivia'))
const Prospeccao = lazy(() => import('./pages/Prospeccao'))

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        {/* Fora do gate de autenticação */}
        <Route path="/login" element={<Login />} />

        {/* Rotas internas: protegidas por sessão + layout com sidebar */}
        <Route
          element={
            <RequireAuth>
              <AppShell />
            </RequireAuth>
          }
        >
          {/* / abre em Prospecção: primeira ação do funil de vendas */}
          <Route path="/" element={<Navigate to="/prospectar" replace />} />
          <Route path="/buscar" element={<Buscar />} />
          {/* Base de Dados (a mesa de trabalho). /enriquecer redireciona p/ não
              quebrar links antigos do time. */}
          <Route path="/base" element={<Enriquecer />} />
          <Route path="/enriquecer" element={<Navigate to="/base" replace />} />
          {/* Cliente oculto virou aba da Base. Mantém o link antigo do time vivo,
              caindo direto na aba (mesmo padrão de /enriquecer e /mapa). */}
          <Route path="/cliente-oculto" element={<Navigate to="/base?tab=cliente-oculto" replace />} />
          <Route
            path="/olivia"
            element={
              <Suspense fallback={<div className="center-screen">Carregando…</div>}>
                <Olivia />
              </Suspense>
            }
          />
          <Route
            path="/prospectar"
            element={
              <Suspense fallback={<div className="center-screen">Carregando…</div>}>
                <Prospeccao />
              </Suspense>
            }
          />
          <Route path="/mapa" element={<Navigate to="/rotas" replace />} />
          <Route
            path="/rotas"
            element={
              <Suspense fallback={<div className="center-screen">Carregando…</div>}>
                <Mapa />
              </Suspense>
            }
          />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}
