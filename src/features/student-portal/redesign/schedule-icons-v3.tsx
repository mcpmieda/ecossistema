import { useId, type CSSProperties, type ReactNode } from 'react';
import { reducedMotionV3 } from './portal-pages-v3';

/*
 * The Horário's icons (owner request 27/10/2026): lucide's own drawings of each subject, of the
 * parada and of the break, drawn here so their parts can move while their lesson is the one going on
 * now (`live`): the page of Português turns, the keys of Matemática light up, the flask of Ciências
 * bubbles, the columns of História rise, the Earth of Geografia turns, the paint of Arte pops, the
 * dumbbell of Ed. Física is lifted, the two scripts of Inglês take turns, the heart of Religião
 * beats, the pen of Redação writes, the scale of Ética weighs, code is typed on Informática's screen,
 * the bookmark of any other subject dips, the flag of the parada waves and the break's coffee
 * steams. Before and after their lesson they stand still (the parts that only exist to move are not
 * drawn), and they stand still with reduced motion (redesign-v3.css, .pa3-icon).
 */
export type ScheduleIconV3 = (props: Readonly<{ live: boolean }>) => ReactNode;

/** The order of a part among its siblings, for its animation's delay (--i in redesign-v3.css). */
const nth = (index: number) => ({ '--i': index }) as CSSProperties;

function IconV3({ name, live, children }: Readonly<{ name: string; live: boolean; children: ReactNode }>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`pa3-icon pa3-icon--${name}` + (live ? ' is-live' : '')}
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

/** Português: lucide's "book-open"; live, a page turns over the spine. */
export const BookIconV3: ScheduleIconV3 = ({ live }) => (
  <IconV3 name="book" live={live}>
    <path d="M12 5v16" />
    <path d="M20.001 19A2 2 0 0022 17V5a2 2 0 00-1.999-2L16 3.002A5 5 0 0012 5a5 5 0 00-4-2H4a2 2 0 00-2 2v12a2 2 0 001.999 2H8a5 5 0 014 2 5 5 0 014-2z" />
    {live ? <path className="pa3-icon-page" d="M12 5a5 5 0 0 1 4-2h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4a5 5 0 0 0-4 2" /> : null}
  </IconV3>
);

/** Matemática: lucide's "calculator"; live, its keys light up one after the other. */
const KEYS = ['M8 10h.01', 'M12 10h.01', 'M16 10h.01', 'M8 14h.01', 'M12 14h.01', 'M8 18h.01', 'M12 18h.01'];
export const CalculatorIconV3: ScheduleIconV3 = ({ live }) => (
  <IconV3 name="calculator" live={live}>
    <rect width="16" height="20" x="4" y="2" rx="2" />
    <line x1="8" x2="16" y1="6" y2="6" />
    <line x1="16" x2="16" y1="14" y2="18" />
    {KEYS.map((d, index) => (
      <path key={d} className="pa3-icon-key" d={d} style={nth(index)} />
    ))}
  </IconV3>
);

/** Ciências: lucide's "flask-conical"; live, bubbles rise and the liquid sways. */
export const FlaskIconV3: ScheduleIconV3 = ({ live }) => (
  <IconV3 name="flask" live={live}>
    <path d="M14 2v6a2 2 0 0 0 .245.96l5.51 10.08A2 2 0 0 1 18 22H6a2 2 0 0 1-1.755-2.96l5.51-10.08A2 2 0 0 0 10 8V2" />
    <path className="pa3-icon-liquid" d="M6.453 15h11.094" />
    <path d="M8.5 2h7" />
    {live
      ? [
          [10, 19, 0.9],
          [13.5, 19.5, 0.7],
          [12, 18.5, 0.8],
        ].map(([cx, cy, r], index) => (
          <circle key={cx} className="pa3-icon-bubble" cx={cx} cy={cy} r={r} fill="currentColor" stroke="none" style={nth(index)} />
        ))
      : null}
  </IconV3>
);

/** História: lucide's "landmark"; live, its columns rise one by one. */
export const LandmarkIconV3: ScheduleIconV3 = ({ live }) => (
  <IconV3 name="landmark" live={live}>
    <path d="M11.119 2.205a2 2 0 0 1 1.762 0l7.84 3.846A.5.5 0 0 1 20.5 7h-17a.5.5 0 0 1-.22-.949z" />
    <path d="M3 22h18" />
    {[6, 10, 14, 18].map((x, index) => (
      <path key={x} className="pa3-icon-column" d={`M${x} 18v-7`} style={nth(index)} />
    ))}
  </IconV3>
);

/**
 * Geografia: lucide's "earth" (Globe2); live, its continents turn without a jump: a second copy one
 * width to the right comes in as the first goes out, inside the globe's circle.
 */
