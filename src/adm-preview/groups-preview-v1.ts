import type {
  GroupChangeV1,
  GroupFlowLogV1,
  GroupPersonV1,
  GroupRoleV1,
  GroupRulePersonV1,
  GroupRuleV1,
  GroupViewV1,
} from '../../shared/platform-groups-v1';

/** Synthetic groups for the local preview of Configurações › Grupos; no real person. */
const people: GroupPersonV1[] = [
  ['Ana Exemplo', 'ana.exemplo@escola.example', 'secretaria', true],
  ['Bruno Fictício', 'bruno.ficticio@escola.example', 'professor', true],
  ['Carla Sintética', 'carla.sintetica@escola.example', 'professor', true],
  ['Davi Modelo', 'davi.modelo@escola.example', 'equipe de apoio', true],
  ['Elisa Teste', 'elisa.teste@escola.example', null, false],
  ['Fábio Amostra', 'fabio.amostra@escola.example', 'professor', true],
].map(([name, email, jobTitle, enabled], index) => ({
  id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
  name: name as string,
  email: email as string,
  jobTitle: jobTitle as string | null,
  enabled: enabled as boolean,
}));

type PreviewGroupV1 = Omit<GroupViewV1, 'memberCount'> & { members: Set<string> };
const roleGroup = (id: string, name: string, role: GroupRoleV1, members: number[]) => ({
  id,
  name,
  description: null,
  mail: null,
  role,
  available: true,
  members: new Set(members.map((index) => people[index]!.id)),
});
const groups: PreviewGroupV1[] = [
  roleGroup('10000000-0000-4000-8000-000000000001', 'GRUPO DA SECRETARIA', 'ADMINISTRADOR', [0]),
  roleGroup('10000000-0000-4000-8000-000000000002', 'PROFESSORES', 'PROFESSOR', [1, 2, 5]),
  roleGroup('10000000-0000-4000-8000-000000000003', 'ALUNOS', 'ALUNO', []),
  roleGroup('10000000-0000-4000-8000-000000000004', 'EQUIPE DE APOIO', 'APOIO', [3, 4]),
  roleGroup('10000000-0000-4000-8000-000000000005', 'VISITANTE', 'VISITANTE', []),
];
const changes: Array<GroupChangeV1> = [];

const rule = (
  id: number,
  cargo: string,
  groupIndex: number | null,
  active = true,
): GroupRuleV1 => ({
  id: String(id),
  cargo,
  cargoKey: cargo.toLowerCase(),
  action: groupIndex === null ? 'IGNORAR' : 'ADICIONAR',
  groupId: groupIndex === null ? null : groups[groupIndex]!.id,
  groupName: groupIndex === null ? null : groups[groupIndex]!.name,
  active,
  note: null,
  reviewedAt: '2026-08-18T20:11:13.000Z',
  reviewedBy: 'Administração sintética',
  etag: `"preview,${id}"`,
});
const rules: GroupRuleV1[] = [
  rule(1, 'aluno', 2),
  rule(2, 'equipe de apoio', 3),
  rule(3, 'professor', 1),
  rule(4, 'secretaria', 0),
  rule(5, 'administrador global', null),
];
const reviewPeople: GroupRulePersonV1[] = [
  {
    name: 'Gabriel Exemplo',
    email: 'gabriel.exemplo@escola.example',
    cargo: null,
    status: 'PENDENTE_CARGO',
    detail: null,
    checkedAt: '2026-11-17T12:00:00.000Z',
  },
  {
    name: 'Helena Fictícia',
    email: 'helena.ficticia@escola.example',
    cargo: 'Bibliotecária',
    status: 'SEM_REGRA',
    detail: null,
    checkedAt: '2026-11-17T12:00:00.000Z',
  },
];
const flowLog: GroupFlowLogV1[] = [
  {
    at: '2026-11-17T12:05:00.000Z',
    name: 'Helena Fictícia',
    email: 'helena.ficticia@escola.example',
    cargo: 'Bibliotecária',
    groupName: null,
    operation: 'SEM_REGRA',
    result: 'AVISO',
    detail: 'Cargo sem regra ativa.',
  },
];
let nextRuleId = 10;

