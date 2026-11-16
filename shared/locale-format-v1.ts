import { SCHOOL_TIME_ZONE_V1 } from './school-time-zone-v1';

/**
 * pt-BR collators and formatters built once per load (issue #1490, finding 1). A call such as
 * `localeCompare(x, 'pt-BR', { numeric: true })` or `toLocaleString('pt-BR', { … })` builds a new
 * Intl object every time (~0.1 ms each); in a sort or a table that is up to 64× slower. Each constant
 * has exactly the options of the call it replaces, so the order and the text stay the same.
 * `@__PURE__` lets the bundler drop the ones a page does not use.
 *
 * Numeric order (1º, 2º, 10º) is `comparePtBrNumericLabelsV1` in gradebook-contracts/string-order-v1:
 * that file keeps its own collator and no imports, because the CI PostgreSQL gate loads it with
 * `node --experimental-strip-types`, which does not resolve imports without the `.ts` extension.
 */

/** Same order as `a.localeCompare(b, 'pt-BR')`. */
export const PT_BR_COLLATOR_V1 = /* @__PURE__ */ new Intl.Collator('pt-BR');

/** Same text as `n.toLocaleString('pt-BR', { maximumFractionDigits: 1 })`. */
export const PT_BR_UP_TO_1_DECIMAL_V1 = /* @__PURE__ */ new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 });
/** Same text as `n.toLocaleString('pt-BR', { maximumFractionDigits: 2 })`. */
export const PT_BR_UP_TO_2_DECIMALS_V1 = /* @__PURE__ */ new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 2 });
/** Same text as `n.toLocaleString('pt-BR', { maximumFractionDigits: 3 })`. */
export const PT_BR_UP_TO_3_DECIMALS_V1 = /* @__PURE__ */ new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 3 });

/**
 * With no date or time field, `toLocaleString` adds all six as 'numeric' (ECMA-402 ToDateTimeOptions
 * "any", "all"); a bare `Intl.DateTimeFormat` would show the date only.
 */
const SCHOOL_DATE_TIME_V1 = /* @__PURE__ */ new Intl.DateTimeFormat('pt-BR', {
  timeZone: SCHOOL_TIME_ZONE_V1,
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: 'numeric',
  second: 'numeric',
});
const SCHOOL_SHORT_DATE_TIME_V1 = /* @__PURE__ */ new Intl.DateTimeFormat('pt-BR', {
  dateStyle: 'short',
  timeStyle: 'short',
  timeZone: SCHOOL_TIME_ZONE_V1,
});
/** Device's time zone. Same text as `new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' }).format(date)`. */
export const PT_BR_LOCAL_SHORT_DATE_TIME_V1 = /* @__PURE__ */ new Intl.DateTimeFormat('pt-BR', {
  dateStyle: 'short',
  timeStyle: 'short',
});
const LOCAL_DAY_MONTH_TIME_V1 = /* @__PURE__ */ new Intl.DateTimeFormat('pt-BR', {
  day: '2-digit',
  month: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});

/** `toLocaleString` answers 'Invalid Date' for an invalid date where `format` would throw. */
function dateTextV1(format: Intl.DateTimeFormat, value: string | number | Date): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Invalid Date' : format.format(date);
}

/** Same text as `new Date(value).toLocaleString('pt-BR', { timeZone: SCHOOL_TIME_ZONE_V1 })`. */
export function schoolDateTimeTextV1(value: string | number | Date): string {
  return dateTextV1(SCHOOL_DATE_TIME_V1, value);
}

/** Same text as `new Date(value).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: SCHOOL_TIME_ZONE_V1 })`. */
export function schoolShortDateTimeTextV1(value: string | number | Date): string {
  return dateTextV1(SCHOOL_SHORT_DATE_TIME_V1, value);
}

/** Device's time zone. Same text as `new Date(value).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })`. */
export function localDayMonthTimeTextV1(value: string | number | Date): string {
  return dateTextV1(LOCAL_DAY_MONTH_TIME_V1, value);
}
