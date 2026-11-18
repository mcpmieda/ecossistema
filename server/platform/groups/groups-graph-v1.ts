import type { GroupPersonV1 } from '../../../shared/platform-groups-v1';
import type { RuntimeEnv } from '../../env';
import { GraphError, graphRequest } from '../../graph/client';

/**
 * The Graph Backend app on the groups (#1513): GroupMember.ReadWrite.All, Group.Create and
 * User.Read.All, application permissions. Callers decide which groups may be touched.
 */
export type EntraGroupV1 = {
  id: string;
  name: string;
  description: string | null;
  mail: string | null;
};

export type GroupsGraphPortV1 = {
  /** The group, or null when Entra has no such group. */
  group(id: string): Promise<EntraGroupV1 | null>;
  memberCount(id: string): Promise<number | null>;
  members(id: string): Promise<GroupPersonV1[]>;
  /** Accounts whose name, e-mail or sign-in name starts with the text. */
  findPeople(text: string): Promise<GroupPersonV1[]>;
  /** The account with this sign-in name or e-mail, or null. */
  person(email: string): Promise<GroupPersonV1 | null>;
  isMember(groupId: string, personId: string): Promise<boolean>;
  addMember(groupId: string, personId: string): Promise<'added' | 'already-member'>;
  removeMember(groupId: string, personId: string): Promise<'removed' | 'not-member'>;
  /** The person holds the directory role (by its object id in the tenant). */
  holdsDirectoryRole(personId: string, roleObjectId: string): Promise<boolean>;
  /** Finds a group just created when Entra's answer was lost. */
  groupByMailNickname(mailNickname: string): Promise<EntraGroupV1 | null>;
  /** Deletes with the person's own delegated token: Entra decides if that person may. */
  deleteGroupAs(groupId: string, token: string): Promise<'deleted' | 'not-found'>;
  createGroup(input: {
    name: string;
    description: string | null;
    mailNickname: string;
    ownerId: string;
  }): Promise<EntraGroupV1>;
};

const PERSON_FIELDS_V1 = 'id,displayName,mail,userPrincipalName,jobTitle,accountEnabled';
const GROUP_FIELDS_V1 = 'id,displayName,description,mail';
/** A role group like ALUNOS can be large; 50 pages of 999 is far above the school. */
const MEMBER_PAGES_MAX_V1 = 50;

type GraphUserV1 = {
  '@odata.type'?: string;
  id: string;
  displayName?: string | null;
  mail?: string | null;
  userPrincipalName?: string | null;
  jobTitle?: string | null;
  accountEnabled?: boolean | null;
};
type GraphGroupV1 = {
  id: string;
  displayName?: string | null;
  description?: string | null;
  mail?: string | null;
};
type PageV1<T> = { value: T[]; '@odata.nextLink'?: string };

export const personFromGraphV1 = (user: GraphUserV1): GroupPersonV1 => ({
  id: user.id,
  name: user.displayName ?? null,
  email: user.mail ?? user.userPrincipalName ?? null,
  jobTitle: user.jobTitle?.trim() ? user.jobTitle.trim() : null,
  enabled: typeof user.accountEnabled === 'boolean' ? user.accountEnabled : null,
});
const groupFromGraphV1 = (group: GraphGroupV1): EntraGroupV1 => ({
  id: group.id,
  name: group.displayName ?? '',
  description: group.description?.trim() ? group.description.trim() : null,
  mail: group.mail ?? null,
});

/** The `@odata.count` of a members page, or null. */
export function memberCountOfPageV1(page: unknown): number | null {
  const count = (page as { '@odata.count'?: unknown } | null)?.['@odata.count'];
  return typeof count === 'number' && Number.isInteger(count) && count >= 0 ? count : null;
}

const odataTextV1 = (value: string) => value.replaceAll("'", "''");
const isUserV1 = (item: GraphUserV1) =>
  item['@odata.type'] === undefined || item['@odata.type'] === '#microsoft.graph.user';

/** A status Graph answered with; anything else (transport, token) is rethrown. */
const statusOfV1 = (error: unknown): number | null =>
  error instanceof GraphError ? error.status : null;

