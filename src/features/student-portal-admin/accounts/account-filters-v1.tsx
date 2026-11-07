import type { ComponentProps } from 'react';
import { CircleCheck, KeyRound, LockKeyhole, LockKeyholeOpen, UserRoundPlus } from 'lucide-react';
import type { AdminAccountReadV2 } from '../../../../shared/student-portal-contracts/admin-read-v2';
import { FilterTagsV1 } from '../../../shared/ui/filter-tags-v1';
export const ACCOUNT_STATE_OPTIONS_V1 = [
  {
    id: 'pending-activation',
    label: 'Primeiro acesso',
    icon: <UserRoundPlus size={13} aria-hidden />,
  },
  { id: 'active', label: 'Ativa', icon: <CircleCheck size={13} aria-hidden /> },
  { id: 'reset-required', label: 'Redefinição pendente', icon: <KeyRound size={13} aria-hidden /> },
] as const;
export const ACCOUNT_BLOCK_OPTIONS_V1 = [
  { id: 'blocked', label: 'Bloqueadas', icon: <LockKeyhole size={13} aria-hidden /> },
  { id: 'unblocked', label: 'Sem bloqueio', icon: <LockKeyholeOpen size={13} aria-hidden /> },
] as const;
/** Empty selection means unrestricted. Multiple values are OR within each group, AND across groups. */
export function matchesAccountFiltersV1(
  account: AdminAccountReadV2,
  states: ReadonlySet<string>,
  blocks: ReadonlySet<string>,
) {
  return (
    (!states.size || states.has(account.state)) &&
    (!blocks.size || blocks.has(account.blocked ? 'blocked' : 'unblocked'))
  );
}
/** The shared filter tags, with the class the Painel styles hang on. */
export function AccountFilterTagsV1(
  props: Omit<ComponentProps<typeof FilterTagsV1>, 'className' | 'inline'>,
) {
  return <FilterTagsV1 {...props} className="pa-account-filter-tags" />;
}
