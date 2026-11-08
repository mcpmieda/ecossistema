// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  isRelationalInstrumentActiveV9,
  isRelationalInstrumentMeaningfulV9,
  parseRelationalInstrumentKeyV9,
  resolveRelationalInstrumentMetadataV9,
  resolveRelationalNoteMutationV9,
  shouldRetireQualitativeInstrumentV9,
} from '../../../server/gradebook/application/import/import-relational-instrument-decisions-v9';

describe('relational instrument decisions V9', () => {
  it('parses persisted instrument keys and fails closed for malformed state', () => {
    expect(parseRelationalInstrumentKeyV9('2:11')).toEqual({ term: 2, slot: 11 });
    expect(() => parseRelationalInstrumentKeyV9('2:x')).toThrow('invalid-existing-instrument-key');
  });

  it('retires only missing qualitative slots from an authoritative snapshot', () => {
    const input = {
      currentTerm: 1,
      incomingTerm: 1,
      incomingSlots: new Set([1, 2, 3] as const),
      unavailableMaximum: new Set<11 | 12>(),
      unavailableDescription: new Set<11 | 12>(),
      unavailableValues: new Set<11 | 12>(),
    };
    expect(shouldRetireQualitativeInstrumentV9({ ...input, currentSlot: 11 })).toBe(true);
    expect(shouldRetireQualitativeInstrumentV9({
      ...input,
      currentSlot: 11,
      unavailableMaximum: new Set([11] as const),
    })).toBe(false);
    expect(shouldRetireQualitativeInstrumentV9({ ...input, currentSlot: 3 })).toBe(false);
    expect(shouldRetireQualitativeInstrumentV9({
      ...input,
      currentSlot: 11,
      currentTerm: 2,
    })).toBe(false);
  });

  it('preserves unavailable metadata and clears what the snapshot dropped', () => {
    const current = { maximo: 5000, descricao: 'Atividade' };
    expect(resolveRelationalInstrumentMetadataV9({
      current,
      sourceMaximum: null,
      sourceDescription: undefined,
      maximumUnavailable: true,
      descriptionUnavailable: true,
    })).toEqual(current);

    expect(resolveRelationalInstrumentMetadataV9({
      current,
      sourceMaximum: null,
      sourceDescription: undefined,
      maximumUnavailable: false,
      descriptionUnavailable: false,
    })).toEqual({ maximo: null, descricao: null });
  });

  it('keeps slot 3 meaningful for observed-blank transport and ignores unused numeric placeholders', () => {
    expect(isRelationalInstrumentMeaningfulV9({
      sourceMaximum: null,
      sourceDescription: undefined,
      hasValue: false,
      exists: false,
      slot: 3,
    })).toBe(true);

    expect(isRelationalInstrumentActiveV9({
      slot: 11,
      metadata: { maximo: null, descricao: '1' },
      hasValue: false,
      observed: false,
    })).toBe(false);

    expect(isRelationalInstrumentActiveV9({
      slot: 11,
      metadata: { maximo: null, descricao: 'Produção textual' },
      hasValue: false,
      observed: false,
    })).toBe(true);
  });

  it('resolves note mutation without collapsing unavailable, blank and observed blank', () => {
    expect(resolveRelationalNoteMutationV9({
      target: ['u'],
      previous: 4000,
      observed: true,
      retainBlank: true,
    })).toEqual({ kind: 'preserve' });

    expect(resolveRelationalNoteMutationV9({
      target: null,
      previous: null,
      observed: false,
      retainBlank: true,
    })).toEqual({ kind: 'insert', value: null });

    expect(resolveRelationalNoteMutationV9({
      target: null,
      previous: null,
      observed: true,
      retainBlank: false,
    })).toEqual({ kind: 'delete' });

    expect(resolveRelationalNoteMutationV9({
      target: 0,
      previous: null,
      observed: false,
      retainBlank: false,
    })).toEqual({ kind: 'insert', value: 0 });

    expect(resolveRelationalNoteMutationV9({
      target: 9000,
      previous: 8000,
      observed: true,
      retainBlank: true,
    })).toEqual({ kind: 'update', value: 9000 });
  });
});
