import { useMemo, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  PRINT_MODES_V1,
  type PrintModeV1,
} from '../features/student-portal-admin/credentials/qr-values-v1';
import { QrAccessCard } from './qr-access-card';
import './qr-card-preview.css';
import './qr-batch-preview.css';

const students = Array.from({ length: 12 }, (_, index) => ({
  id: `75600000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
  name:
    index === 5
      ? 'Maria Eduarda Exemplo de Albuquerque e Vasconcelos da Silva Nascimento'
      : `Aluno Exemplo ${String(index + 1).padStart(2, '0')}`,
  classLabel: '7º ANO A',
  qr: `https://aluno.escolaieda.com/access#v1.${String(index + 1).padStart(43, 'a')}.1.${'b'.repeat(43)}`,
}));

type Selection = 'class' | 'selected';

function savedSetting(key: string, fallback: number, min: number, max: number) {
  const stored = window.localStorage.getItem(key);
  if (stored === null) return fallback;
  const value = Number(stored);
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

function QrBatchPreview() {
  const [selection, setSelection] = useState<Selection>('class');
  const [mode, setMode] = useState<PrintModeV1>('qr-name-class');
  const [withInstruction, setWithInstruction] = useState(false);
  const [instruction, setInstruction] = useState('Acesse o Portal do Aluno com este cartão.');
  const [symbolSpacing] = useState(() => savedSetting('qr-card-preview-symbol-spacing', 10, 4, 12));
  const [symbolRows] = useState(() => savedSetting('qr-card-preview-symbol-rows', 4, 3, 6));
  const cards = useMemo(
    () => students.slice(0, selection === 'class' ? students.length : 3),
    [selection],
  );
  const pages = Array.from({ length: Math.ceil(cards.length / 8) }, (_, index) =>
    cards.slice(index * 8, index * 8 + 8),
  );

  return (
    <main className="qr-batch-preview">
      <header className="qr-batch-preview__header">
        <div>
          <p className="qr-batch-preview__eyebrow">Preview local · dados sintéticos</p>
          <h1>Cartões QR em lote</h1>
          <p>Folha A4 · 8 cartões de 9,35 × 5,9 cm encostados, sem linha de corte.</p>
        </div>
        <button type="button" onClick={() => window.print()}>
          Imprimir / salvar PDF
        </button>
      </header>
      <section className="qr-batch-preview__controls" aria-label="Opções do lote">
        <fieldset>
          <legend>Impressão</legend>
          <label>
            <input
              type="radio"
              name="selection"
              checked={selection === 'class'}
              onChange={() => setSelection('class')}
            />
            Turma inteira · {students.length} cartões
          </label>
          <label>
            <input
              type="radio"
              name="selection"
              checked={selection === 'selected'}
              onChange={() => setSelection('selected')}
            />
            {'Selecionados · 3 cartões'}
          </label>
        </fieldset>
        <fieldset>
          <legend>Conteúdo</legend>
          {(Object.entries(PRINT_MODES_V1) as [PrintModeV1, string][]).map(([value, label]) => (
            <label key={value}>
              <input
                type="radio"
                name="mode"
                checked={mode === value}
                onChange={() => setMode(value)}
              />
              {label}
            </label>
          ))}
        </fieldset>
        <div className="qr-batch-preview__instruction">
          <label>
            <input
              type="checkbox"
              checked={withInstruction}
              onChange={(event) => setWithInstruction(event.target.checked)}
            />
            {'Adicionar instrução ao cartão'}
          </label>
          {withInstruction && (
            <input
              aria-label="Instrução no cartão"
              value={instruction}
              maxLength={240}
              onChange={(event) => setInstruction(event.target.value)}
            />
          )}
        </div>
      </section>
      <section className="qr-batch-preview__paper" aria-label="Prévia do PDF em lote">
        {pages.map((page, pageIndex) => (
          <div
            className="qr-batch-preview__sheet"
            key={pageIndex /* NOSONAR fixed preview pages */}
          >
            {page.map((card) => (
              <div className="qr-batch-preview__card" key={card.id}>
                <QrAccessCard
                  name={card.name}
                  classLabel={card.classLabel}
                  qr={card.qr}
                  mode={mode}
                  instruction={withInstruction ? instruction : ''}
                  symbolSpacing={symbolSpacing}
                  symbolRows={symbolRows}
                />
              </div>
            ))}
          </div>
        ))}
      </section>
    </main>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('Preview root missing');
const app = (import.meta.hot?.data.root as Root | undefined) ?? createRoot(root);
if (import.meta.hot) import.meta.hot.data.root = app;
app.render(<QrBatchPreview />);
