// @vitest-environment node
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ADMIN_OPERATION_ROUTES_V1,
  classifyAdminOperationV1,
} from '../server/http/admin-rate-limit-v1';
import { PUBLIC_DEMO_ADMIN_PATH_V1 } from '../shared/public-demo-control-v1';

/** API paths served outside the Centro's administrative quota, each with its own guard. */
const OUTSIDE_ADMIN_QUOTA_V1: readonly string[] = [
  '/api/health', // public liveness probe
  '/api/student/', // Portal do Aluno Worker: per-subject, per-account and global limits
  '/api/frequency-collector/', // device routes: collector_auth.pairing_rate_v1
  '/api/student-portal/admin/', // Portal ADM: quota at the private Worker boundary
  '/api/observability/frontend-diagnostic', // Portal do Aluno diagnostics beacon
];

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/u.test(name) ? [path] : [];
  });
}

function servedPaths(): Map<string, string> {
  const found = new Map<string, string>();
  for (const file of ['server', 'functions', 'shared'].flatMap((root) => sourceFiles(root))) {
    for (const match of readFileSync(file, 'utf8').matchAll(
      /['"`](\/api\/[A-Za-z0-9/_.:-]*)['"`]/gu,
    ))
      if (!match[1]!.endsWith('/')) found.set(match[1]!, file);
  }
  // Pages Functions also serve one path per file under functions/api.
  for (const file of sourceFiles(join('functions', 'api'))) {
    const path =
      '/' +
      relative('functions', file)
        .split(sep)
        .join('/')
        .replace(/\.tsx?$/u, '');
    if (!path.includes('[')) found.set(path, file);
  }
  return found;
}

describe('administrative operation quota coverage', () => {
  it('covers every API path the Centro serves, except the listed ones with their own guard', () => {
    const missing = [...servedPaths()]
      .filter(([path]) => !(path in ADMIN_OPERATION_ROUTES_V1))
      .filter(
        ([path]) =>
          !OUTSIDE_ADMIN_QUOTA_V1.some((outside) =>
            outside.endsWith('/') ? path.startsWith(outside) : path === outside,
          ),
      )
      .map(([path, file]) => `${path} (${file})`);
    expect(missing).toEqual([]);
  });

  it('counts reading the public demo state as a read and changing it as a write', () => {
    expect(classifyAdminOperationV1(PUBLIC_DEMO_ADMIN_PATH_V1, 'POST', {})).toBe('read');
    expect(classifyAdminOperationV1(PUBLIC_DEMO_ADMIN_PATH_V1, 'POST', { enabled: true })).toBe(
      'write',
    );
  });
});