export function graphGroupsPortV1(env: RuntimeEnv): GroupsGraphPortV1 {
  const get = <T>(path: string, consistencyLevel?: 'eventual') =>
    graphRequest<T>({ env, path, consistencyLevel }).then((answer) => answer.data);

  async function allPages<T>(first: string): Promise<T[]> {
    const items: T[] = [];
    let next: string | undefined = first;
    for (let page = 0; next && page < MEMBER_PAGES_MAX_V1; page++) {
      const answer: PageV1<T> = await get<PageV1<T>>(next);
      items.push(...answer.value);
      next = answer['@odata.nextLink'];
    }
    return items;
  }

  const port: GroupsGraphPortV1 = {
    async group(id) {
      try {
        return groupFromGraphV1(
          await get<GraphGroupV1>(`/groups/${encodeURIComponent(id)}?$select=${GROUP_FIELDS_V1}`),
        );
      } catch (error) {
        if (statusOfV1(error) === 404) return null;
        throw error;
      }
    },
    async memberCount(id) {
      // `/members/$count` answers in plain text only; `$count=true` brings it in the JSON page.
      return memberCountOfPageV1(
        await get<unknown>(
          `/groups/${encodeURIComponent(id)}/members?$count=true&$top=1&$select=id`,
          'eventual',
        ),
      );
    },
    async members(id) {
      const query = new URLSearchParams({ $select: PERSON_FIELDS_V1, $top: '999' });
      const items = await allPages<GraphUserV1>(
        `/groups/${encodeURIComponent(id)}/members?${query.toString()}`,
      );
      return items.filter(isUserV1).map(personFromGraphV1);
    },
    async findPeople(text) {
      const value = odataTextV1(text);
      const query = new URLSearchParams({
        $filter: ['displayName', 'mail', 'userPrincipalName']
          .map((field) => `startswith(${field},'${value}')`)
          .join(' or '),
        $select: PERSON_FIELDS_V1,
        $top: '15',
      });
      const answer = await get<PageV1<GraphUserV1>>(`/users?${query.toString()}`);
      return answer.value.map(personFromGraphV1);
    },
    async person(email) {
      try {
        return personFromGraphV1(
          await get<GraphUserV1>(`/users/${encodeURIComponent(email)}?$select=${PERSON_FIELDS_V1}`),
        );
      } catch (error) {
        if (statusOfV1(error) !== 404) throw error;
      }
      // The e-mail may differ from the sign-in name.
      const query = new URLSearchParams({
        $filter: `mail eq '${odataTextV1(email)}'`,
        $select: PERSON_FIELDS_V1,
        $top: '2',
      });
      const answer = await get<PageV1<GraphUserV1>>(`/users?${query.toString()}`);
      return answer.value.length === 1 ? personFromGraphV1(answer.value[0]!) : null;
    },
    async isMember(groupId, personId) {
      const answer = await graphRequest<{ value: string[] }>({
        env,
        method: 'POST',
        path: `/users/${encodeURIComponent(personId)}/checkMemberGroups`,
        body: { groupIds: [groupId] },
      });
      return answer.data.value.some((id) => id.toLowerCase() === groupId.toLowerCase());
    },
    async addMember(groupId, personId) {
      try {
        await graphRequest({
          env,
          method: 'POST',
          path: `/groups/${encodeURIComponent(groupId)}/members/$ref`,
          body: {
            '@odata.id': `https://graph.microsoft.com/v1.0/directoryObjects/${encodeURIComponent(personId)}`,
          },
        });
        return 'added';
      } catch (error) {
        // Graph answers 400 when the person is already a member.
        if (statusOfV1(error) === 400 && (await port.isMember(groupId, personId)))
          return 'already-member';
        throw error;
      }
    },
    async removeMember(groupId, personId) {
      try {
        await graphRequest({
          env,
          method: 'DELETE',
          path: `/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(personId)}/$ref`,
        });
        return 'removed';
      } catch (error) {
        if (statusOfV1(error) === 404) return 'not-member';
        throw error;
      }
    },
    async holdsDirectoryRole(personId, roleObjectId) {
      // Transitive, so a role held through a role-assignable group counts. Without a directory
      // permission the roles come with their id only, which is enough here.
      const items = await allPages<{ id: string }>(
        `/users/${encodeURIComponent(personId)}/transitiveMemberOf?$select=id&$top=999`,
      );
      return items.some((item) => item.id.toLowerCase() === roleObjectId.toLowerCase());
    },
    async groupByMailNickname(mailNickname) {
      const query = new URLSearchParams({
        $filter: `mailNickname eq '${odataTextV1(mailNickname)}'`,
        $select: GROUP_FIELDS_V1,
        $top: '1',
      });
      const answer = await get<PageV1<GraphGroupV1>>(`/groups?${query.toString()}`);
      return answer.value[0] ? groupFromGraphV1(answer.value[0]) : null;
    },
    async deleteGroupAs(groupId, token) {
      try {
        await graphRequest({
          env,
          token,
          method: 'DELETE',
          path: `/groups/${encodeURIComponent(groupId)}`,
        });
        return 'deleted';
      } catch (error) {
        if (statusOfV1(error) === 404) return 'not-found';
        throw error;
      }
    },
    async createGroup({ name, description, mailNickname, ownerId }) {
      const answer = await graphRequest<GraphGroupV1>({
        env,
        method: 'POST',
        path: '/groups',
        body: {
          displayName: name,
          ...(description ? { description } : {}),
          mailNickname,
          mailEnabled: true,
          securityEnabled: false,
          groupTypes: ['Unified'],
          visibility: 'Private',
          'owners@odata.bind': [
            `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(ownerId)}`,
          ],
        },
      });
      return groupFromGraphV1(answer.data);
    },
  };
  return port;
}

/**
 * The mail nickname of a new group: the name without accents, letters and digits only, and a random
 * ending, so two groups with similar names never collide.
 */
export function mailNicknameV1(name: string, random = crypto.randomUUID()): string {
  const base = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 40);
  return `${base || 'grupo'}-${random.replaceAll('-', '').slice(0, 6)}`;
}
