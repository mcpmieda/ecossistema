import type { CoreModuleContract, PlatformCapability } from '../../shared/platform-contract';
import { platformHref } from './routes';

export const notesModule: CoreModuleContract = {
  id: 'content.notes',
  name: 'Banco de notas',
  description: 'Importação, reconhecimento e evolução do fluxo de notas escolares.',
  route: 'banco-de-notas',
  state: 'ready',
  requiredRole: 'ADMINISTRADOR',
  capabilities: ['area.desempenho', 'area.importacao', 'gradebook.persistence.admin'],
};

type NotesSection = {
  id: string;
  label: string;
  description: string;
  href: string;
  searchTerms: string;
};

export const defaultNotesSectionId = 'importacao';

const notesHref = platformHref('banco-de-notas');
const notesAreaHref = (area: string): string => `${notesHref}?area=${encodeURIComponent(area)}`;

/** In the order of the tabs: Desempenho first and Auditoria beside Configurações. */
export const notesSections: NotesSection[] = [
  {
    id: defaultNotesSectionId,
    label: 'Importação',
    description: 'Importar e reconhecer planilhas de notas XLSB, XLSX e XLS.',
    href: notesHref,
    searchTerms: 'importar importação planilha planilhas xlsb xlsx xls leitor reconhecimento',
  },
  {
    id: 'performance',
    label: 'Desempenho',
    description: 'Analisar resultado, quantitativo, qualitativo e avaliações por turma.',
    href: notesAreaHref('performance'),
    searchTerms: 'desempenho performance resultado quantitativo qualitativo avaliações turma',
  },
  {
    id: 'council',
    label: 'Conselho',
    description: 'Abrir fila, decisões e fechamento institucional do Conselho de Classe.',
    href: notesAreaHref('council'),
    searchTerms: 'conselho classe fila elegibilidade decisão anual fechamento votação histórico',
  },
  {
    id: 'audit',
    label: 'Auditoria',
    description: 'Revisar ocorrências, reconciliações, histórico e resoluções.',
    href: notesAreaHref('audit'),
    searchTerms: 'auditoria ocorrência reconciliação resolução divergência histórico',
  },
  {
    id: 'onedrive',
    label: 'OneDrive',
    description: 'Leitura automática das planilhas salvas na pasta do OneDrive da secretaria.',
    href: notesAreaHref('onedrive'),
    searchTerms: 'onedrive leitura automática sincronização pasta planilhas professores lançamento',
  },
  {
    id: 'settings',
    label: 'Configurações',
    description: 'Administrar o ciclo de vida dos anos letivos do Banco de Notas.',
    href: notesAreaHref('settings'),
    searchTerms: 'configuração configurações reset resetar limpar ano letivo reiniciar sistema',
  },
];

/** The capability each section of the Banco de notas needs (#1513). */
export function notesSectionCapabilityV1(sectionId: string): PlatformCapability {
  if (sectionId === defaultNotesSectionId || sectionId === 'audit' || sectionId === 'onedrive')
    return 'area.importacao';
  return sectionId === 'settings' ? 'gradebook.persistence.admin' : 'area.desempenho';
}

/**
 * The Banco de notas as this person may open it (#1513): its capabilities say which of its areas
 * (Banco de notas, Importação) and whether its year settings show. Nothing without either area.
 */
export function withNotesAccessV1(
  modules: CoreModuleContract[],
  capabilities: readonly PlatformCapability[],
): CoreModuleContract[] {
  const existing = modules.filter((module) => module.route !== notesModule.route);
  const granted = notesModule.capabilities.filter((capability) =>
    capabilities.includes(capability),
  );
  return granted.some((capability) => capability.startsWith('area.'))
    ? [...existing, { ...notesModule, capabilities: granted }]
    : existing;
}
