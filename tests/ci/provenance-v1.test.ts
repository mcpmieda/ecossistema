// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  parseCiProvenanceV1,
  verifyProductionProvenanceV1,
  type CiProvenanceV1,
} from '../../scripts/ci/provenance-v1.ts';

const sha = (value: string) => value.repeat(40).slice(0, 40);
const repository = 'synthetic/example';
const headSha = sha('a');
const treeSha = sha('b');
const checkoutSha = sha('c');
const proof = (workflow: CiProvenanceV1['workflow'], runId: number): CiProvenanceV1 => ({
  schema: 1,
  workflow,
  repository,
  event: 'pull_request',
  pullRequest: 829,
  headSha,
  checkoutSha,
  treeSha,
  runId,
});
const input = () => ({
  repository,
  headSha,
  treeSha,
  validateRunId: 101,
  runtimeRunId: 202,
  validate: proof('validate-pull-request', 101),
  runtime: proof('student-portal-runtime-gates', 202),
});

describe('production provenance v1', () => {
  it('accepts two successful gate proofs only for the exact production tree', () => {
    expect(verifyProductionProvenanceV1(input())).toEqual({ pullRequest: 829, treeSha });
  });

  it.each([
    ['head', () => ({ ...input(), headSha: sha('d') })],
    ['tree', () => ({ ...input(), treeSha: sha('d') })],
    ['validate run', () => ({ ...input(), validateRunId: 999 })],
    ['runtime run', () => ({ ...input(), runtimeRunId: 999 })],
    [
      'pull request',
      () => ({
        ...input(),
        runtime: { ...proof('student-portal-runtime-gates', 202), pullRequest: 830 },
      }),
    ],
  ])('fails closed on a %s mismatch', (_label, make) => {
    expect(() => verifyProductionProvenanceV1(make())).toThrow();
  });

  it('rejects swapped workflows and unexpected fields', () => {
    const swapped = input();
    swapped.validate = proof('student-portal-runtime-gates', 101);
    expect(() => verifyProductionProvenanceV1(swapped)).toThrow('Unexpected gate workflow');
    expect(() =>
      parseCiProvenanceV1({ ...proof('validate-pull-request', 101), extra: true }),
    ).toThrow('Unexpected provenance fields');
  });

  it.each([
    null,
    {},
    { ...proof('validate-pull-request', 101), schema: 2 },
    { ...proof('validate-pull-request', 101), treeSha: 'not-a-sha' },
    { ...proof('validate-pull-request', 101), runId: 0 },
  ])('rejects malformed provenance %#', (value) => {
    expect(() => parseCiProvenanceV1(value)).toThrow();
  });
});
