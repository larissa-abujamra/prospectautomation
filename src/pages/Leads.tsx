// Página Leads — por enquanto só o cabeçalho e um estado vazio.
// A tabela de verdade (lendo de public.leads) chega no Prompt 1.
export default function Leads() {
  return (
    <>
      <header className="page-head">
        <div className="eyebrow">Pipeline</div>
        <h1>Leads</h1>
      </header>

      <div className="empty-state">
        <h3>Nenhum lead ainda</h3>
        <p>Os módulos de busca chegam no próximo passo.</p>
      </div>
    </>
  )
}
