export function isBrowserTestMode(): boolean {
  return import.meta.env.MODE === 'test' || import.meta.env.MODE === 'local-mock';
}

export function shouldLogBrowserDevelopmentWarnings(): boolean {
  return !import.meta.env.PROD && !isBrowserTestMode();
}
