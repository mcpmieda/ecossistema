// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { onRequest } from '../functions/[[path]]';
import { ACCESS_AREA_IDS } from '../shared/platform-contract';
import type { GroupRuleV1 } from '../shared/platform-groups-v1';
import { setAccessGrantsPortForTestsV1 } from '../server/auth/access-grants-v1';
import { seal } from '../server/auth/sealed';
import { createApplicationSession, SESSION_COOKIE } from '../server/auth/session';
import { setSessionRevocationPortForTestsV1 } from '../server/auth/session-revocation-v1';
import {
  itemFieldsV1,
  ruleFromItemV1,
  type GroupRuleFieldsV1,
  type GroupRulesPortV1,
} from '../server/platform/groups/group-rules-graph-v1';
import { setGroupRulesForTestsV1 } from '../server/platform/groups/group-rules-v1';
import type { GroupsGraphPortV1 } from '../server/platform/groups/groups-graph-v1';
import { setGroupsGraphForTestsV1 } from '../server/platform/groups/groups-http-v1';
import {
  setGroupsStoreForTestsV1,
  type GroupChangeRecordV1,
  type GroupsStorePortV1,
} from '../server/platform/groups/groups-store-v1';
import { testEnv } from './fixtures';

/** #1513: the rules of the flow "Grupos por Cargo" (SharePoint list REGRAS) from the Centro. */
const otherTenantGroup = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
let rules: GroupRuleV1[];
let written: Array<{ id?: string; fields: GroupRuleFieldsV1 }>;
let changes: GroupChangeRecordV1[];
let nextId: number;

const ruleOf = (id: string, fields: GroupRuleFieldsV1): GroupRuleV1 => ({
  id,
  cargo: fields.cargo,
  cargoKey: fields.cargoKey,
  action: fields.action,
  groupId: fields.groupId,
  groupName: fields.groupName,
  active: fields.active,
  note: fields.note,
  reviewedAt: fields.reviewedAt,
  reviewedBy: fields.reviewedBy,
  etag: `"v,${++version}"`,
});
let version = 0;
let ruleWrites: Array<{ id: string; etag?: string }>;
let basePort: GroupRulesPortV1;

beforeEach(() => {
  nextId = 10;
  written = [];
  changes = [];
  rules = [
    {
      id: '3',
      cargo: 'professor',
      cargoKey: 'professor',
      action: 'ADICIONAR',
      groupId: testEnv.GROUP_PROFESSOR_ID,
      groupName: 'PROFESSORES',
      active: true,
      note: null,
      reviewedAt: null,
      reviewedBy: null,
      etag: '"v,0"',
    },
  ];
  ruleWrites = [];
  const port: GroupRulesPortV1 = {
    rules: async () => [...rules],
    people: async () => [
      {
        name: 'Pessoa',
        email: 'p@escola.example',
        cargo: null,
        status: 'PENDENTE_CARGO',
        detail: null,
        checkedAt: null,
      },
    ],
    log: async () => [],
    keptByRule: async () => new Set<string>(),
    createRule: async (fields) => {
      written.push({ fields });
      const rule = ruleOf(String(nextId++), fields);
      rules.push(rule);
      return rule;
    },
    updateRule: async (id, fields, etag) => {
      const index = rules.findIndex((rule) => rule.id === id);
      if (index < 0) return null;
      ruleWrites.push({ id, ...(etag ? { etag } : {}) });
      if (etag && rules[index]!.etag !== etag) return 'changed';
      written.push({ id, fields });
      rules[index] = ruleOf(id, fields);
      return rules[index]!;
    },
    deleteRule: async (id) => {
      const before = rules.length;
      rules = rules.filter((rule) => rule.id !== id);
      return rules.length < before ? 'deleted' : 'not-found';
    },
  };
  setGroupRulesForTestsV1(port);
  basePort = port;
  setGroupsGraphForTestsV1({
    group: vi.fn(async (id: string) =>
      id === otherTenantGroup
        ? { id, name: 'OUTRO', description: null, mail: null }
        : id === testEnv.GROUP_APOIO_ID
          ? { id, name: 'EQUIPE DE APOIO', description: null, mail: null }
          : null,
    ),
  } as unknown as GroupsGraphPortV1);
  setGroupsStoreForTestsV1({
    managedGroups: async () => [],
    record: async (change: GroupChangeRecordV1) => {
      changes.push(change);
    },
  } as unknown as GroupsStorePortV1);
  setSessionRevocationPortForTestsV1(null);
});
afterEach(() => {
  setGroupRulesForTestsV1(undefined);
  setGroupsGraphForTestsV1(undefined);
  setGroupsStoreForTestsV1(undefined);
  setSessionRevocationPortForTestsV1(undefined);
  setAccessGrantsPortForTestsV1(undefined);
});

