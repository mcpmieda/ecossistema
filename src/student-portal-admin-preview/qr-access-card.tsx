import { qrSvgV1 } from '../features/student-portal-admin/credentials/qr-artifacts-v1';
import { SCHOOL_CARD_NAME_LINES_V1, SCHOOL_NAME_V1 } from '../shared/brand/school-name-v1';
import type { PrintModeV1 } from '../features/student-portal-admin/credentials/qr-values-v1';
import crest from '../features/student-portal-admin/credentials/assets/school-crest.png';
import emblem from '../features/student-portal-admin/credentials/assets/school-emblem-outline.png';
import portrait from './assets/synthetic-student-portrait.png';

const emblemSize = 20;

function columnsForWidth(width: number, spacing: number, size: number) {
  return Math.floor((width - size) / (size + spacing)) + 1;
}

function sizeForRows(height: number, rows: number, spacing: number) {
  return Math.min(emblemSize, Math.floor((height - (rows - 1) * spacing) / rows));
}

type QrAccessCardProps = {
  name: string;
  classLabel: string;
  qr: string;
  symbolSpacing: number;
  symbolRows: number;
  mode?: PrintModeV1;
  instruction?: string;
};

/** Crest and official name, shared by the card previews. */
export function QrCardSchoolV1() {
  return (
    <>
      <span className="qr-card__crest">
        <img src={crest} alt={`Brasão da ${SCHOOL_NAME_V1}`} />
      </span>
      <div className="qr-card__brand-copy">
        <span>{SCHOOL_CARD_NAME_LINES_V1[0]}</span>
        <strong>{SCHOOL_CARD_NAME_LINES_V1[1]}</strong>
      </div>
    </>
  );
}

export function QrAccessCard({
  name,
  classLabel,
  qr,
  symbolSpacing,
  symbolRows,
  mode = 'qr-name-class',
  instruction = '',
}: Readonly<QrAccessCardProps>) {
  const footerRows = Math.min(4, symbolRows - 1);
  const headerSize = sizeForRows(132, symbolRows, symbolSpacing);
  const footerSize = sizeForRows(84, footerRows, symbolSpacing);
  const headerColumns = columnsForWidth(856, symbolSpacing, headerSize);
  const footerColumns = columnsForWidth(856, symbolSpacing, footerSize);
  const headerEmblems = Array.from({ length: headerColumns * symbolRows }, (_, index) => index);
  const footerEmblems = Array.from({ length: footerColumns * footerRows }, (_, index) => index);
  let nameSize: 'xlong' | 'long' | 'regular';
  if (name.length > 42) {
    nameSize = 'xlong';
  } else if (name.length > 25) {
    nameSize = 'long';
  } else {
    nameSize = 'regular';
  }
  const qrImage = `data:image/svg+xml,${encodeURIComponent(qrSvgV1(qr))}`;

  return (
    <article className="qr-card qr-card--proposal">
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
        <div className="qr-card__access-copy">
          <span>Portal do Aluno</span>
          <strong>Cartão de acesso</strong>
        </div>
      </div>
      <div className="qr-card__content">
        <div className="qr-card__photo">
          <img src={portrait} alt="Retrato fictício do aluno" />
        </div>
        <div className={`qr-card__identity qr-card__identity--${nameSize}`}>
          {mode !== 'qr-only' && <h2>{name}</h2>}
          {mode === 'qr-name-class' && (
            <p>
              <strong>{classLabel}</strong>
            </p>
          )}
          {instruction.trim() && <p className="qr-card__instruction">{instruction.trim()}</p>}
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
      </div>
    </article>
  );
}
