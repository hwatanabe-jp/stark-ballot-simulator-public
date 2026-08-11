export type BoundedRequestBodyResult =
  | {
      readonly ok: true;
      readonly bytes: Uint8Array;
    }
  | {
      readonly ok: false;
      readonly reason: 'too_large';
      readonly limitBytes: number;
      readonly receivedBytes: number;
    }
  | {
      readonly ok: false;
      readonly reason: 'read_failed';
      readonly cause: unknown;
    };

function parseContentLength(headers: Headers): number | null {
  const raw = headers.get('content-length');
  if (!raw) {
    return null;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return null;
  }
  return Math.floor(parsed);
}

function concatenateChunks(chunks: readonly Uint8Array[], totalBytes: number): Uint8Array {
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function readBoundedRequestBody(request: Request, limitBytes: number): Promise<BoundedRequestBodyResult> {
  const contentLength = parseContentLength(request.headers);
  if (contentLength !== null && contentLength > limitBytes) {
    return {
      ok: false,
      reason: 'too_large',
      limitBytes,
      receivedBytes: contentLength,
    };
  }

  if (!request.body) {
    return { ok: true, bytes: new Uint8Array() };
  }

  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = request.body.getReader();
  } catch (cause) {
    return { ok: false, reason: 'read_failed', cause };
  }

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    let result = await reader.read();
    while (!result.done) {
      const chunk = result.value;
      totalBytes += chunk.byteLength;
      if (totalBytes > limitBytes) {
        try {
          await reader.cancel();
        } catch {
          // The definitive size result takes precedence over cancellation failures.
        }
        return {
          ok: false,
          reason: 'too_large',
          limitBytes,
          receivedBytes: totalBytes,
        };
      }
      chunks.push(chunk);
      result = await reader.read();
    }
  } catch (cause) {
    return { ok: false, reason: 'read_failed', cause };
  }

  return {
    ok: true,
    bytes: concatenateChunks(chunks, totalBytes),
  };
}
