// @vitest-environment node
import { expect, it } from 'vitest';
import { shouldReloadFailedModuleV1 } from '../../../src/platform/gradebook-workspace-shell';

it('reloads a missing deployed module once and retains the fallback for repeated failure', () => {
  let state: unknown = { existing: 'preserved' };
  const navigation = {
    get state() {
      return state;
    },
    replaceState: (next: unknown) => {
      state = next;
    },
  };
  const missing = new TypeError(
    'Failed to fetch dynamically imported module: https://example.invalid/assets/settings-old.js',
  );
  expect(shouldReloadFailedModuleV1(missing, navigation, 1_000_000)).toBe(true);
  expect(state).toMatchObject({ existing: 'preserved' });
  expect(shouldReloadFailedModuleV1(missing, navigation, 1_000_001)).toBe(false);
  expect(
    shouldReloadFailedModuleV1(new Error('Unexpected render failure'), navigation, 1_000_002),
  ).toBe(false);
  expect(shouldReloadFailedModuleV1(missing, navigation, 1_061_000)).toBe(true);
});

it('keeps the isolated error when navigation state cannot be updated', () => {
  const navigation = {
    state: null,
    replaceState: (): void => {
      throw new Error('navigation unavailable');
    },
  };
  expect(
    shouldReloadFailedModuleV1(
      new TypeError('Importing a module script failed'),
      navigation,
      1_000_000,
    ),
  ).toBe(false);
});

it('recovers an equivalent module load error after navigating to another area', () => {
  let state: unknown = null;
  const navigation = {
    get state() {
      return state;
    },
    replaceState: (next: unknown) => {
      state = next;
    },
  };
  const missing = new TypeError('error loading dynamically imported module');
  expect(shouldReloadFailedModuleV1(missing, navigation, 1_000_000)).toBe(true);
  expect(shouldReloadFailedModuleV1(missing, navigation, 1_000_001)).toBe(false);
  state = null;
  expect(shouldReloadFailedModuleV1(missing, navigation, 1_000_002)).toBe(true);
});
