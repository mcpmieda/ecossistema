import {
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

export class GroupsClientErrorV1 extends Error {
  constructor(readonly state: GroupsFailureStateV1) {
    super(state);
  }
}

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
  const body = (await response.json().catch(() => null)) as
    (GroupsResponseV1 & { state: string }) | { state?: GroupsFailureStateV1 } | null;
  if (!response.ok || body?.state !== 'ok')
    throw new GroupsClientErrorV1(
      (body?.state as GroupsFailureStateV1 | undefined) ?? 'unavailable',
    );
  return body as AnswerOf<C['operation']>;
}

export const GROUPS_FAILURE_TEXT_V1: Record<GroupsFailureStateV1, string> = {
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
  unavailable: 'Não foi possível concluir agora. Tente de novo.',
};

export const failureTextV1 = (error: unknown) =>
  error instanceof GroupsClientErrorV1
    ? GROUPS_FAILURE_TEXT_V1[error.state]
    : GROUPS_FAILURE_TEXT_V1.unavailable;
