import { Outlet } from 'react-router-dom'
import { Sidebar } from './Sidebar'
import { LeadsUIProvider } from '../context/LeadsUIContext'

// Layout das rotas internas: sidebar fixa + conteúdo da rota ativa.
// O LeadsUIProvider envolve as rotas para que filtros e seleção sejam
// compartilhados entre a tabela de Leads e o Mapa.
export function AppShell() {
  return (
    <LeadsUIProvider>
      <div className="app">
        <Sidebar />
        <main className="content">
          <Outlet />
        </main>
      </div>
    </LeadsUIProvider>
  )
}
