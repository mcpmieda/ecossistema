import type {
  GroupFlowLogV1,
  GroupRuleActionV1,
  GroupRulePersonV1,
  GroupRuleStatusV1,
  GroupRuleV1,
} from '../../../shared/platform-groups-v1';
import type { RuntimeEnv } from '../../env';
import { GraphError, graphRequest } from '../../graph/client';

/**
 * The SharePoint lists of the flow "Grupos por Cargo" (#1513), through the Graph Backend app with
 * Lists.SelectedOperations.Selected: REGRAS (write), ESTADO and LOG (read). Nothing else of the
 * site is reachable.
 */
export type GroupRuleFieldsV1 = {
  cargo: string;
  cargoKey: string;
  action: GroupRuleActionV1;
  groupId: string | null;
  groupName: string | null;
  active: boolean;
  note: string | null;
  reviewedBy: string;
  reviewedAt: string;
};

export type GroupRulesPortV1 = {
  rules(): Promise<GroupRuleV1[]>;
  people(): Promise<GroupRulePersonV1[]>;
  log(limit: number): Promise<GroupFlowLogV1[]>;
  createRule(fields: GroupRuleFieldsV1): Promise<GroupRuleV1>;
  /** null when the rule no longer exists; `changed` when `etag` is no longer its version. */
  updateRule(
    id: string,
    fields: GroupRuleFieldsV1,
    etag?: string,
  ): Promise<GroupRuleV1 | null | 'changed'>;
  deleteRule(id: string): Promise<'deleted' | 'not-found'>;
};

const REVIEW_STATUSES_V1: ReadonlySet<string> = new Set<GroupRuleStatusV1>([
  'PENDENTE_CARGO',
  'SEM_REGRA',
  'PENDENTE_GRUPO',
  'ERRO',
]);
const LIST_PAGES_MAX_V1 = 20;

type ItemV1<F> = { id: string; fields: F; '@odata.etag'?: string; eTag?: string };
type PageV1<F> = { value: ItemV1<F>[]; '@odata.nextLink'?: string };
type RuleFieldsV1 = {
  Title?: string;
  CargoOriginalReferencia?: string | null;
  CargoNormalizado?: string | null;
  GrupoNome?: string | null;
  GrupoID?: string | null;
  Ativo?: boolean | null;
  Acao?: string | null;
  Observacao?: string | null;
  DataRevisao?: string | null;
  RevisadoPor?: string | null;
};

const text = (value: unknown) =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : null;

/** The job title as the flow compares it: `toLower(trim(...))`, inner spaces kept. */
export const cargoKeyV1 = (cargo: string) => cargo.trim().toLowerCase();

/** Entra ids compared the way Entra does, without case. */
export const sameIdV1 = (left: string | null | undefined, right: string | null | undefined) =>
  !!left && !!right && left.toLowerCase() === right.toLowerCase();

/** A rule as the flow reads it: the key is CargoNormalizado and only `Ativo = true` counts. */
export function ruleFromItemV1(item: ItemV1<RuleFieldsV1>): GroupRuleV1 {
  const fields = item.fields;
  const cargoKey = cargoKeyV1(text(fields.CargoNormalizado) ?? '');
  return {
    id: item.id,
    cargo:
      text(fields.CargoOriginalReferencia) ??
      (cargoKey || (text(fields.Title)?.split(' -> ')[0]?.trim() ?? '')),
    cargoKey,
    action: fields.Acao === 'IGNORAR' ? 'IGNORAR' : 'ADICIONAR',
    groupId: text(fields.GrupoID),
    groupName: text(fields.GrupoNome),
    active: fields.Ativo === true,
    note: text(fields.Observacao),
    reviewedAt: text(fields.DataRevisao),
    reviewedBy: text(fields.RevisadoPor),
    etag: text(item['@odata.etag']) ?? text(item.eTag),
  };
}

/** The columns written for a rule; Title keeps the flow's own pattern ("cargo -> GRUPO"). */
export function itemFieldsV1(fields: GroupRuleFieldsV1): Record<string, unknown> {
  return {
    Title: `${fields.cargoKey} -> ${fields.action === 'IGNORAR' ? 'IGNORAR' : fields.groupName}`,
    CargoOriginalReferencia: fields.cargo,
    CargoNormalizado: fields.cargoKey,
    // An empty text clears the column (SharePoint does not take null for a text field).
    GrupoNome: fields.action === 'IGNORAR' ? '' : (fields.groupName ?? ''),
    GrupoID: fields.action === 'IGNORAR' ? '' : (fields.groupId ?? ''),
    Ativo: fields.active,
    Acao: fields.action,
    Observacao: fields.note ?? '',
    DataRevisao: fields.reviewedAt,
    RevisadoPor: fields.reviewedBy,
  };
}

