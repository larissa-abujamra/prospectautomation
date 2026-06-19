import { Outlet } from 'react-router-dom'
import { Sidebar } from './Sidebar'
import { LeadsUIProvider } from '../context/LeadsUIContext'
import { BuscaMassaProvider, BuscaMassaIndicator } from '../context/BuscaMassaContext'

// Layout das rotas internas: sidebar fixa + conteúdo da rota ativa.
// O LeadsUIProvider envolve as rotas para que filtros e seleção sejam
// compartilhados entre a tabela de Leads e o Mapa. O BuscaMassaProvider vive
// aqui (rota de layout que não desmonta ao navegar) para que a varredura em
// massa continue rodando e o progresso sobreviva à troca de página.
export function AppShell() {
  return (
    <LeadsUIProvider>
      <BuscaMassaProvider>
        <div className="app">
          <Sidebar />
          <main className="content">
            <Outlet />
          </main>
          <BuscaMassaIndicator />
        </div>
      </BuscaMassaProvider>
    </LeadsUIProvider>
  )
}
