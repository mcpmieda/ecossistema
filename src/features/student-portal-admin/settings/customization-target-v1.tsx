import { Button, Drawer } from '@heroui/react';
import type { CustomizationRowV1 } from '../../../../shared/student-portal-contracts/customizations-v1';
import { AccountDetailV1, type AccountDetailPropsV1 } from '../accounts/account-detail-v1';
import { StudentPoliciesV1 } from './student-policies-v1';
import { allowDraftNavigationV1 } from '../../../shared/forms/draft-navigation-v1';
import type { CustomizationAreaV1 } from './customization-values-v1';

type Props = Omit<AccountDetailPropsV1, 'accountId' | 'parentScope' | 'initialSlot'> & {
  row: CustomizationRowV1;
  area: CustomizationAreaV1;
};
/** Students use the shared account drawer. A class has its own scope,
 * never an invented student identity or a second copy of the publication editor.
 * A class's publication difference opens on its Notas tab. */
export function CustomizationTargetV1(props: Props) {
  const { row, area, client, reader, canWrite, onClose, onChanged } = props;
  if (row.scope.kind === 'account')
    return (
      <AccountDetailV1
        {...props}
        accountId={row.scope.accountId}
        parentScope={{ kind: 'school', academicYear: 2026 }}
        initialSlot="settings"
      />
    );
  const close = () => {
    if (allowDraftNavigationV1()) onClose();
  };
  return (
    <Drawer.Backdrop
      isOpen
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <Drawer.Content placement="right">
        <Drawer.Dialog
          aria-label={row.scope.kind === 'shift' ? 'Políticas do turno' : 'Políticas da turma'}
          className="pa-student-drawer"
        >
          <Drawer.Header className="flex-row items-center justify-between">
            <Drawer.Heading>{row.label}</Drawer.Heading>
            <Button size="sm" variant="ghost" onPress={close}>
              Fechar
            </Button>
          </Drawer.Header>
          <Drawer.Body>
            <StudentPoliciesV1
              client={client}
              reader={reader}
              scope={row.scope}
              scopeLabel={row.label}
              canWrite={canWrite}
              initialCategory={area === 'publication' ? 'grades' : undefined}
              onCommitted={onChanged}
            />
          </Drawer.Body>
        </Drawer.Dialog>
      </Drawer.Content>
    </Drawer.Backdrop>
  );
}
