import type {
  GroupChangeV1,
  GroupPersonV1,
  GroupRoleV1,
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

const view = (group: PreviewGroupV1): GroupViewV1 => {
  const { members, ...rest } = group;
  return { ...rest, memberCount: members.size };
};
const ok = (value: object) => ({ contractVersion: 1, state: 'ok', ...value });
const refuse = (state: string) => ({ contractVersion: 1, state });
const record = (change: Omit<GroupChangeV1, 'at' | 'actor'>) =>
  changes.unshift({ ...change, at: new Date().toISOString(), actor: 'Administração sintética' });

/** The answer of POST /api/platform/groups in the preview, with its status. */
export function previewGroupsV1(body: string): { status: number; value: object } {
  const input = JSON.parse(body) as Record<string, string | undefined>;
  const group = groups.find((item) => item.id === input.groupId);
  switch (input.operation) {
    case 'list':
      return { status: 200, value: ok({ operation: 'list', groups: groups.map(view) }) };
    case 'members':
      if (!group) return { status: 403, value: refuse('not-allowed') };
      return {
        status: 200,
        value: ok({
          operation: 'members',
          groupId: group.id,
          members: people.filter((person) => group.members.has(person.id)),
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
      if (groups.some((item) => item.name.toLowerCase() === name.toLowerCase()))
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
    default:
      return { status: 400, value: refuse('invalid-request') };
  }
}
