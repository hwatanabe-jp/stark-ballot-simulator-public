import type { FinalizationBitmapData, FinalizationResultAuthority } from './finalization-types';
import type { PersistedFinalizationResultAuthority } from './finalization-storage';
import type { SupportedPublicInputArtifact } from '@stark-ballot/verification/public-input';

declare function acceptBitmapData(value: FinalizationBitmapData): void;

acceptBitmapData({
  includedBitmap: [true],
  includedBitmapRoot: 'included-root',
  treeSize: 1,
  finalizedAtMs: 1,
});

declare const persistedBase: Omit<FinalizationResultAuthority, 'artifacts'>;
declare const publicInputArtifact: SupportedPublicInputArtifact;
declare const bitmapData: FinalizationBitmapData;
declare function acceptPersistedAuthority(value: PersistedFinalizationResultAuthority): void;

// @ts-expect-error Public audit storage fields are all-or-none.
acceptPersistedAuthority({ ...persistedBase, publicInputArtifact });

// @ts-expect-error Bitmap storage fields are all-or-none.
acceptPersistedAuthority({ ...persistedBase, bitmapProofSource: 'real' });

// @ts-expect-error Bitmap storage fields are all-or-none.
acceptPersistedAuthority({ ...persistedBase, bitmapData });

acceptBitmapData({
  includedBitmap: [true],
  includedBitmapRoot: 'included-root',
  seenBitmap: [true],
  seenBitmapRoot: 'seen-root',
  treeSize: 1,
  finalizedAtMs: 1,
});

// @ts-expect-error Seen bitmap evidence is an all-or-none pair.
acceptBitmapData({
  includedBitmap: [true],
  includedBitmapRoot: 'included-root',
  seenBitmap: [true],
  treeSize: 1,
  finalizedAtMs: 1,
});

// @ts-expect-error Seen bitmap evidence is an all-or-none pair.
acceptBitmapData({
  includedBitmap: [true],
  includedBitmapRoot: 'included-root',
  seenBitmapRoot: 'seen-root',
  treeSize: 1,
  finalizedAtMs: 1,
});
