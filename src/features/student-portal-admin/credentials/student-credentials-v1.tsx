import type { ScopeV1 } from '../../../../shared/student-portal-contracts/core-v1';
import type { PortalAdminClientV1 } from '../shared/admin-client-v1';
import type { PortalAdminReadClientV2, PortalClassCatalogV2 } from '../accounts/accounts-client-v2';
import type { PortalClientErrorV1 } from '../../student-portal/shared/transport-v1';
import type { QrRendererV1 } from './qr-operation-v1';
import { settingsScopeKeyV1 } from '../settings/settings-values-v1';
import { ClassQrV1 } from './class-qr-v1';
import { IndividualQrV1 } from './individual-qr-v1';
import './student-credentials-v1.css';
export interface StudentCredentialsPropsV1 {
  client: PortalAdminClientV1;
  reader: PortalAdminReadClientV2;
  scope: ScopeV1;
  identityKey: string;
  canWrite: boolean;
  scopeLabel?: string;
  catalog?: PortalClassCatalogV2;
  refreshKey?: number;
  onAuthorizationLost?: (error: PortalClientErrorV1) => void;
  renderArtifact?: QrRendererV1;
}
export function StudentCredentialsV1(props: StudentCredentialsPropsV1) {
  const key =
    props.identityKey +
    ':' +
    settingsScopeKeyV1(props.scope) +
    ':' +
    props.canWrite +
    ':' +
    (props.refreshKey ?? '');
  return props.scope.kind === 'account' ? (
    <IndividualQrV1 key={key} {...props} scope={props.scope} />
  ) : (
    <ClassQrV1 key={key} {...props} />
  );
}
