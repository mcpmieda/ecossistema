/*
 * Each choice on a screen (a period, a class, a perspective) is a step of the browser history, so
 * the phone's back button undoes the last choice instead of leaving the Centro (owner report of
 * 12/11/2026). The step keeps only the screen's own view, the same identifiers already kept in
 * session-view-v1, inside history.state; the address does not change.
 */
import { useEffect, useRef } from 'react';

const PREFIX_V1 = 'step-v1:';
/** Which step put the current entry there, so a screen only takes away an entry it added itself. */
const OWNER_V1 = 'step-v1#';
/** Changes this close to a load or to another change are one step (a choice that sets two things). */
const SETTLE_MS_V1 = 400;
const JOINED_MS_V1 = 150;
let lastStepAt = 0;
let lastPushId = 0;
/** The entry an open layer (window, side panel, option list) adds over the page. */
export const OVERLAY_ENTRY_V1 = '__centroOverlayV1';
/**
 * An entry a layer left behind when it was closed on the page (a list closed by picking an
 * option). It shows the same screen as the entry below it, so the next step takes its place
 * instead of stacking on top, and back is never pressed in vain.
 */
export const RELEASED_ENTRY_V1 = 'step-v1:released';

/**
 * Adds a step. A step never carries a layer's mark; it takes the place of a released entry, and
 * of the entry of a layer closing with this very choice (an option picked in a list), since React
 * records the choice before the layer is seen to close.
 */
export function pushStepV1(entry: Record<string, unknown>): void {
  const { [RELEASED_ENTRY_V1]: _released, [OVERLAY_ENTRY_V1]: _overlay, ...rest } = entry;
  const current = stateRecord();
  if (current[RELEASED_ENTRY_V1] === true || current[OVERLAY_ENTRY_V1] === true)
    window.history.replaceState(rest, '');
  else window.history.pushState(rest, '');
}

function stateRecord(): Record<string, unknown> {
  const state: unknown = window.history.state;
  return state !== null && typeof state === 'object' && !Array.isArray(state)
    ? (state as Record<string, unknown>)
    : {};
}

export function useHistoryStepV1<T>(
  key: string,
  value: T,
  /** Returns false when the screen refuses to go back (a draft would be lost). */
  apply: (value: T) => void | boolean,
  parse: (value: unknown) => T | null,
): () => void {
  const text = JSON.stringify(value);
  const shown = useRef<string | null>(null);
  const quietUntil = useRef(0);
  /** The view this screen's last step left, while that step is still the current entry. */
  const pushedFrom = useRef<string | null>(null);
  const pushedId = useRef(0);
  const applyRef = useRef(apply);
  const parseRef = useRef(parse);
  applyRef.current = apply;
  parseRef.current = parse;

  useEffect(() => {
    const field = PREFIX_V1 + key;
    const now = Date.now();
    if (shown.current === text) return;
    const previous = shown.current;
    const first = previous === null;
    shown.current = text;
    // Going straight back to what was shown before the last step (closing a record with its own
    // button) takes that step away, so back does not reopen what was just closed.
    if (
      !first &&
      text === pushedFrom.current &&
      stateRecord()[OWNER_V1] === pushedId.current &&
      stateRecord()[RELEASED_ENTRY_V1] !== true &&
      JSON.stringify(stateRecord()[field]) === previous
    ) {
      pushedFrom.current = null;
      window.history.back();
      return;
    }
    // An entry opened by an address (another area of the Centro) learns the view it starts with.
    if (!first && !(field in stateRecord()))
      window.history.replaceState({ ...stateRecord(), [field]: JSON.parse(previous) as unknown }, '');
    const entry = { ...stateRecord(), [field]: JSON.parse(text) as unknown };
    // The first value, a value restored by back or one that settles a choice: the same step.
    // One tap that changes two screens' views (a perspective and its filters) is still one step.
    if (first || now < quietUntil.current || now - lastStepAt < JOINED_MS_V1) {
      window.history.replaceState(entry, '');
      pushedFrom.current = null;
    } else {
      lastPushId += 1;
      pushStepV1({ ...entry, [OWNER_V1]: lastPushId });
      lastStepAt = now;
      pushedFrom.current = previous;
      pushedId.current = lastPushId;
    }
    quietUntil.current = first ? now + SETTLE_MS_V1 : Math.max(quietUntil.current, now + 80);
  }, [key, text]);

  useEffect(() => {
    const field = PREFIX_V1 + key;
    const onPopState = () => {
      const record = stateRecord();
      if (!(field in record)) return;
      const restored = parseRef.current(record[field]);
      if (restored === null) return;
      const restoredText = JSON.stringify(restored);
      if (restoredText === shown.current) return;
      if (applyRef.current(restored) === false) {
        // Refused: the screen stays, and so does its entry, so the next back is not one too far.
        lastPushId += 1;
        pushStepV1({
          ...record,
          [field]: JSON.parse(shown.current ?? 'null') as unknown,
          [OWNER_V1]: lastPushId,
        });
        return;
      }
      shown.current = restoredText;
      pushedFrom.current = null;
      quietUntil.current = Date.now() + SETTLE_MS_V1;
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [key]);

  /** The next change corrects the view on its own (a class that no longer exists): no new step. */
  return () => {
    quietUntil.current = Date.now() + SETTLE_MS_V1;
  };
}
