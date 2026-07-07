import assert from 'node:assert/strict';

import {
  resolveNodeConfiguredSthMinMatches,
  resolveNodeConfiguredSthSources,
} from '@stark-ballot/runtime-config/env/nodeSthPublicRuntimeConfig';

const trackedEnvKeys = [
  'VITE_STH_SOURCES',
  'VITE_STH_SOURCES',
  'VITE_STH_MIN_MATCHES',
  'VITE_STH_MIN_MATCHES',
] as const;

type TrackedEnvKey = (typeof trackedEnvKeys)[number];

const originalEnv = new Map<TrackedEnvKey, string | undefined>(trackedEnvKeys.map((key) => [key, process.env[key]]));

function clearTrackedEnv(): void {
  for (const key of trackedEnvKeys) {
    delete process.env[key];
  }
}

function restoreTrackedEnv(): void {
  for (const [key, value] of originalEnv.entries()) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

try {
  clearTrackedEnv();
  assert.deepEqual(resolveNodeConfiguredSthSources(), []);
  assert.equal(resolveNodeConfiguredSthMinMatches(), 2);

  process.env['VITE_STH_SOURCES'] = '/api/sth, https://auditor.example/sth';
  process.env['VITE_STH_MIN_MATCHES'] = '1';
  assert.deepEqual(resolveNodeConfiguredSthSources(), ['/api/sth', 'https://auditor.example/sth']);
  assert.equal(resolveNodeConfiguredSthMinMatches(), 1);

  delete process.env['VITE_STH_SOURCES'];
  delete process.env['VITE_STH_MIN_MATCHES'];
  process.env['VITE_STH_SOURCES'] = 'https://legacy-auditor.example/sth';
  process.env['VITE_STH_MIN_MATCHES'] = '3';
  assert.deepEqual(resolveNodeConfiguredSthSources(), ['https://legacy-auditor.example/sth']);
  assert.equal(resolveNodeConfiguredSthMinMatches(), 3);
} finally {
  restoreTrackedEnv();
}
