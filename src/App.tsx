import { Suspense, lazy } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { RequireAuth } from './auth/RequireAuth'
import { AppShell } from './components/AppShell'
import Login from './pages/Login'
import Buscar from './pages/Buscar'
import Enriquecer from './pages/Enriquecer'

// O Mapa (Etapa 03) carrega Leaflet + jsPDF + html2canvas (libs pesadas),
// então é code-split: só baixa quando o usuário entra em /mapa.
const Mapa = lazy(() => import('./pages/Mapa'))
const ClienteOculto = lazy(() => import('./pages/ClienteOculto'))
const Olivia = lazy(() => import('./pages/Olivia'))

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
          {/* / abre na Olivia (entrada natural do produto) */}
          <Route path="/" element={<Navigate to="/olivia" replace />} />
          <Route path="/buscar" element={<Buscar />} />
          {/* Base de Dados (a mesa de trabalho). /enriquecer redireciona p/ não
              quebrar links antigos do time. */}
          <Route path="/base" element={<Enriquecer />} />
          <Route path="/enriquecer" element={<Navigate to="/base" replace />} />
          <Route
            path="/cliente-oculto"
            element={
              <Suspense fallback={<div className="center-screen">Carregando…</div>}>
                <ClienteOculto />
              </Suspense>
            }
          />
          <Route
            path="/olivia"
            element={
              <Suspense fallback={<div className="center-screen">Carregando…</div>}>
                <Olivia />
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
