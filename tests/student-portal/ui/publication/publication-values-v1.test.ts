// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  publicationCommandV1,
  publicationObservationV1,
  publicationSnapshotV1,
  disclosureAtV1,
  publicationRestrictionV1,
} from '../../../../src/features/student-portal-admin/publication/publication-values-v1';
import { SYNTHETIC_ID_V1 } from '../../../../shared/student-portal-contracts/fixtures-v1';
import { settingsFixtureV1, SETTINGS_CLASS_V1, SETTINGS_SCHOOL_V1 } from '../settings/fixtures-v1';
import {
  PUBLICATION_META_V1,
  publicationFixtureV1,
  publicationResponseV1,
  PUBLICATION_ACCOUNT_V1,
} from './fixtures-v1';
describe('publication decisions use only server revisions', () => {
  it('distinguishes policy exclusion from the single-schedule subset without granting access', () => {
    const settings = settingsFixtureV1();
    settings.value.allowedPeriods = ['T1', 'T2'];
    settings.value.calendar.disclosure = { mode: 'single', at: null, periods: ['T1'] };
    expect(publicationRestrictionV1(settings, 'T3')).toBe('period-disabled');
    expect(publicationRestrictionV1(settings, 'T2')).toBe('outside-single-schedule');
    settings.value.accessEnabled = false;
    expect(publicationRestrictionV1(settings, 'T1')).toBeNull();
    settings.value.calendar.disclosure = {
      mode: 'per-period',
      at: { T1: null, T2: null, T3: null, REC1: null, REC2: null, REC3: null },
    };
    expect(publicationRestrictionV1(settings, 'T2')).toBeNull();
    expect(publicationRestrictionV1(settings, 'T3')).toBe('period-disabled');
  });
  it('preserves the selected period and exact source/CAS revision', () => {
    const item = publicationFixtureV1().items[1]!;
    expect(
      publicationCommandV1(SETTINGS_CLASS_V1, item, 'publish-update', SYNTHETIC_ID_V1),
    ).toEqual({
      contractVersion: 1,
      operation: 'publish-update',
      scope: SETTINGS_CLASS_V1,
      period: 'T2',
      expectedVersion: 9,
      targetDataVersion: 'synthetic:2026:revision:2',
      idempotencyKey: SYNTHETIC_ID_V1,
    });
    expect(
      publicationCommandV1(SETTINGS_CLASS_V1, item, 'unpublish', SYNTHETIC_ID_V1),
    ).not.toHaveProperty('targetDataVersion');
  });
  it('cannot approve no-data or update an unpublished period', () => {
    const items = publicationFixtureV1().items;
    expect(() =>
      publicationCommandV1(SETTINGS_CLASS_V1, items[2]!, 'publish', SYNTHETIC_ID_V1),
    ).toThrow();
    expect(() =>
      publicationCommandV1(SETTINGS_CLASS_V1, items[0]!, 'publish-update', SYNTHETIC_ID_V1),
    ).toThrow();
    expect(() =>
      publicationCommandV1(SETTINGS_CLASS_V1, items[0]!, 'unpublish', SYNTHETIC_ID_V1),
    ).toThrow();
  });
  it('rejects missing/duplicate periods, mixed CAS and a policy from another scope', () => {
    const fixture = publicationFixtureV1(),
      policy = { ...PUBLICATION_META_V1, state: 'settings' as const, settings: fixture.settings };
    for (const items of [
      fixture.items.slice(1),
      fixture.items.map((item, index) => (index === 1 ? fixture.items[0]! : item)),
      fixture.items.map((item, index) => ({ ...item, version: index === 1 ? 10 : 9 })),
    ])
      expect(() =>
        publicationSnapshotV1(
          SETTINGS_CLASS_V1,
          { ...PUBLICATION_META_V1, state: 'publication', items },
          policy,
        ),
      ).toThrow();
    expect(() =>
      publicationSnapshotV1(SETTINGS_CLASS_V1, publicationResponseV1(fixture), {
        ...policy,
        settings: settingsFixtureV1(SETTINGS_SCHOOL_V1),
      }),
    ).toThrow();
    expect(
      publicationSnapshotV1(SETTINGS_CLASS_V1, publicationResponseV1(fixture), policy),
    ).toEqual(fixture);
  });
  it('never treats an aggregated matching revision as every profile materialized', () => {
    const fixture = publicationFixtureV1(),
      command = publicationCommandV1(
        SETTINGS_CLASS_V1,
        fixture.items[0]!,
        'publish',
        SYNTHETIC_ID_V1,
      );
    expect(publicationObservationV1(SETTINGS_CLASS_V1, command, fixture.items)).toBe('waiting');
    fixture.items[0]!.publishedRevision = fixture.items[0]!.availableRevision;
    expect(publicationObservationV1(SETTINGS_CLASS_V1, command, fixture.items)).toBe('waiting');
    fixture.items[0]!.state = 'published';
    expect(publicationObservationV1(SETTINGS_CLASS_V1, command, fixture.items)).toBe('reported');
    expect(
      publicationObservationV1(
        PUBLICATION_ACCOUNT_V1,
        { ...command, scope: PUBLICATION_ACCOUNT_V1 },
        fixture.items,
      ),
    ).toBe('confirmed');
    fixture.items[0]!.publishedRevision = 'mixed:synthetic';
    expect(publicationObservationV1(SETTINGS_CLASS_V1, command, fixture.items)).toBe('waiting');
  });
  it('shows configured dates without deriving publication or final disclosure', () => {
    const settings = settingsFixtureV1();
    expect(disclosureAtV1(settings, 'T1')).toBeNull();
    settings.value.calendar.disclosure = {
      mode: 'single',
      at: '2026-12-01T11:00:00Z',
      periods: ['T2'],
    };
    expect(disclosureAtV1(settings, 'T1')).toBeNull();
    expect(disclosureAtV1(settings, 'T2')).toBe('2026-12-01T11:00:00Z');
    settings.value.calendar.disclosure = {
      mode: 'per-period',
      at: { T1: null, T2: null, T3: null, REC1: null, REC2: '2026-12-23T11:00:00Z', REC3: null },
    };
    expect(disclosureAtV1(settings, 'REC2')).toBe('2026-12-23T11:00:00Z');
    expect(settings.value.calendar.finalDisclosureAt).toBeNull();
  });
});
