// The UI tests (jsdom) and the ADM preview they reach are browser code type-checked with the
// server project: DOM comes from here (the Boletim PDF files that also gave it were removed).
/// <reference lib="dom" />
import { configure } from '@testing-library/react';
import { afterEach } from 'vitest';

// Portal areas, drawers and workspaces arrive as separate bundles since the code
// splitting of #1040, so a query often waits on a cold dynamic import rather than
// on a render. The 1s default expired before the chunk resolved whenever the
// runner was loaded, which surfaced as "Unable to find …" across six UI files and
// already failed one CI run of #1041. This widens only how long a query waits;
// what each query has to find is unchanged.
configure({ asyncUtilTimeout: 5_000 });

// Screens keep the operator's last view in the tab (src/shared/ui/session-view-v1.ts); one
// test must not open on what another one picked.
afterEach(() => {
  if (typeof window !== 'undefined') window.sessionStorage.clear();
});
