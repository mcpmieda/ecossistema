import { HEALTH_REVIEW_BYTES_V1, HEALTH_REVIEW_ROUTE_V1, isHealthReviewV1, reviewGuidanceV1, reviewTotalsV1,
  type HealthReviewV1 } from '../../shared/health-review-v1';
import { HealthOnDemandPanelV1 } from './system-health-on-demand-v1';
const guidance: Record<string, string> = {
  maintenance: 'Houve atenção na manutenção. Consulte os horários no Histórico e confira as publicações aguardando.',
  server: 'Houve respostas com falha. Confira Entrada e carregamento e compare os horários com o Histórico.',
  limits: 'O limite de tentativas foi atingido. Confira a recorrência antes de alterar limites ou configurações.',
  browser: 'Navegadores relataram erros. Confira o carregamento da tela; o relato não confirma queda do servidor.',
  slow: 'Houve respostas de três segundos ou mais. Compare as etapas e as filas nos mesmos horários.',
  coverage: 'Há janelas sem confirmação. Elas podem anteceder a implantação ou refletir falha de coleta; não são tempo de indisponibilidade.',
};
function ReviewContent({ data }: Readonly<{ data: HealthReviewV1 }>) {
  const total = reviewTotalsV1(data), flags = reviewGuidanceV1(data);
  const count = (v: number) => v.toLocaleString('pt-BR');
  const records = [
    ['Coletas registradas', `${count(total.samples)} / 288`],
    ['Janelas sem registro', count(total.missing)],
    ['Amostras com atenção', count(total.attention + total.critical)],
    ['Recuperações observadas', count(total.recovered)],
    ['Respostas com falha', `${count(total.failed)}${total.capped ? '*' : ''}`],
    ['Limite de tentativas', count(total.limited)],
  ];
  return <>
    <dl aria-label="Resumo de 24 horas" className="grid min-w-0 grid-cols-2 gap-4 lg:grid-cols-3">
      {records.map(([label, value]) => <div key={label} className="min-w-0"><dt className="text-xs text-muted">{label}</dt><dd className="mt-1 text-xl font-semibold">{value}</dd></div>)}
    </dl>
    <div>
      <ul aria-label="Faixas horárias de coleta" className="grid grid-cols-12 gap-1 sm:grid-cols-[repeat(24,minmax(0,1fr))]">
        {data.hours.map((h) => {
          let status: 'Com intervenção' | 'Com atenção' | 'Sem registro' | 'Cobertura parcial' | 'Sem atenção nos sinais';
          if (h.critical) {
            status = 'Com intervenção';
          } else if (h.attention) {
            status = 'Com atenção';
          } else if (h.samples === 0) {
            status = 'Sem registro';
          } else if (h.missing || h.unknown) {
            status = 'Cobertura parcial';
          } else {
            status = 'Sem atenção nos sinais';
          }
          let color: 'bg-danger' | 'bg-warning' | 'bg-success' | 'bg-default';
          if (h.critical) {
            color = 'bg-danger';
          } else if (h.attention) {
            color = 'bg-warning';
          } else if (h.samples === 12 && !h.unknown) {
            color = 'bg-success';
          } else {
            color = 'bg-default';
          }
          const label = `${new Date(h.startAt).toLocaleString('pt-BR', { timeZone: 'America/Bahia' })}: ${status}; ${h.samples} de 12 coletas`;
          return <li key={h.startAt} aria-label={label} title={label} className={`h-5 rounded-sm ${color}`} />;
        })}
      </ul>
      <p className="mt-2 text-xs text-muted">24 faixas de coleta · cinza: sem confirmação completa · cores não representam disponibilidade</p>
    </div>
    <p className="text-sm">Recusas / sem sessão: <strong>{count(total.refused)}</strong> · Respostas ≥ 3 s: <strong>{count(total.slow)}</strong> · Relatos de navegador: <strong>{count(total.browser)}</strong></p>
    <p className="text-xs text-muted">Período até {new Date(data.to).toLocaleString('pt-BR', { timeZone: 'America/Bahia' })} (Bahia). Operações são observações parciais, não alunos nem todos os acessos.{total.capped ? ' * Houve limite de coleta; as contagens são parciais.' : ''}</p>
    {flags.length ? <details><summary className="cursor-pointer text-sm font-medium">Orientações para verificar ({flags.length})</summary>
      <div className="mt-3 space-y-2">{flags.map((key) => <p key={key} className="text-sm text-muted">{guidance[key]}</p>)}</div>
    </details> : <p className="text-sm text-muted">Nenhum alerta identificado nas amostras consultadas. Isso não confirma todo o funcionamento do Portal.</p>}
  </>;
}
export function SystemHealthReviewPanelV1({ onDenied }: Readonly<{ onDenied: () => void }>) {
  return <HealthOnDemandPanelV1 title="Resumo das últimas 24 horas" description="Janelas concluídas · histórico e operações · cobertura parcial"
    openLabel="Ver resumo" refreshLabel="Atualizar resumo" route={HEALTH_REVIEW_ROUTE_V1} bytes={HEALTH_REVIEW_BYTES_V1}
    validate={isHealthReviewV1} onDenied={onDenied}>{(data) => <ReviewContent data={data} />}</HealthOnDemandPanelV1>;
}