export function groupRulesGraphPortV1(env: RuntimeEnv): GroupRulesPortV1 | null {
  const site = env.GROUP_RULES_SITE_ID;
  const rulesList = env.GROUP_RULES_LIST_ID;
  const stateList = env.GROUP_STATE_LIST_ID;
  const logList = env.GROUP_LOG_LIST_ID;
  if (!site || !rulesList || !stateList || !logList) return null;
  const listPath = (list: string) =>
    `/sites/${encodeURIComponent(site)}/lists/${encodeURIComponent(list)}/items`;

  async function items<F>(list: string, select: readonly string[]): Promise<ItemV1<F>[]> {
    const found: ItemV1<F>[] = [];
    let next: string | undefined =
      `${listPath(list)}?$expand=fields($select=${select.join(',')})&$top=999`;
    for (let page = 0; next && page < LIST_PAGES_MAX_V1; page++) {
      const answer: PageV1<F> = (await graphRequest<PageV1<F>>({ env, path: next })).data;
      found.push(...answer.value);
      next = answer['@odata.nextLink'];
    }
    return found;
  }

  const ruleColumns = [
    'Title',
    'CargoOriginalReferencia',
    'CargoNormalizado',
    'GrupoNome',
    'GrupoID',
    'Ativo',
    'Acao',
    'Observacao',
    'DataRevisao',
    'RevisadoPor',
  ];
  async function rule(id: string): Promise<GroupRuleV1 | null> {
    try {
      const answer = await graphRequest<ItemV1<RuleFieldsV1>>({
        env,
        path: `${listPath(rulesList!)}/${encodeURIComponent(id)}?$expand=fields($select=${ruleColumns.join(',')})`,
      });
      return ruleFromItemV1(answer.data);
    } catch (error) {
      if (error instanceof GraphError && error.status === 404) return null;
      throw error;
    }
  }

  return {
    async rules() {
      const found = await items<RuleFieldsV1>(rulesList, ruleColumns);
      return found
        .map(ruleFromItemV1)
        .sort((left, right) => left.cargoKey.localeCompare(right.cargoKey, 'pt-BR'));
    },
    async people() {
      const found = await items<Record<string, unknown>>(stateList, [
        'NomeExibicao',
        'UPN',
        'CargoOriginal',
        'Status',
        'DetalheUltimoErro',
        'UltimaVerificacao',
      ]);
      return found
        .filter((item) => REVIEW_STATUSES_V1.has(String(item.fields.Status)))
        .map((item) => ({
          name: text(item.fields.NomeExibicao),
          email: text(item.fields.UPN),
          cargo: text(item.fields.CargoOriginal),
          status: item.fields.Status as GroupRuleStatusV1,
          detail: text(item.fields.DetalheUltimoErro),
          checkedAt: text(item.fields.UltimaVerificacao),
        }))
        .sort((left, right) =>
          (left.name ?? left.email ?? '').localeCompare(right.name ?? right.email ?? '', 'pt-BR'),
        );
    },
    async log(limit) {
      // DataHora is indexed, so SharePoint sorts it: only the newest rows come.
      const columns = [
        'DataHora',
        'NomeExibicao',
        'UPN',
        'CargoOriginal',
        'GrupoNome',
        'Operacao',
        'Resultado',
        'Detalhes',
      ];
      const answer = await graphRequest<PageV1<Record<string, unknown>>>({
        env,
        path: `${listPath(logList)}?$expand=fields($select=${columns.join(',')})&$orderby=fields/DataHora desc&$top=${limit}`,
      });
      return answer.data.value
        .map((item) => ({
          at: text(item.fields.DataHora),
          name: text(item.fields.NomeExibicao),
          email: text(item.fields.UPN),
          cargo: text(item.fields.CargoOriginal),
          groupName: text(item.fields.GrupoNome),
          operation: text(item.fields.Operacao),
          result: text(item.fields.Resultado),
          detail: text(item.fields.Detalhes),
        }))
        .sort((left, right) => (right.at ?? '').localeCompare(left.at ?? ''))
        .slice(0, limit);
    },
    async createRule(fields) {
      const answer = await graphRequest<ItemV1<RuleFieldsV1>>({
        env,
        method: 'POST',
        path: listPath(rulesList),
        body: { fields: itemFieldsV1(fields) },
      });
      return (await rule(answer.data.id)) ?? ruleFromItemV1(answer.data);
    },
    async updateRule(id, fields, etag) {
      try {
        await graphRequest({
          env,
          method: 'PATCH',
          path: `${listPath(rulesList)}/${encodeURIComponent(id)}/fields`,
          body: itemFieldsV1(fields),
          etag,
        });
      } catch (error) {
        if (error instanceof GraphError && error.status === 404) return null;
        if (error instanceof GraphError && error.status === 412) return 'changed';
        throw error;
      }
      return rule(id);
    },
    async deleteRule(id) {
      try {
        await graphRequest({
          env,
          method: 'DELETE',
          path: `${listPath(rulesList)}/${encodeURIComponent(id)}`,
        });
        return 'deleted';
      } catch (error) {
        if (error instanceof GraphError && error.status === 404) return 'not-found';
        throw error;
      }
    },
  };
}