async function call(body: object, roles: Array<'ADMINISTRADOR' | 'APOIO'> = ['ADMINISTRADOR']) {
  const cookie = await seal(
    createApplicationSession({
      oid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      name: 'Secretaria Teste',
      username: 'sec@escola.example',
      roles,
    }),
    testEnv.SESSION_SECRET,
    'admin-session',
  );
  const response = await onRequest({
    request: new Request(`${testEnv.OFFICIAL_ORIGIN}/api/platform/groups`, {
      method: 'POST',
      headers: {
        Cookie: `${SESSION_COOKIE}=${cookie}`,
        Origin: testEnv.OFFICIAL_ORIGIN,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ contractVersion: 1, ...body }),
    }),
    env: testEnv,
    waitUntil: () => undefined,
  } as unknown as Parameters<typeof onRequest>[0]);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe('#1513 Regras por cargo', () => {
  it('only the Secretaria reads or changes them, even with every area opened', async () => {
    setAccessGrantsPortForTestsV1({
      areasFor: async () => [...ACCESS_AREA_IDS],
      list: async () => [],
      save: async () => undefined,
    });
    for (const body of [
      { operation: 'rules' },
      { operation: 'save-rule', cargo: 'x', action: 'IGNORAR', active: true },
      { operation: 'delete-rule', ruleId: '3' },
    ])
      expect((await call(body, ['APOIO'])).status).toBe(403);
    expect(rules).toHaveLength(1);
  });

  it('lists the rules, the people to review and the flow log', async () => {
    const answer = await call({ operation: 'rules' });
    expect(answer).toMatchObject({
      status: 200,
      body: { rules: [{ id: '3', cargoKey: 'professor' }], people: [{ status: 'PENDENTE_CARGO' }] },
    });
  });

  it('a new rule keeps the title as written, compares it as the flow does and takes the Entra name', async () => {
    const answer = await call({
      operation: 'save-rule',
      cargo: '  Bibliotecária  Escolar ',
      action: 'ADICIONAR',
      groupId: testEnv.GROUP_APOIO_ID,
      active: true,
    });
    expect(answer.status).toBe(200);
    // #1530 S3: the flow compares toLower(trim(jobTitle)), so the inner double space stays.
    expect(written[0]!.fields).toMatchObject({
      cargo: 'Bibliotecária  Escolar',
      cargoKey: 'bibliotecária  escolar',
      groupId: testEnv.GROUP_APOIO_ID,
      groupName: 'EQUIPE DE APOIO',
      reviewedBy: 'Secretaria Teste',
    });
    expect(changes).toMatchObject([
      { action: 'save-rule', target: 'bibliotecária  escolar', outcome: 'done' },
    ]);
  });

  it('#1530 S1: of two saves at once for one title, the one that finds the other gives way', async () => {
    // The other save lands between this one's check and its write.
    const port = { ...basePort };
    const createRule = port.createRule;
    port.createRule = async (fields) => {
      rules.push({ ...ruleOf('9', fields), etag: '"v,9"' });
      return createRule(fields);
    };
    setGroupRulesForTestsV1(port);
    expect(
      await call({ operation: 'save-rule', cargo: 'zelador', action: 'IGNORAR', active: true }),
    ).toMatchObject({ status: 409, body: { state: 'rule-duplicate' } });
    expect(rules.filter((rule) => rule.cargoKey === 'zelador').map((rule) => rule.id)).toEqual([
      '9',
    ]);
    expect(changes).toMatchObject([{ action: 'save-rule', outcome: 'failed' }]);
  });

  it('#1530 S9: an edit made meanwhile by someone else is not overwritten', async () => {
    expect(
      await call({
        operation: 'save-rule',
        ruleId: '3',
        etag: '"v,old"',
        cargo: 'professor',
        action: 'IGNORAR',
        active: true,
      }),
    ).toMatchObject({ status: 409, body: { state: 'rule-changed' } });
    expect(rules[0]).toMatchObject({ action: 'ADICIONAR' });
    expect(
      (
        await call({
          operation: 'save-rule',
          ruleId: '3',
          etag: '"v,0"',
          cargo: 'professor',
          action: 'IGNORAR',
          active: true,
        })
      ).status,
    ).toBe(200);
    expect(ruleWrites.at(-1)).toEqual({ id: '3', etag: '"v,0"' });
  });

  it('refuses a second active rule for the same title, a group outside the Centro and no group', async () => {
    expect(
      await call({
        operation: 'save-rule',
        cargo: 'PROFESSOR',
        action: 'IGNORAR',
        active: true,
      }),
    ).toMatchObject({ status: 409, body: { state: 'rule-duplicate' } });
    // An inactive one does not count.
    expect(
      (await call({ operation: 'save-rule', cargo: 'professor', action: 'IGNORAR', active: false }))
        .status,
    ).toBe(200);
    expect(
      await call({
        operation: 'save-rule',
        cargo: 'zelador',
        action: 'ADICIONAR',
        groupId: otherTenantGroup,
        active: true,
      }),
    ).toMatchObject({ status: 403, body: { state: 'not-allowed' } });
    expect(
      (await call({ operation: 'save-rule', cargo: 'zelador', action: 'ADICIONAR', active: true }))
        .status,
    ).toBe(400);
  });

  it('edits and removes a rule, and says when it no longer exists', async () => {
    expect(
      await call({
        operation: 'save-rule',
        ruleId: '3',
        cargo: 'professor',
        action: 'IGNORAR',
        active: true,
      }),
    ).toMatchObject({ status: 200, body: { rule: { id: '3', action: 'IGNORAR', groupId: null } } });
    expect(await call({ operation: 'delete-rule', ruleId: '3' })).toMatchObject({ status: 200 });
    expect(rules).toEqual([]);
    expect(await call({ operation: 'delete-rule', ruleId: '3' })).toMatchObject({
      status: 404,
      body: { state: 'rule-not-found' },
    });
    expect(changes.map((change) => change.action)).toEqual(['save-rule', 'delete-rule']);
  });

  it('without the lists configured, the rules are unavailable', async () => {
    setGroupRulesForTestsV1(null);
    expect(await call({ operation: 'rules' })).toMatchObject({
      status: 503,
      body: { state: 'unavailable' },
    });
  });
});