const CONTINENTS = (
  <>
    <path d="M21.54 15H17a2 2 0 0 0-2 2v4.54" />
    <path d="M7 3.34V5a3 3 0 0 0 3 3a2 2 0 0 1 2 2c0 1.1.9 2 2 2a2 2 0 0 0 2-2c0-1.1.9-2 2-2h3.17" />
    <path d="M11 21.95V18a2 2 0 0 0-2-2a2 2 0 0 1-2-2v-1a2 2 0 0 0-2-2H2.05" />
  </>
);
export const EarthIconV3: ScheduleIconV3 = ({ live }) => {
  // React's ids ("«r0»") are not safe inside url(#…): letters and digits only.
  const clip = 'pa3-earth-' + useId().replace(/[^a-z0-9]/giu, '');
  return (
    <IconV3 name="earth" live={live}>
      <circle cx="12" cy="12" r="10" />
      {live ? (
        <>
          <clipPath id={clip}>
            <circle cx="12" cy="12" r="10" />
          </clipPath>
          <g clipPath={`url(#${clip})`}>
            <g className="pa3-icon-continents">
              {CONTINENTS}
              <g transform="translate(20 0)">{CONTINENTS}</g>
            </g>
          </g>
        </>
      ) : (
        CONTINENTS
      )}
    </IconV3>
  );
};

/** Arte: lucide's "palette"; live, its paint drops pop in turn. */
const DROPS = [
  [13.5, 6.5],
  [17.5, 10.5],
  [6.5, 12.5],
  [8.5, 7.5],
];
export const PaletteIconV3: ScheduleIconV3 = ({ live }) => (
  <IconV3 name="palette" live={live}>
    <path d="M12 22a1 1 0 0 1 0-20 10 9 0 0 1 10 9 5 5 0 0 1-5 5h-2.25a1.75 1.75 0 0 0-1.4 2.8l.3.4a1.75 1.75 0 0 1-1.4 2.8z" />
    {DROPS.map(([cx, cy], index) => (
      <circle key={`${cx}-${cy}`} className="pa3-icon-drop" cx={cx} cy={cy} r=".5" fill="currentColor" style={nth(index)} />
    ))}
  </IconV3>
);

/** Ed. Física: lucide's "dumbbell"; live, it is lifted and lowered. */
export const DumbbellIconV3: ScheduleIconV3 = ({ live }) => (
  <IconV3 name="dumbbell" live={live}>
    <path d="M17.596 12.768a2 2 0 1 0 2.829-2.829l-1.768-1.767a2 2 0 0 0 2.828-2.829l-2.828-2.828a2 2 0 0 0-2.829 2.828l-1.767-1.768a2 2 0 1 0-2.829 2.829z" />
    <path d="m2.5 21.5 1.4-1.4" />
    <path d="m20.1 3.9 1.4-1.4" />
    <path d="M5.343 21.485a2 2 0 1 0 2.829-2.828l1.767 1.768a2 2 0 1 0 2.829-2.829l-6.364-6.364a2 2 0 1 0-2.829 2.829l1.768 1.767a2 2 0 0 0-2.828 2.829z" />
    <path d="m9.6 14.4 4.8-4.8" />
  </IconV3>
);

/** Inglês and Espanhol: lucide's "languages"; live, the two scripts hop in turn. */
export const LanguagesIconV3: ScheduleIconV3 = ({ live }) => (
  <IconV3 name="languages" live={live}>
    <g className="pa3-icon-script" style={nth(0)}>
      <path d="m5 8 6 6" />
      <path d="m4 14 6-6 2-3" />
      <path d="M2 5h12" />
      <path d="M7 2h1" />
    </g>
    <g className="pa3-icon-script" style={nth(1)}>
      <path d="m22 22-5-10-5 10" />
      <path d="M14 18h6" />
    </g>
  </IconV3>
);

/** Religião: lucide's "heart-handshake"; live, the heart beats. */
export const HeartIconV3: ScheduleIconV3 = ({ live }) => (
  <IconV3 name="heart" live={live}>
    <path d="M19.414 14.414C21 12.828 22 11.5 22 9.5a5.5 5.5 0 0 0-9.591-3.676.6.6 0 0 1-.818.001A5.5 5.5 0 0 0 2 9.5c0 2.3 1.5 4 3 5.5l5.535 5.362a2 2 0 0 0 2.879.052 2.12 2.12 0 0 0-.004-3 2.124 2.124 0 1 0 3-3 2.124 2.124 0 0 0 3.004 0 2 2 0 0 0 0-2.828l-1.881-1.882a2.41 2.41 0 0 0-3.409 0l-1.71 1.71a2 2 0 0 1-2.828 0 2 2 0 0 1 0-2.828l2.823-2.762" />
  </IconV3>
);

/** Redação: lucide's "pen-line"; live, the pen writes its line. */
export const PenIconV3: ScheduleIconV3 = ({ live }) => (
  <IconV3 name="pen" live={live}>
    <path className="pa3-icon-line" d="M13 21h8" />
    <path className="pa3-icon-nib" d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" />
  </IconV3>
);

