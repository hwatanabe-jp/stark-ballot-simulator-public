import { describe, expect, it, vi } from 'vitest';
import { readBoundedRequestBody } from './boundedRequestBody';

type HeadersInput = NonNullable<ConstructorParameters<typeof Headers>[0]>;
type RequestBody = NonNullable<RequestInit['body']>;

function requestWithBody(body: RequestBody, headers?: HeadersInput): Request {
  return new Request('http://localhost/test', {
    method: 'POST',
    body,
    headers,
    duplex: 'half',
  } as RequestInit & { duplex: 'half' });
}

function requestWithStream(stream: ReadableStream<Uint8Array>, headers?: HeadersInput): Request {
  return requestWithBody(stream, headers);
}

describe('readBoundedRequestBody', () => {
  it('accepts a body at the exact byte limit', async () => {
    const body = Uint8Array.from([1, 2, 3, 4]);

    await expect(readBoundedRequestBody(requestWithBody(body), body.byteLength)).resolves.toEqual({
      ok: true,
      bytes: body,
    });
  });

  it('rejects a streamed body one byte over the limit', async () => {
    const body = Uint8Array.from([1, 2, 3, 4, 5]);

    await expect(readBoundedRequestBody(requestWithBody(body), body.byteLength - 1)).resolves.toEqual({
      ok: false,
      reason: 'too_large',
      limitBytes: body.byteLength - 1,
      receivedBytes: body.byteLength,
    });
  });

  it('rejects an oversized Content-Length before pulling the body', async () => {
    const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
      controller.enqueue(Uint8Array.from([1]));
      controller.close();
    });
    const request = requestWithStream(new ReadableStream<Uint8Array>({ pull }, { highWaterMark: 0 }), {
      'Content-Length': '6',
    });

    await expect(readBoundedRequestBody(request, 5)).resolves.toEqual({
      ok: false,
      reason: 'too_large',
      limitBytes: 5,
      receivedBytes: 6,
    });
    expect(pull).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', undefined],
    ['invalid', 'not-a-number'],
  ])('streams a body with %s Content-Length', async (_label, contentLength) => {
    const body = Uint8Array.from([1, 2, 3]);
    const request = requestWithBody(body, contentLength ? { 'Content-Length': contentLength } : undefined);

    await expect(readBoundedRequestBody(request, body.byteLength)).resolves.toEqual({
      ok: true,
      bytes: body,
    });
  });

  it.each([
    ['negative', '-1'],
    ['positive infinity', 'Infinity'],
    ['not-a-number', 'NaN'],
  ])('treats a %s Content-Length as untrusted and streams the body', async (_label, contentLength) => {
    const body = Uint8Array.from([1]);
    const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
      controller.enqueue(body);
      controller.close();
    });
    const request = requestWithStream(new ReadableStream<Uint8Array>({ pull }, { highWaterMark: 0 }), {
      'Content-Length': contentLength,
    });

    await expect(readBoundedRequestBody(request, body.byteLength)).resolves.toEqual({
      ok: true,
      bytes: body,
    });
    expect(pull).toHaveBeenCalled();
  });

  it.each([
    ['fractional value is floored', '5.9', 5, 4],
    ['exponent notation is numeric', '1e2', 100, 99],
    ['hexadecimal notation is numeric', '0x10', 16, 15],
  ])('preserves current Content-Length parsing when %s', async (_label, contentLength, receivedBytes, limitBytes) => {
    const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
      controller.enqueue(Uint8Array.from([1]));
      controller.close();
    });
    const request = requestWithStream(new ReadableStream<Uint8Array>({ pull }, { highWaterMark: 0 }), {
      'Content-Length': contentLength,
    });

    await expect(readBoundedRequestBody(request, limitBytes)).resolves.toEqual({
      ok: false,
      reason: 'too_large',
      limitBytes,
      receivedBytes,
    });
    expect(pull).not.toHaveBeenCalled();
  });

  it('enforces the streamed byte limit when Content-Length is underreported', async () => {
    const body = Uint8Array.from([1, 2, 3, 4]);
    const request = requestWithBody(body, { 'Content-Length': '1' });

    await expect(readBoundedRequestBody(request, body.byteLength - 1)).resolves.toEqual({
      ok: false,
      reason: 'too_large',
      limitBytes: body.byteLength - 1,
      receivedBytes: body.byteLength,
    });
  });

  it('returns exact multibyte UTF-8 bytes split across chunks', async () => {
    const body = new TextEncoder().encode('票𠀀');
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(body.subarray(0, 2));
        controller.enqueue(body.subarray(2, 5));
        controller.enqueue(body.subarray(5));
        controller.close();
      },
    });

    await expect(readBoundedRequestBody(requestWithStream(stream), body.byteLength)).resolves.toEqual({
      ok: true,
      bytes: body,
    });
  });

  it('reports a stream read failure', async () => {
    const cause = new Error('body stream failed');
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(cause);
      },
    });

    await expect(readBoundedRequestBody(requestWithStream(stream), 16)).resolves.toEqual({
      ok: false,
      reason: 'read_failed',
      cause,
    });
  });

  it('cancels the stream after crossing the byte limit', async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(Uint8Array.from([1, 2, 3]));
      },
      cancel,
    });

    await expect(readBoundedRequestBody(requestWithStream(stream), 2)).resolves.toEqual({
      ok: false,
      reason: 'too_large',
      limitBytes: 2,
      receivedBytes: 3,
    });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('keeps the too-large result when stream cancellation fails', async () => {
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(Uint8Array.from([1, 2, 3]));
      },
      cancel() {
        throw new Error('cancel failed');
      },
    });

    await expect(readBoundedRequestBody(requestWithStream(stream), 2)).resolves.toEqual({
      ok: false,
      reason: 'too_large',
      limitBytes: 2,
      receivedBytes: 3,
    });
  });

  it('returns empty bytes when the request has no body', async () => {
    const request = new Request('http://localhost/test', { method: 'POST' });

    await expect(readBoundedRequestBody(request, 1)).resolves.toEqual({
      ok: true,
      bytes: new Uint8Array(),
    });
  });
});
