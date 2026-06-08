import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { RequireAuth } from './auth/RequireAuth'
import { AppShell } from './components/AppShell'
import Login from './pages/Login'
import Leads from './pages/Leads'
import Mapa from './pages/Mapa'

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
          <Route path="/mapa" element={<Mapa />} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}
