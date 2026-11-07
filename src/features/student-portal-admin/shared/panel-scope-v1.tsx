import { createContext, useContext } from 'react';
import type { ScopeV1 } from '../../../../shared/student-portal-contracts/core-v1';

type PanelScopeV1 = { scope: ScopeV1; label: string };
export const PanelScopeContextV1 = createContext<PanelScopeV1 | null>(null);
export const usePanelScopeV1 = () => useContext(PanelScopeContextV1);
