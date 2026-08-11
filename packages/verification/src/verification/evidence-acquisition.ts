export type EvidenceAcquisition<T> =
  | {
      kind: 'admitted';
      value: T;
    }
  | {
      kind: 'unavailable' | 'malformed' | 'transport_failed';
      message?: string;
    };
