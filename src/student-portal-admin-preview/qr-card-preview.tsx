import { useEffect, useState } from 'react';
import { QrCardSchoolV1, QrAccessCard } from './qr-access-card';
import { createRoot, type Root } from 'react-dom/client';
import { qrSvgV1 } from '../features/student-portal-admin/credentials/qr-artifacts-v1';
import { SYNTHETIC_QR_V1 } from '../../shared/student-portal-contracts/fixtures-v1';
import emblem from '../features/student-portal-admin/credentials/assets/school-emblem-outline.png';
import portrait from './assets/synthetic-student-portrait.png';

import './qr-card-preview.css';

const qrImage = `data:image/svg+xml,${encodeURIComponent(qrSvgV1(SYNTHETIC_QR_V1))}`;
const spacingKey = 'qr-card-preview-symbol-spacing';
const rowsKey = 'qr-card-preview-symbol-rows';
const emblemSize = 20;

function columnsForWidth(width: number, spacing: number, size: number) {
  return Math.floor((width - size) / (size + spacing)) + 1;
}

function sizeForRows(height: number, rows: number, spacing: number) {
  return Math.min(emblemSize, Math.floor((height - (rows - 1) * spacing) / rows));
}

function savedSetting(key: string, fallback: number, min: number, max: number) {
  const stored = window.localStorage.getItem(key);
  if (stored === null) return fallback;
  const value = Number(stored);
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

const sampleNames = [
  { label: 'Curto', value: 'Lucas Exemplo' },
  { label: 'Longo', value: 'Ana Beatriz Exemplo de Albuquerque' },
  {
    label: 'Muito longo',
    value: 'Maria Eduarda Exemplo de Albuquerque e Vasconcelos da Silva Nascimento',
  },
] as const;

function QrCardPreview() {
  const [selectedName, setSelectedName] = useState<(typeof sampleNames)[number]['value']>(
    sampleNames[1].value,
  );
  const [symbolSpacing, setSymbolSpacing] = useState(() => savedSetting(spacingKey, 10, 4, 12));
  const [symbolRows, setSymbolRows] = useState(() => savedSetting(rowsKey, 4, 3, 6));
  const nameSize =
    selectedName.length > 42 ? 'xlong' : selectedName.length > 25 ? 'long' : 'regular';
  const footerRows = Math.min(4, symbolRows - 1);
  const headerSize = sizeForRows(132, symbolRows, symbolSpacing);
  const footerSize = sizeForRows(84, footerRows, symbolSpacing);
  const headerColumns = columnsForWidth(856, symbolSpacing, headerSize);
  const footerColumns = columnsForWidth(856 * 0.64, symbolSpacing, footerSize);
  const headerEmblems = Array.from({ length: headerColumns * symbolRows }, (_, index) => index);
  const footerEmblems = Array.from({ length: footerColumns * footerRows }, (_, index) => index);

  useEffect(() => {
    window.localStorage.setItem(spacingKey, String(symbolSpacing));
    window.localStorage.setItem(rowsKey, String(symbolRows));
  }, [symbolSpacing, symbolRows]);

  return (
    <main className="qr-card-preview">
      <header className="qr-card-preview__heading">
        <p>Preview local · dados sintéticos</p>
        <h1>Comparação do cartão QR</h1>
        <div className="qr-card-preview__samples" aria-label="Testar comprimento do nome">
          <span>Testar nome</span>
          {sampleNames.map((sample) => (
            <button
              key={sample.label}
              type="button"
              aria-pressed={selectedName === sample.value}
              onClick={() => setSelectedName(sample.value)}
            >
              {sample.label}
            </button>
          ))}
        </div>
        <div className="qr-card-preview__pattern-controls">
          <label htmlFor="symbol-spacing">
            Espaço mínimo <output htmlFor="symbol-spacing">{symbolSpacing} px</output>
            <input
              id="symbol-spacing"
              type="range"
              min="4"
              max="12"
              step="1"
              value={symbolSpacing}
              onChange={(event) => setSymbolSpacing(Number(event.currentTarget.value))}
            />
          </label>
          <label htmlFor="symbol-quantity">
            Linhas de escudos{' '}
            <output htmlFor="symbol-quantity">
              {symbolRows} topo · {footerRows} rodapé
            </output>
            <input
              id="symbol-quantity"
              type="range"
              min="3"
              max="6"
              step="1"
              value={symbolRows}
              onChange={(event) => setSymbolRows(Number(event.currentTarget.value))}
            />
          </label>
        </div>
      </header>
      <section className="qr-card-preview__canvas" aria-label="Chave de acesso do aluno">
        <div className="qr-card-preview__comparison">
          <div className="qr-card-preview__version">
            <article className="qr-card">
              <div className="qr-card__brand">
                <div
                  className="qr-card__pattern qr-card__brand-pattern"
                  aria-hidden="true"
                  style={{
                    gap: symbolSpacing,
                    gridTemplateColumns: `repeat(${headerColumns}, ${headerSize}px)`,
                    gridTemplateRows: `repeat(${symbolRows}, ${headerSize}px)`,
                  }}
                >
                  {headerEmblems.map((index) => (
                    <img key={index} src={emblem} alt="" />
                  ))}
                </div>
                <QrCardSchoolV1 />
              </div>
              <div className="qr-card__content">
                <div className="qr-card__photo">
                  <img src={portrait} alt="Retrato fictício do aluno" />
                </div>
                <div className={`qr-card__identity qr-card__identity--${nameSize}`}>
                  <h2>{selectedName}</h2>
                  <p>7º ANO A</p>
                </div>
                <div className="qr-card__qr-frame">
                  <img src={qrImage} alt="QR de demonstração" />
                </div>
              </div>
              <div className="qr-card__footer">
                <div
                  className="qr-card__pattern qr-card__footer-pattern"
                  aria-hidden="true"
                  style={{
                    gap: symbolSpacing,
                    gridTemplateColumns: `repeat(${footerColumns}, ${footerSize}px)`,
                    gridTemplateRows: `repeat(${footerRows}, ${footerSize}px)`,
                  }}
                >
                  {footerEmblems.map((index) => (
                    <img key={index} src={emblem} alt="" />
                  ))}
                </div>
                <div className="qr-card__footer-copy">
                  <span>Portal do Aluno</span>
                  <strong>Chave de acesso</strong>
                </div>
              </div>
            </article>
          </div>
          <div className="qr-card-preview__version">
            <p className="qr-card-preview__version-label">Proposta · identidade editorial</p>
            <QrAccessCard
              name={selectedName}
              classLabel="7º ANO A"
              qr={SYNTHETIC_QR_V1}
              symbolSpacing={symbolSpacing}
              symbolRows={symbolRows}
            />
          </div>
        </div>
      </section>
    </main>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('Preview root missing');
const app = (import.meta.hot?.data.root as Root | undefined) ?? createRoot(root);
if (import.meta.hot) import.meta.hot.data.root = app;
app.render(<QrCardPreview />);
