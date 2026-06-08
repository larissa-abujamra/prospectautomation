import { Outlet } from 'react-router-dom'
import { Sidebar } from './Sidebar'

// Layout das rotas internas: sidebar fixa + conteúdo da rota ativa.
export function AppShell() {
  return (
    <div className="app">
      <Sidebar />
      <main className="content">
        <Outlet />
      </main>
    </div>
  )
}
