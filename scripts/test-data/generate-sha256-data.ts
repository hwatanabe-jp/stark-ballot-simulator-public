#!/usr/bin/env tsx

const message = [
  'scripts/test-data/generate-sha256-data.ts is no longer supported.',
  '',
  'WS2 removed the legacy fixed-depth SHA-256 session-tree fixture path.',
  'Use one of the maintained entrypoints instead:',
  '  pnpm tsx scripts/tests/generate-zkvm-fixtures.ts',
  '  ./scripts/stark-proofs/test-single.sh',
  '  ./scripts/stark-proofs/generate-all.sh',
  '  pnpm test:cli -- --user-choice A --real-zkvm --zkvm-mode prod --scenario S0',
];

console.error(message.join('\n'));
process.exit(1);
