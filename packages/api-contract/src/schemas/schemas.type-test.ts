import type {
  BitmapProofResponse,
  BulletinProofResponse,
  BulletinResponse,
  ConsistencyProofResponse,
  FinalizationResponse,
  CurrentFinalizationResponse,
  ProgressResponse,
  SessionResponse,
  SthResponse,
  InputCommitmentResponse,
  VerificationRunResponse,
  VerificationObservationResponse,
  VerificationResourceResponse,
  VoteResponse,
} from './index';

type HasStringIndex<T> = string extends keyof T ? true : false;
type HasKey<T, K extends PropertyKey> = K extends keyof T ? true : false;
type ExpectFalse<Value extends false> = Value;

export type ConcreteResponseTypeAssertions = [
  ExpectFalse<HasStringIndex<SessionResponse>>,
  ExpectFalse<HasStringIndex<VoteResponse>>,
  ExpectFalse<HasStringIndex<ProgressResponse>>,
  ExpectFalse<HasStringIndex<FinalizationResponse>>,
  ExpectFalse<HasStringIndex<FinalizationResponse['data']>>,
  ExpectFalse<HasStringIndex<CurrentFinalizationResponse>>,
  ExpectFalse<HasStringIndex<NonNullable<CurrentFinalizationResponse['data']>>>,
  ExpectFalse<HasStringIndex<VerificationResourceResponse>>,
  ExpectFalse<HasStringIndex<VerificationResourceResponse['data']>>,
  ExpectFalse<HasStringIndex<VerificationRunResponse>>,
  ExpectFalse<HasStringIndex<VerificationObservationResponse>>,
  ExpectFalse<HasStringIndex<BulletinResponse>>,
  ExpectFalse<HasStringIndex<BulletinProofResponse>>,
  ExpectFalse<HasStringIndex<ConsistencyProofResponse>>,
  ExpectFalse<HasStringIndex<BitmapProofResponse>>,
  ExpectFalse<HasStringIndex<SthResponse>>,
  ExpectFalse<HasStringIndex<InputCommitmentResponse>>,
];

export type PublicResponseBoundaryKeyAssertions = [
  ExpectFalse<HasKey<VerificationResourceResponse['data'], 'electionManifest'>>,
  ExpectFalse<HasKey<VerificationResourceResponse['data'], 'closeStatement'>>,
  ExpectFalse<HasKey<VerificationResourceResponse['data'], 'bitmapProofSource'>>,
  ExpectFalse<HasKey<VerificationResourceResponse['data'], 'scenarios'>>,
  ExpectFalse<HasKey<VerificationResourceResponse['data'], 'verificationResult'>>,
  ExpectFalse<HasKey<FinalizationResponse['data'], 'electionManifest'>>,
  ExpectFalse<HasKey<FinalizationResponse['data'], 'closeStatement'>>,
  ExpectFalse<HasKey<FinalizationResponse['data'], 'bitmapProofSource'>>,
  ExpectFalse<HasKey<FinalizationResponse['data'], 'scenarios'>>,
  ExpectFalse<HasKey<FinalizationResponse['data'], 'verificationResult'>>,
];