/** Ética and Cidadania: lucide's "scale"; live, it weighs one side and then the other. */
export const ScaleIconV3: ScheduleIconV3 = ({ live }) => (
  <IconV3 name="scale" live={live}>
    <path d="M12 3v18" />
    <path d="M7 21h10" />
    <g className="pa3-icon-beam">
      <path d="M3 7h1a17 17 0 0 0 8-2 17 17 0 0 0 8 2h1" />
      <path d="m19 8 3 8a5 5 0 0 1-6 0zV7" />
      <path d="m5 8 3 8a5 5 0 0 1-6 0zV7" />
    </g>
  </IconV3>
);

/** Informática: lucide's "monitor"; live, two lines of code are typed with a blinking cursor. */
export const MonitorIconV3: ScheduleIconV3 = ({ live }) => (
  <IconV3 name="monitor" live={live}>
    <rect width="20" height="14" x="2" y="3" rx="2" />
    <line x1="8" x2="16" y1="21" y2="21" />
    <line x1="12" x2="12" y1="17" y2="21" />
    {live ? (
      <>
        <path className="pa3-icon-code" d="M6 8h8" strokeWidth="1.6" style={nth(0)} />
        <path className="pa3-icon-code" d="M6 11.5h5" strokeWidth="1.6" style={nth(1)} />
        <path className="pa3-icon-cursor" d="M13 10.5v2" strokeWidth="1.6" />
      </>
    ) : null}
  </IconV3>
);

/** Any other subject: lucide's "book-marked"; live, its ribbon dips. */
export const MarkedBookIconV3: ScheduleIconV3 = ({ live }) => (
  <IconV3 name="marked" live={live}>
    <path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H19a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H6.5a1 1 0 0 1 0-5H20" />
    <path className="pa3-icon-ribbon" d="M10 2v8l3-3 3 3V2" />
  </IconV3>
);

/**
 * The parada: lucide's "flag"; live, its cloth waves, its top, middle and bottom lines rising and
 * falling (owner request 27/10/2026). The waving is SMIL, which every phone plays (CSS cannot morph a
 * path on all of them), so it is left out with reduced motion.
 */
const FLAG_STILL =
  'M4 4a1 1 0 0 1 .4-.8A6 6 0 0 1 8 2c3 0 5 2 7.333 2q2 0 3.067-.8A1 1 0 0 1 20 4v10a1 1 0 0 1-.4.8A6 6 0 0 1 16 16c-3 0-5-2-8-2a6 6 0 0 0-4 1.528';
const FLAG_CLOTH = [
  'M4 4C7 2 10 6 13 4S18 2 20 4V14C17 16 14 12 11 14S6 16 4 14',
  'M4 4C7 6 10 2 13 4S18 6 20 4V14C17 12 14 16 11 14S6 12 4 14',
];
const FLAG_FOLD = ['M4 9C7 7 10 11 13 9S18 7 20 9', 'M4 9C7 11 10 7 13 9S18 11 20 9'];
function WaveV3({ shapes }: Readonly<{ shapes: readonly string[] }>) {
  return (
    <animate
      attributeName="d"
      dur="1.6s"
      repeatCount="indefinite"
      calcMode="spline"
      keyTimes="0;0.5;1"
      keySplines="0.45 0 0.55 1;0.45 0 0.55 1"
      values={`${shapes[0]};${shapes[1]};${shapes[0]}`}
    />
  );
}
export const FlagIconV3: ScheduleIconV3 = ({ live }) => {
  const waving = live && !reducedMotionV3();
  return (
    <IconV3 name="flag" live={live}>
      <path d="M4 22V4" />
      {waving ? (
        <>
          <path d={FLAG_CLOTH[0]}>
            <WaveV3 shapes={FLAG_CLOTH} />
          </path>
          <path d={FLAG_FOLD[0]} strokeWidth="1.5" opacity="0.75">
            <WaveV3 shapes={FLAG_FOLD} />
          </path>
        </>
      ) : (
        <path d={FLAG_STILL} />
      )}
    </IconV3>
  );
};

/**
 * The break: lucide's "coffee", its three wisps of steam drawn wavy (owner request 23/10/2026);
 * live, they drift up and fade one after the other.
 */
export const CoffeeIconV3: ScheduleIconV3 = ({ live }) => (
  <IconV3 name="coffee" live={live}>
    {['M6 5c-.6-.8.6-1.6 0-2.6', 'M10 5c-.6-.8.6-1.6 0-2.6', 'M14 5c-.6-.8.6-1.6 0-2.6'].map((d, index) => (
      <path key={d} className="pa3-icon-steam" d={d} style={nth(index)} />
    ))}
    <path d="M16 8a1 1 0 0 1 1 1v8a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V9a1 1 0 0 1 1-1h14a4 4 0 1 1 0 8h-1" />
  </IconV3>
);
