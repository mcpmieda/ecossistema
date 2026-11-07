import {
  BookOpenText,
  HeartPulse,
  Settings2,
  GraduationCap,
  type LucideIcon,
} from 'lucide-react';
import type { PlatformRoute } from '../../shared/platform-contract';

export const routeIcons: Record<PlatformRoute, LucideIcon> = {
  operacao: HeartPulse,
  'banco-de-notas': BookOpenText,
  'painel-do-aluno': GraduationCap,
  configuracoes: Settings2,
};

export function platformHref(route: PlatformRoute): string {
  return `#/${route}`;
}
