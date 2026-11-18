import { createContext, useContext } from 'react';
import type { PlatformCapability } from '../../shared/platform-contract';

/**
 * What the signed-in person may do, as /api/me said (#1530 A4), for screens deep in an area that
 * hide a control the server would refuse. The server still decides; this only avoids offering it.
 */
const CapabilitiesContextV1 = createContext<readonly PlatformCapability[] | null>(null);
export const PlatformCapabilitiesProviderV1 = CapabilitiesContextV1.Provider;

/** null outside the Centro's shell (component tests, previews): the caller keeps its default. */
export const usePlatformCapabilitiesV1 = (): readonly PlatformCapability[] | null =>
  useContext(CapabilitiesContextV1);