describe('#1513 Regras por cargo: the SharePoint columns', () => {
  it('reads and writes the columns the flow uses', () => {
    const fields: GroupRuleFieldsV1 = {
      cargo: 'Coordenador pedagógico',
      cargoKey: 'coordenador pedagógico',
      action: 'ADICIONAR',
      groupId: testEnv.GROUP_ADMIN_ID,
      groupName: 'GRUPO DA SECRETARIA',
      active: true,
      note: null,
      reviewedBy: 'Secretaria Teste',
      reviewedAt: '2026-11-17T12:00:00.000Z',
    };
    const columns = itemFieldsV1(fields);
    expect(columns).toEqual({
      Title: 'coordenador pedagógico -> GRUPO DA SECRETARIA',
      CargoOriginalReferencia: 'Coordenador pedagógico',
      CargoNormalizado: 'coordenador pedagógico',
      GrupoNome: 'GRUPO DA SECRETARIA',
      GrupoID: testEnv.GROUP_ADMIN_ID,
      Ativo: true,
      Acao: 'ADICIONAR',
      Observacao: '',
      DataRevisao: '2026-11-17T12:00:00.000Z',
      RevisadoPor: 'Secretaria Teste',
    });
    expect(itemFieldsV1({ ...fields, action: 'IGNORAR' })).toMatchObject({
      Title: 'coordenador pedagógico -> IGNORAR',
      GrupoNome: '',
      GrupoID: '',
    });
    expect(ruleFromItemV1({ id: '8', fields: columns, '@odata.etag': '"x,4"' })).toMatchObject({
      id: '8',
      cargo: 'Coordenador pedagógico',
      cargoKey: 'coordenador pedagógico',
      groupName: 'GRUPO DA SECRETARIA',
      note: null,
      active: true,
      etag: '"x,4"',
    });
  });

  it('#1530 S4: reads a row typed by hand in SharePoint the way the flow reads it', () => {
    // The flow compares toLower(trim(CargoNormalizado)) and only Ativo = true.
    expect(
      ruleFromItemV1({ id: '1', fields: { Title: 'Professor -> PROFESSORES', Ativo: true } }),
    ).toMatchObject({ cargo: 'Professor', cargoKey: '', active: true });
    expect(
      ruleFromItemV1({ id: '2', fields: { CargoNormalizado: ' Professor ', Ativo: null } }),
    ).toMatchObject({ cargo: 'professor', cargoKey: 'professor', active: false, etag: null });
  });
});
