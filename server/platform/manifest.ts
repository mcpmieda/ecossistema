import { z } from 'zod';
import {
  PLATFORM_CAPABILITIES,
  PLATFORM_ROUTES,
  STUDENT_PORTAL_MODULE,
  type CoreModuleContract,
} from '../../shared/platform-contract';

const platformRouteSchema = z.enum(PLATFORM_ROUTES);
const platformCapabilitySchema = z.enum(PLATFORM_CAPABILITIES);
const moduleStateSchema = z.enum(['ready', 'planned']);

export const coreModuleSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  route: platformRouteSchema,
  state: moduleStateSchema,
  requiredRole: z.literal('ADMINISTRADOR'),
  capabilities: z.array(platformCapabilitySchema).min(1),
});

export const coreModules: CoreModuleContract[] = z.array(coreModuleSchema).parse([
  STUDENT_PORTAL_MODULE,
  {
    id: 'platform.operations',
    name: 'Saúde',
    description: 'Disponibilidade, sinais operacionais do Portal do Aluno e trilha de auditoria.',
    route: 'operacao',
    state: 'ready',
    requiredRole: 'ADMINISTRADOR',
    capabilities: ['platform.health.read', 'platform.settings.read'],
  },
  {
    id: 'platform.settings',
    name: 'Configurações',
    description: 'Leitura segura das chaves e metadados de configuração da plataforma.',
    route: 'configuracoes',
    state: 'ready',
    requiredRole: 'ADMINISTRADOR',
    capabilities: ['platform.settings.read'],
  },
]);
