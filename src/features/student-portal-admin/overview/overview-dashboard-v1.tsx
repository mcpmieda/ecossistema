import { Card, Chip, Meter } from '@heroui/react';
import {
  Users,
  UserCheck,
  Clock3,
  ShieldAlert,
  KeyRound,
  Activity,
  CheckCircle2,
  Link2,
} from 'lucide-react';
import type { AdminReadResponseV2 } from '../../../../shared/student-portal-contracts/admin-read-v2';
import { InfoV1 } from '../shared/info-v1';
type Counts = Extract<AdminReadResponseV2, { state: 'overview' }>['counts'];
const stats = [
  ['accounts', 'Alunos cadastrados', 'accent', Users, 'Total de contas no recorte selecionado.'],
  [
    'active',
    'Contas ativas',
    'success',
    UserCheck,
    'Contas que concluíram o primeiro acesso. Um bloqueio ou calendário fechado ainda pode impedir a entrada.',
  ],
  [
    'pendingActivation',
    'Primeiro acesso pendente',
    'warning',
    Clock3,
    'Contas que ainda precisam concluir o primeiro acesso.',
  ],
  [
    'validSessions',
    'Sessões ativas',
    'accent',
    Activity,
    'Acessos válidos neste momento. Um aluno pode ter mais de uma sessão.',
  ],
  [
    'blocked',
    'Contas bloqueadas',
    'danger',
    ShieldAlert,
    'Contas com bloqueio administrativo. Não inclui bloqueio temporário por tentativas incorretas.',
  ],
  [
    'resetRequired',
    'Senha a redefinir',
    'warning',
    KeyRound,
    'Contas que precisam cadastrar uma nova senha.',
  ],
] as const;
/** Only existing server counts. No synthetic trends, prediction or overlapping pie slices. */
export function OverviewDashboardV1({ counts }: Readonly<{ counts: Counts }>) {
  return (
    <div className="pa-dashboard">
      <dl className="pa-dashboard-stats">
        {stats.map(([key, label, tone, Icon, help]) => (
          <Card key={key} className={`pa-stat pa-stat--${tone} pa-rise`}>
            <Card.Content>
              <div className="pa-stat-top">
                <dt>{label}</dt>
                <InfoV1 label={`Sobre ${label}`}>{help}</InfoV1>
              </div>
              <div className="pa-stat-value">
                <dd>{counts[key].toLocaleString('pt-BR')}</dd>
                <span className="pa-stat-icon">
                  <Icon size={18} aria-hidden="true" />
                </span>
              </div>
            </Card.Content>
          </Card>
        ))}
      </dl>
      <div className="pa-dashboard-bottom">
        <Card className="pa-rise">
          <Card.Header className="flex-row justify-between items-center">
            <h3>Acesso ao Portal</h3>
            <InfoV1 label="Sobre o acesso ao Portal">
              Acesso ativado é a configuração. Permitido agora considera também cadastro, bloqueio e
              calendário. Os grupos não devem ser somados.
            </InfoV1>
          </Card.Header>
          <Card.Content>
            <div className="pa-dashboard-bar-row">
              <CheckCircle2 size={17} />
              <span>Acesso ativado</span>
              <strong>{counts.accessEnabled}</strong>
            </div>
            <Meter
              aria-label="Acesso ativado"
              color="accent"
              minValue={0}
              maxValue={Math.max(1, counts.accounts)}
              value={counts.accessEnabled}
            >
              <Meter.Track>
                <Meter.Fill />
              </Meter.Track>
            </Meter>
            <div className="pa-dashboard-bar-row">
              <UserCheck size={17} />
              <span>Permitido agora</span>
              <strong>{counts.accessPermitted}</strong>
            </div>
            <Meter
              aria-label="Acesso permitido agora"
              color="success"
              minValue={0}
              maxValue={Math.max(1, counts.accounts)}
              value={counts.accessPermitted}
            >
              <Meter.Track>
                <Meter.Fill />
              </Meter.Track>
            </Meter>
          </Card.Content>
        </Card>
        <Card className="pa-rise">
          <Card.Header className="flex-row justify-between items-center">
            <h3>Cadastro e vínculo</h3>
            <InfoV1 label="Sobre cadastro e vínculo">
              Mostra contas que precisam de conferência do vínculo com o cadastro acadêmico. Valores
              indisponíveis não são tratados como zero.
            </InfoV1>
          </Card.Header>
          <Card.Content>
            <div className="pa-dashboard-bar-row">
              <Link2 size={17} />
              <span>Sem vínculo atual</span>
              <Chip size="sm" variant="soft" color={counts.unlinked ? 'warning' : 'success'}>
                {counts.unlinked}
              </Chip>
            </div>
            <div className="pa-dashboard-bar-row">
              <ShieldAlert size={17} />
              <span>Vínculo a conferir</span>
              <Chip size="sm" variant="soft" color={counts.unresolved ? 'warning' : 'success'}>
                {counts.unresolved}
              </Chip>
            </div>
          </Card.Content>
        </Card>
      </div>
    </div>
  );
}