const view = (group: PreviewGroupV1): GroupViewV1 => {
  const { members, ...rest } = group;
  return { ...rest, memberCount: members.size };
};
const ok = (value: object) => ({ contractVersion: 1, state: 'ok', ...value });
const plainV1 = (value: string) =>
  value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/gu, '')
    .trim()
    .toLowerCase();
/** As the flow would: an active rule for the person's job title adds them to this group. */
const byRuleV1 = (person: GroupPersonV1, groupId: string) =>
  rules.some(
    (item) =>
      item.active &&
      item.groupId === groupId &&
      item.cargoKey === (person.jobTitle ?? '').trim().toLowerCase(),
  );
const refuse = (state: string) => ({ contractVersion: 1, state });
const record = (change: Omit<GroupChangeV1, 'at' | 'actor'>) =>
  changes.unshift({ ...change, at: new Date().toISOString(), actor: 'Administração sintética' });

/** The answer of POST /api/platform/groups in the preview, with its status. */
export function previewGroupsV1(body: string): { status: number; value: object } {
  const input = JSON.parse(body) as Record<string, string | undefined>;
  const group = groups.find((item) => item.id === input.groupId);
  switch (input.operation) {
    case 'list':
      return {
        status: 200,
        value: ok({ operation: 'list', groups: groups.map(view), canDelete: true }),
      };
    case 'members':
      if (!group) return { status: 403, value: refuse('not-allowed') };
      return {
        status: 200,
        value: ok({
          operation: 'members',
          groupId: group.id,
          members: people
            .filter((person) => group.members.has(person.id))
            .map((person) => ({ ...person, byRule: byRuleV1(person, group.id) })),
        }),
      };
    case 'find-people': {
      const text = (input.query ?? '').toLowerCase();
      return {
        status: 200,
        value: ok({
          operation: 'find-people',
          people: people.filter(
            (person) =>
              person.name?.toLowerCase().startsWith(text) || person.email?.startsWith(text),
          ),
        }),
      };
    }
    case 'history':
      return {
        status: 200,
        value: ok({
          operation: 'history',
          changes: changes.filter((change) => !input.groupId || change.groupId === input.groupId),
        }),
      };
    case 'add-member': {
      if (!group) return { status: 403, value: refuse('not-allowed') };
      const person = people.find((item) => item.email === input.email?.trim().toLowerCase());
      if (!person) return { status: 404, value: refuse('person-not-found') };
      const result = group.members.has(person.id) ? 'already-member' : 'added';
      group.members.add(person.id);
      record({
        action: 'add-member',
        groupId: group.id,
        groupName: group.name,
        target: person.email,
        outcome: result === 'added' ? 'done' : 'unchanged',
      });
      return { status: 200, value: ok({ operation: 'add-member', result, person }) };
    }
    case 'remove-member': {
      if (!group) return { status: 403, value: refuse('not-allowed') };
      if (group.role === 'ADMINISTRADOR' && input.personId === people[0]!.id)
        return { status: 409, value: refuse('self-removal') };
      const result = group.members.delete(input.personId ?? '') ? 'removed' : 'not-member';
      record({
        action: 'remove-member',
        groupId: group.id,
        groupName: group.name,
        target: people.find((item) => item.id === input.personId)?.email ?? null,
        outcome: result === 'removed' ? 'done' : 'unchanged',
      });
      return { status: 200, value: ok({ operation: 'remove-member', result }) };
    }
    case 'create-group': {
      const name = (input.name ?? '').trim();
      if (groups.some((item) => plainV1(item.name) === plainV1(name)))
        return { status: 409, value: refuse('name-taken') };
      const created: PreviewGroupV1 = {
        id: `20000000-0000-4000-8000-${String(groups.length).padStart(12, '0')}`,
        name,
        description: input.description ?? null,
        mail: null,
        role: null,
        available: true,
        members: new Set(),
      };
      groups.push(created);
      record({
        action: 'create-group',
        groupId: created.id,
        groupName: name,
        target: null,
        outcome: 'done',
      });
      return { status: 200, value: ok({ operation: 'create-group', group: view(created) }) };
    }
    case 'rules':
      return {
        status: 200,
        value: ok({ operation: 'rules', rules, people: reviewPeople, log: flowLog }),
      };
    case 'save-rule': {
      const command = JSON.parse(body) as {
        ruleId?: string;
        etag?: string;
        cargo: string;
        action: 'ADICIONAR' | 'IGNORAR';
        groupId?: string;
        active: boolean;
        note?: string;
      };
      const cargoKey = command.cargo.trim().toLowerCase();
      if (command.action === 'ADICIONAR' && !command.groupId)
        return { status: 400, value: refuse('invalid-request') };
      const existing = rules.find((item) => item.id === command.ruleId);
      if (command.ruleId && !existing) return { status: 404, value: refuse('rule-not-found') };
      if (existing && command.etag && existing.etag !== command.etag)
        return { status: 409, value: refuse('rule-changed') };
      const target = groups.find((item) => item.id === command.groupId);
      if (command.action === 'ADICIONAR' && !target)
        return { status: 403, value: refuse('not-allowed') };
      if (
        command.active &&
        rules.some(
          (item) => item.active && item.cargoKey === cargoKey && item.id !== command.ruleId,
        )
      )
        return { status: 409, value: refuse('rule-duplicate') };
      const saved: GroupRuleV1 = {
        id: command.ruleId ?? String(nextRuleId++),
        cargo: command.cargo.trim(),
        cargoKey,
        action: command.action,
        groupId: command.action === 'ADICIONAR' ? (target?.id ?? null) : null,
        groupName: command.action === 'ADICIONAR' ? (target?.name ?? null) : null,
        active: command.active,
        note: command.note ?? null,
        reviewedAt: new Date().toISOString(),
        reviewedBy: 'Administração sintética',
        etag: `"preview,${Date.now()}"`,
      };
      record({
        action: 'save-rule',
        groupId: saved.groupId,
        groupName: saved.groupName,
        target: cargoKey,
        outcome: 'done',
      });
      const index = rules.findIndex((item) => item.id === saved.id);
      if (index >= 0) rules[index] = saved;
      else rules.push(saved);
      rules.sort((left, right) => left.cargoKey.localeCompare(right.cargoKey, 'pt-BR'));
      return { status: 200, value: ok({ operation: 'save-rule', rule: saved }) };
    }
    case 'delete-rule': {
      const index = rules.findIndex((item) => item.id === input.ruleId);
      if (index < 0) return { status: 404, value: refuse('rule-not-found') };
      const [removed] = rules.splice(index, 1);
      record({
        action: 'delete-rule',
        groupId: removed!.groupId,
        groupName: removed!.groupName,
        target: removed!.cargoKey,
        outcome: 'done',
      });
      return { status: 200, value: ok({ operation: 'delete-rule' }) };
    }
    case 'delete-start': {
      if (!group || group.role) return { status: 403, value: refuse('delete-not-allowed') };
      if ((input.confirmName ?? '').trim() !== group.name)
        return { status: 400, value: refuse('name-mismatch') };
      if (rules.some((item) => item.active && item.groupId === group.id))
        return { status: 409, value: refuse('group-has-rules') };
      // The preview has no Microsoft sign-in: the group goes at once and the page comes back as
      // it would from Microsoft.
      groups.splice(groups.indexOf(group), 1);
      record({
        action: 'delete-group',
        groupId: group.id,
        groupName: group.name,
        target: null,
        outcome: 'done',
      });
      return {
        status: 200,
        value: ok({ operation: 'delete-start', authorizeUrl: '#/configuracoes?grupos=excluido' }),
      };
    }
    default:
      return { status: 400, value: refuse('invalid-request') };
  }
}
