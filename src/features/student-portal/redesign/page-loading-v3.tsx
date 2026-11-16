import { Card } from '@heroui/react/card';
import { Spinner } from '@heroui/react/spinner';

/** Frequência, Horário and Ocorrências before their first read: the page's title and what its
 * loading card says. The pages use these words; the shell shows the same while a page's own code
 * is still on its way (each one arrives on demand). */
export const PAGE_LOADING_V3 = {
  frequency: { className: 'pa3-frequency', title: 'Frequência do aluno', message: 'Carregando frequência…' },
  schedule: { className: 'pa3-schedule', title: 'Horário', message: 'Carregando horário…' },
  incidents: { className: 'pa3-incidents', title: 'Ocorrências', message: 'Carregando as ocorrências…' },
} as const;

export function PageLoadingV3({ page }: Readonly<{ page: keyof typeof PAGE_LOADING_V3 }>) {
  const { className, title, message } = PAGE_LOADING_V3[page];
  return (
    <div className={className}>
      <h2 className="pa3-page-title">{title}</h2>
      <Card className="pa3-card pa3-status">
        <output className="pa3-status-loading">
          <Spinner size="sm" /> {message}
        </output>
      </Card>
    </div>
  );
}
