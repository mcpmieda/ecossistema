import { PROVIDER_HEALTH_BYTES_V1, PROVIDER_HEALTH_FRESH_MS_V1, PROVIDER_HEALTH_ROUTE_V1,
  isPublicProviderHealthV1 } from '../../shared/public-provider-health-v1';
import { HealthOnDemandPanelV1 } from './system-health-on-demand-v1';
const names = { cloudflare: 'Cloudflare', supabase: 'Supabase' };
const states = { none: 'Sem incidente global informado', minor: 'Alteração parcial informada',
  major: 'Incidente relevante informado', critical: 'Incidente crítico informado' };
const unconfirmedText = (state: string) => (state === 'rate-limited' ? 'Fornecedor limitou a consulta' : 'Status não confirmado');

export function SystemHealthProvidersPanelV1({ onDenied }: Readonly<{ onDenied: () => void }>) {
  return <HealthOnDemandPanelV1 title="Estado público dos fornecedores" description="Status global oficial; não são métricas da conta da escola"
    openLabel="Consultar fornecedores" refreshLabel="Atualizar fornecedores" route={PROVIDER_HEALTH_ROUTE_V1}
    bytes={PROVIDER_HEALTH_BYTES_V1} freshMs={PROVIDER_HEALTH_FRESH_MS_V1} validate={isPublicProviderHealthV1} onDenied={onDenied}>
    {(data) => <><dl className="grid min-w-0 gap-4 sm:grid-cols-2">{data.providers.map((p) => <div key={p.provider} className="min-w-0">
      <dt className="font-semibold">{names[p.provider]}</dt>
      <dd className="mt-1 text-sm">{p.state === 'ok' && p.indicator ? states[p.indicator] : unconfirmedText(p.state)}</dd>
      {p.changedAt ? <dd className="mt-1 text-xs text-muted">Atualização informada: {new Date(p.changedAt).toLocaleString('pt-BR', { timeZone: 'America/Bahia' })}</dd> : null}
    </div>)}</dl><p className="text-xs text-muted">Um incidente global não comprova impacto no Portal. CPU, memória, tráfego e cotas da conta ainda não estão integrados.</p></>}
  </HealthOnDemandPanelV1>;
}
