export const STARK_TIMEOUT_ERROR = 'stark_timeout';

export const isStarkTimeoutError = (error?: string): boolean => {
  if (!error) {
    return false;
  }
  if (error === STARK_TIMEOUT_ERROR) {
    return true;
  }
  return /timeout|delayed/i.test(error);
};
