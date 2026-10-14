import type { CoreModuleContract } from '../../shared/platform-contract';
import { platformHref } from './routes';

export const notesModule: CoreModuleContract = {
  id: 'content.notes',
  name: 'Banco de notas',
  description: 'Importação, reconhecimento e evolução do fluxo de notas escolares.',
  route: 'banco-de-notas',
  state: 'ready',
  requiredRole: 'ADMINISTRADOR',
  capabilities: [],
};

export type NotesSection = {
  id: string;
  label: string;
  description: string;
  href: string;
  searchTerms: string;
};

export const defaultNotesSectionId = 'importacao';

const notesHref = platformHref('banco-de-notas');
const notesAreaHref = (area: string): string => `${notesHref}?area=${encodeURIComponent(area)}`;

/** In the order of the tabs: Desempenho first and Auditoria beside Configurações (owner request of 13/10/2026). */
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
    id: 'bulletins',
    label: 'Boletins',
    description: 'Abrir preview, emissão, PDF, histórico e reimpressão de boletins.',
    href: notesAreaHref('bulletins'),
    searchTerms: 'boletim boletins preview emissão pdf histórico reimpressão',
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
    id: 'settings',
    label: 'Configurações',
    description: 'Administrar o ciclo de vida dos anos letivos do Banco de Notas.',
    href: notesAreaHref('settings'),
    searchTerms: 'configuração configurações reset resetar limpar ano letivo reiniciar sistema',
  },
];

export function withNotesModule(modules: CoreModuleContract[]): CoreModuleContract[] {
  return modules.some((module) => module.route === notesModule.route)
    ? modules
    : [...modules, notesModule];
}
