import {
  GROUPS_FAILURE_STATES_V1,
  GROUPS_PATH_V1,
  type GroupsFailureStateV1,
  type GroupsRequestV1,
  type GroupsResponseV1,
} from '../../shared/platform-groups-v1';

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type GroupsCallV1 = DistributiveOmit<GroupsRequestV1, 'contractVersion'>;
type AnswerOf<O extends GroupsResponseV1['operation']> = Extract<
  GroupsResponseV1,
  { operation: O }
>;

/** `session-ended`: the Centro's sign-in ended (401), so only signing in again helps. */
export type GroupsClientStateV1 = GroupsFailureStateV1 | 'session-ended';

export class GroupsClientErrorV1 extends Error {
  constructor(readonly state: GroupsClientStateV1) {
    super(state);
  }
}

const knownStateV1 = (state: unknown): GroupsFailureStateV1 =>
  (GROUPS_FAILURE_STATES_V1 as readonly unknown[]).includes(state)
    ? (state as GroupsFailureStateV1)
    : 'unavailable';

/** Configurações › Grupos: one call to the groups API (#1513). */
export async function requestGroupsV1<C extends GroupsCallV1>(
  call: C,
  signal?: AbortSignal,
): Promise<AnswerOf<C['operation']>> {
  let response: Response;
  try {
    response = await fetch(GROUPS_PATH_V1, {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contractVersion: 1, ...call }),
      signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new GroupsClientErrorV1('unavailable');
  }
  if (response.status === 401) throw new GroupsClientErrorV1('session-ended');
  const body = (await response.json().catch(() => null)) as
    (GroupsResponseV1 & { state: string }) | { state?: unknown } | null;
  if (!response.ok || body?.state !== 'ok')
    throw new GroupsClientErrorV1(knownStateV1(body?.state));
  return body as AnswerOf<C['operation']>;
}

export const GROUPS_FAILURE_TEXT_V1: Record<GroupsClientStateV1, string> = {
  'invalid-request': 'Dados inválidos.',
  'not-authorized': 'Sem permissão para gerenciar grupos.',
  'not-allowed': 'Este grupo não é gerenciado pelo Centro.',
  'person-not-found': 'Nenhuma conta com esse e-mail.',
  'self-removal': 'Você não pode se remover do grupo da Secretaria.',
  'name-taken': 'Já existe um grupo com esse nome.',
  'delete-not-allowed': 'Este grupo não pode ser excluído por você.',
  'name-mismatch': 'O nome digitado não é o do grupo.',
  'rule-duplicate': 'Já existe uma regra ativa para esse cargo.',
  'rule-not-found': 'Esta regra não existe mais.',
  'rule-changed': 'A regra foi alterada por outra pessoa. Abra de novo para editar.',
  'group-has-rules': 'Remova ou desative as regras deste grupo antes de excluí-lo.',
  'group-not-found': 'Este grupo não existe mais no Microsoft 365.',
  'group-unrecorded': 'O grupo foi criado, mas não entrou na lista do Centro. Não o crie de novo.',
  'session-ended': 'Sua sessão terminou. Entre novamente.',
  unavailable: 'Não foi possível concluir agora. Tente de novo.',
};

export const failureTextV1 = (error: unknown) =>
  error instanceof GroupsClientErrorV1
    ? GROUPS_FAILURE_TEXT_V1[error.state]
    : GROUPS_FAILURE_TEXT_V1.unavailable;
