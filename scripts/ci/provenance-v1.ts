import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const SHA_V1 = /^[0-9a-f]{40}$/u;
const REPOSITORY_V1 = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
export type CiWorkflowV1 = 'validate-pull-request' | 'student-portal-runtime-gates';
export type CiProvenanceV1 = {
  schema: 1;
  workflow: CiWorkflowV1;
  repository: string;
  event: 'pull_request';
  pullRequest: number;
  headSha: string;
  checkoutSha: string;
  treeSha: string;
  runId: number;
};

type EnvironmentV1 = Record<string, string | undefined>;
const integerV1 = (value: unknown, label: string) => {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`Invalid ${label}`);
  return parsed;
};
const shaV1 = (value: unknown, label: string) => {
  if (typeof value !== 'string' || !SHA_V1.test(value)) throw new Error(`Invalid ${label}`);
  return value;
};
const repositoryV1 = (value: unknown) => {
  if (typeof value !== 'string' || !REPOSITORY_V1.test(value)) throw new Error('Invalid repository');
  return value;
};
const workflowV1 = (value: unknown): CiWorkflowV1 => {
  if (value !== 'validate-pull-request' && value !== 'student-portal-runtime-gates')
    throw new Error('Invalid workflow');
  return value;
};
const requiredEnvironmentV1 = (environment: EnvironmentV1, key: string) => {
  const value = environment[key];
  if (!value) throw new Error(`Missing ${key}`);
  return value;
};
// The CI runner's own git; no user input reaches PATH.
const gitV1 = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8' }).trim(); // NOSONAR

export function parseCiProvenanceV1(input: unknown): CiProvenanceV1 {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid provenance');
  const value = input as Record<string, unknown>;
  if (value.schema !== 1 || value.event !== 'pull_request') throw new Error('Invalid provenance schema');
  const parsed: CiProvenanceV1 = {
    schema: 1,
    workflow: workflowV1(value.workflow),
    repository: repositoryV1(value.repository),
    event: 'pull_request',
    pullRequest: integerV1(value.pullRequest, 'pull request'),
    headSha: shaV1(value.headSha, 'head SHA'),
    checkoutSha: shaV1(value.checkoutSha, 'checkout SHA'),
    treeSha: shaV1(value.treeSha, 'tree SHA'),
    runId: integerV1(value.runId, 'run ID'),
  };
  if (Object.keys(value).sort((left, right) => left.localeCompare(right)).join(',') !== Object.keys(parsed).sort((left, right) => left.localeCompare(right)).join(','))
    throw new Error('Unexpected provenance fields');
  return parsed;
}

export async function writeCiProvenanceV1(
  workflow: CiWorkflowV1,
  output: string,
  environment: EnvironmentV1 = process.env,
): Promise<CiProvenanceV1> {
  if (environment.GITHUB_EVENT_NAME !== 'pull_request') throw new Error('Provenance requires pull_request');
  const proof = parseCiProvenanceV1({
    schema: 1,
    workflow,
    repository: requiredEnvironmentV1(environment, 'GITHUB_REPOSITORY'),
    event: 'pull_request',
    pullRequest: requiredEnvironmentV1(environment, 'PR_NUMBER'),
    headSha: requiredEnvironmentV1(environment, 'PR_HEAD_SHA'),
    checkoutSha: gitV1('rev-parse', 'HEAD'),
    treeSha: gitV1('rev-parse', 'HEAD^{tree}'),
    runId: requiredEnvironmentV1(environment, 'GITHUB_RUN_ID'),
  });
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(proof, null, 2)}\n`, 'utf8');
  return proof;
}

export function verifyProductionProvenanceV1(input: {
  repository: string;
  headSha: string;
  treeSha: string;
  validateRunId: number;
  runtimeRunId: number;
  validate: unknown;
  runtime: unknown;
}) {
  const expected = {
    repository: repositoryV1(input.repository),
    headSha: shaV1(input.headSha, 'expected head SHA'),
    treeSha: shaV1(input.treeSha, 'expected tree SHA'),
    validateRunId: integerV1(input.validateRunId, 'validate run ID'),
    runtimeRunId: integerV1(input.runtimeRunId, 'runtime run ID'),
  };
  const validate = parseCiProvenanceV1(input.validate);
  const runtime = parseCiProvenanceV1(input.runtime);
  if (validate.workflow !== 'validate-pull-request' || runtime.workflow !== 'student-portal-runtime-gates')
    throw new Error('Unexpected gate workflow');
  for (const proof of [validate, runtime]) {
    if (proof.repository !== expected.repository) throw new Error('Repository provenance mismatch');
    if (proof.headSha !== expected.headSha) throw new Error('PR head provenance mismatch');
    if (proof.treeSha !== expected.treeSha) throw new Error('Validated tree does not match production tree');
  }
  if (validate.pullRequest !== runtime.pullRequest) throw new Error('Gate pull request mismatch');
  if (validate.runId !== expected.validateRunId) throw new Error('Validate run provenance mismatch');
  if (runtime.runId !== expected.runtimeRunId) throw new Error('Runtime run provenance mismatch');
  return { pullRequest: validate.pullRequest, treeSha: expected.treeSha } as const;
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'write') {
    const workflow = workflowV1(args[0]);
    const output = args[1];
    if (!output || args.length !== 2) throw new Error('Usage: provenance-v1.ts write <workflow> <output>');
    const proof = await writeCiProvenanceV1(workflow, output);
    console.log(JSON.stringify({ event: 'ci-provenance-written-v1', workflow: proof.workflow, treeSha: proof.treeSha }));
    return;
  }
  if (command === 'verify') {
    const [validatePath, runtimePath] = args;
    if (!validatePath || !runtimePath || args.length !== 2)
      throw new Error('Usage: provenance-v1.ts verify <validate.json> <runtime.json>');
    const [validate, runtime] = await Promise.all([
      readFile(validatePath, 'utf8').then(JSON.parse),
      readFile(runtimePath, 'utf8').then(JSON.parse),
    ]);
    const result = verifyProductionProvenanceV1({
      repository: requiredEnvironmentV1(process.env, 'GITHUB_REPOSITORY'),
      headSha: requiredEnvironmentV1(process.env, 'PR_HEAD_SHA'),
      treeSha: requiredEnvironmentV1(process.env, 'FINAL_TREE_SHA'),
      validateRunId: integerV1(requiredEnvironmentV1(process.env, 'VALIDATE_RUN_ID'), 'validate run ID'),
      runtimeRunId: integerV1(requiredEnvironmentV1(process.env, 'RUNTIME_RUN_ID'), 'runtime run ID'),
      validate,
      runtime,
    });
    console.log(JSON.stringify({ event: 'production-provenance-verified-v1', ...result }));
    return;
  }
  throw new Error('Usage: provenance-v1.ts <write|verify> ...');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Provenance verification failed');
    process.exitCode = 1;
  }
}
