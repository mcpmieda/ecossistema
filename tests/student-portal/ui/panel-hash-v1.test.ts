// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  claimPanelHashV1,
  panelHashAccountIdV1,
  readPanelFirstRowsV1,
  readPanelHashParamV1,
  writePanelFirstRowsV1,
  writePanelHashParamsV1,
} from '../../../src/features/student-portal-admin/shared/panel-hash-v1';

const account = '75600000-0000-4000-8000-000000009901';

describe('ADM view kept in the address (owner request 29/09/2026)', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    window.history.replaceState(null, '', '/#/painel-do-aluno?area=accounts');
  });

  it('keeps the area and sets or removes only the given keys, without a history entry', () => {
    const length = window.history.length;
    writePanelHashParamsV1({ turma: '756001', aluno: account });
    expect(window.location.hash).toBe(`#/painel-do-aluno?area=accounts&turma=756001&aluno=${account}`);
    expect(panelHashAccountIdV1('aluno')).toBe(account);
    writePanelHashParamsV1({ aluno: null });
    expect(readPanelHashParamV1('aluno')).toBeNull();
    expect(readPanelHashParamV1('area')).toBe('accounts');
    expect(window.history).toHaveLength(length);
  });

  it('accepts only account identifiers', () => {
    writePanelHashParamsV1({ aluno: 'nome do aluno' });
    expect(panelHashAccountIdV1('aluno')).toBeNull();
  });

  it('restores for the same administrator and starts clean for another one', () => {
    claimPanelHashV1('identity-a');
    writePanelHashParamsV1({ turma: '756001', aluno: account });
    claimPanelHashV1('identity-a');
    expect(readPanelHashParamV1('turma')).toBe('756001');
    claimPanelHashV1('identity-b');
    expect(readPanelHashParamV1('turma')).toBeNull();
    expect(readPanelHashParamV1('aluno')).toBeNull();
    expect(readPanelHashParamV1('area')).toBe('accounts');
    expect(window.sessionStorage.getItem('pa-panel-owner-v1')).not.toContain('identity');
  });
});

describe('first rows of a list kept for the tab', () => {
  const other = '75600000-0000-4000-8000-000000009902';
  beforeEach(() => window.sessionStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it('returns them to the administrator and view that left them, and to nobody else', () => {
    writePanelFirstRowsV1('identity-a|school', [account, other]);
    expect(readPanelFirstRowsV1('identity-a|school', 60)).toEqual([account, other]);
    expect(readPanelFirstRowsV1('identity-a|school', 1)).toEqual([account]);
    expect(readPanelFirstRowsV1('identity-a|class:756001', 60)).toEqual([]);
    expect(readPanelFirstRowsV1('identity-b|school', 60)).toEqual([]);
    // Only identifiers: neither the identity nor the view is kept as written.
    const kept = window.sessionStorage.getItem('pa-first-rows-v1')!;
    expect(kept).not.toContain('identity');
    expect(kept).not.toContain('school');
  });

  it('keeps only the latest view and accepts only account identifiers', () => {
    writePanelFirstRowsV1('identity-a|school', [account]);
    writePanelFirstRowsV1('identity-a|class:756001', [other]);
    expect(readPanelFirstRowsV1('identity-a|school', 60)).toEqual([]);
    expect(readPanelFirstRowsV1('identity-a|class:756001', 60)).toEqual([other]);
    writePanelFirstRowsV1('identity-a|school', ['nome do aluno', account, '', other.toUpperCase()]);
    expect(readPanelFirstRowsV1('identity-a|school', 60)).toEqual([account, other]);
  });

  it('ignores anything else found in the tab storage and a storage that refuses access', () => {
    for (const kept of ['{', 'null', '7', '[]', '{"view":"x"}', '{"view":"x","accountIds":"y"}']) {
      window.sessionStorage.setItem('pa-first-rows-v1', kept);
      expect(readPanelFirstRowsV1('identity-a|school', 60)).toEqual([]);
    }
    const refuse = () => {
      throw new DOMException('synthetic-refusal', 'SecurityError');
    };
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(refuse);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(refuse);
    expect(readPanelFirstRowsV1('identity-a|school', 60)).toEqual([]);
    expect(() => writePanelFirstRowsV1('identity-a|school', [account])).not.toThrow();
  });
});
