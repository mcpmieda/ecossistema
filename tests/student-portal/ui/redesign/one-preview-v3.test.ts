import { readdirSync, readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

// Owner request 01/11/2026: one Portal preview, always up to date. Every page the signed-in portal
// can show must also be in the preview, with its invented client and its "Simular admin" key.
const shell = readFileSync('src/features/student-portal/shell/student-shell-v1.tsx', 'utf8');
const preview = readFileSync('src/student-portal/portal-demo-app-v1.tsx', 'utf8');

it('the preview has every page of the signed-in portal', () => {
  const keys = [...shell.matchAll(/data\.(show[A-Z]\w+) === true/gu)].map((match) => match[1]!);
  const clients = [...shell.matchAll(/^\s*(\w+Client)\?:/gmu)].map((match) => match[1]!);
  expect(keys.length).toBeGreaterThan(0);
  expect(clients.length).toBeGreaterThan(0);
  expect(keys.filter((key) => !preview.includes(`${key}: admin.${key}`) || !preview.includes(`toggle('${key}')`))).toEqual([]);
  expect(clients.filter((client) => !preview.includes(`${client}={`))).toEqual([]);
});

it('there is only one Portal preview', () => {
  expect(readdirSync('src/student-portal').filter((file) => file.endsWith('.html')).sort()).toEqual([
    'index.html',
    'login-preview.html',
    'ui-preview.html',
  ]);
});
