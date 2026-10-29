declare const browserIdentityBrand: unique symbol;

type BrowserIdentityValue<Name extends string> = string & { readonly [browserIdentityBrand]: Name };

export type BrowserSessionIdentity = {
  readonly sessionId: BrowserIdentityValue<'sessionId'>;
  readonly capabilityToken: BrowserIdentityValue<'capabilityToken'>;
};

/** Attach distinct identity types after transport or storage admission. */
export function admitSessionIdentity(value: {
  readonly sessionId: string;
  readonly capabilityToken: string;
}): BrowserSessionIdentity {
  if (value.sessionId.length === 0 || value.capabilityToken.length === 0) {
    throw new Error('Session identity fields must not be empty');
  }
  return {
    sessionId: value.sessionId as BrowserSessionIdentity['sessionId'],
    capabilityToken: value.capabilityToken as BrowserSessionIdentity['capabilityToken'],
  };
}
