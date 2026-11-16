// @vitest-environment node
import { expect, it } from 'vitest';
import { buildPerformanceAnalyticsV6 } from '../../../server/gradebook/application/read-models/performance/performance-analytics-v6';
import {
  performanceAnalyticsMatchesV6,
  performanceAnalyticsRequestSchemaV6,
  performanceAnalyticsResponseSchemaV6,
} from '../../../shared/gradebook-contracts/performance/performance-analytics-v6';
import { learningFixtureV1 } from './learning-fixture-v1';

it('keeps older strict clients on the exact V6 response shape unless they opt in', () => {
  const { value, matrix, projections } = learningFixtureV1();
  const legacy = buildPerformanceAnalyticsV6(matrix, projections, false);
  expect(Object.hasOwn(legacy, 'learning')).toBe(false);
  const { learning, ...unchanged } = value;
  expect(learning).toBeDefined();
  expect(legacy).toEqual(unchanged);
  expect(performanceAnalyticsResponseSchemaV6.safeParse(legacy).success).toBe(true);
  const query = {
    transportVersion: 6,
    operation: 'analytics',
    year: 2026,
    classId: matrix.classGroup.id,
    period: 2,
  } as const;
  expect(performanceAnalyticsRequestSchemaV6.safeParse(query).success).toBe(true);
  expect(
    performanceAnalyticsRequestSchemaV6.safeParse({ ...query, includeLearning: true }).success,
  ).toBe(true);
  expect(
    performanceAnalyticsRequestSchemaV6.safeParse({ ...query, includeLearning: 'true' }).success,
  ).toBe(false);
  expect(performanceAnalyticsMatchesV6(query, legacy)).toBe(true);
  expect(performanceAnalyticsMatchesV6({ ...query, includeLearning: true }, legacy)).toBe(false);
  expect(performanceAnalyticsMatchesV6({ ...query, includeLearning: true }, value)).toBe(true);
});
