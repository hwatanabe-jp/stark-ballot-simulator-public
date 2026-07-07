export const handleLocalApiRequest = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
  fetch(input, init);
