import { routeMockRequest } from './router';

export const mockApiFetch = (input: RequestInfo | URL, init?: RequestInit): Response => routeMockRequest(input, init);

export const handleLocalApiRequest = mockApiFetch;
