import { Suspense, lazy } from 'react'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { RequireAuth } from './auth/RequireAuth'
import { AppShell } from './components/AppShell'
import Login from './pages/Login'
import Leads from './pages/Leads'

// O Mapa carrega Leaflet + jsPDF + html2canvas (libs pesadas), então é
// code-split: só baixa quando o usuário entra em /mapa.
const Mapa = lazy(() => import('./pages/Mapa'))

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
          <Route path="/" element={<Leads />} />
          <Route
            path="/mapa"
            element={
              <Suspense fallback={<div className="center-screen">Carregando mapa…</div>}>
                <Mapa />
              </Suspense>
            }
          />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}
