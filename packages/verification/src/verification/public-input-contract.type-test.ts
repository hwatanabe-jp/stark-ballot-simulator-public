import {
  parseSupportedPublicInputArtifact,
  type PublicInputArtifactSource,
  type SupportedPublicInputArtifact,
} from './public-input-contract';

declare const artifact: SupportedPublicInputArtifact;
const source: PublicInputArtifactSource = artifact.provenance.source;
void source;

// @ts-expect-error Supported public-input authority always carries its source.
const missingSource: SupportedPublicInputArtifact['provenance'] = { finalizationId: 'finalization-1' };
void missingSource;

declare const raw: unknown;
// @ts-expect-error Admitting an external supported artifact requires explicit provenance.
parseSupportedPublicInputArtifact(raw);
// @ts-expect-error Partial provenance is insufficient for supported artifact admission.
parseSupportedPublicInputArtifact(raw, { finalizationId: 'finalization-1' });
