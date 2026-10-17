/**
 * Server-only abstraction for Markdown post bodies stored in the private
 * content bucket (Phase 6 foundation; NOT wired into any action yet).
 *
 * Bodies are content-addressed: the object key embeds the SHA-256 of the exact
 * final Markdown bytes, so identical content maps to one immutable object and
 * saving the same content twice is a no-op (`status: 'existing'`).
 *
 * It operates on the FINAL Markdown string the caller already produced — after
 * body-image upload/rewrite — and never rewrites images, URLs or whitespace.
 * The byte sequence is the identity: no trim, no newline fixups, no CRLF
 * normalization, no Unicode normalization.
 *
 * The Storage surface is injected (a bucket-scoped `storage.from(bucket)`), so
 * this module never constructs credentials and stays unit-testable. Nothing
 * here performs an environment lookup or provisions a bucket.
 */
import { createHash } from 'node:crypto';

export type BodyContentKind = 'blog' | 'portfolio';
export type BodyContentLocale = 'en' | 'it';

/** Bucket file_size_limit for `website-content-dev` (bytes). */
export const MAX_BODY_CONTENT_BYTES = 1_048_576;

/** Only MIME type the content bucket accepts. */
export const BODY_CONTENT_TYPE = 'text/markdown';

/** Immutable, SHA-addressed objects may be cached for a year. */
export const BODY_CONTENT_CACHE_CONTROL = '31536000';

export type PreparedBodyContent = {
  kind: BodyContentKind;
  postId: number;
  locale: BodyContentLocale;
  /** 64 lowercase hex characters — SHA-256 of the exact UTF-8 bytes. */
  hash: string;
  /** Canonical, content-addressed object key. */
  path: string;
  bytes: Buffer;
  size: number;
  contentType: typeof BODY_CONTENT_TYPE;
};

export type BodyContentUploadResult = {
  status: 'uploaded' | 'existing';
  path: string;
  hash: string;
  size: number;
};

/**
 * The bucket-scoped Storage operations this module needs. `supabase.storage.from(bucket)`
 * satisfies it structurally; tests pass a fake.
 */
export type BodyContentStorageApi = {
  upload(
    path: string,
    body: Buffer | Uint8Array,
    options: { contentType: string; upsert: boolean; cacheControl: string }
  ): Promise<{ data: unknown; error: unknown | null }>;
  download(
    path: string
  ): Promise<{ data: unknown | null; error: unknown | null }>;
  remove(paths: string[]): Promise<{ data: unknown; error: unknown | null }>;
};

/** 64 lowercase hex characters — SHA-256 of the given bytes. */
export function sha256Hex(bytes: Buffer | Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function isBodyContentKind(value: string): value is BodyContentKind {
  return value === 'blog' || value === 'portfolio';
}

function isBodyContentLocale(value: string): value is BodyContentLocale {
  return value === 'en' || value === 'it';
}

/**
 * Canonical immutable object key:
 *   <kind>/<postId>/<locale>/<sha256>.md
 * Mirrors the Phase 5A DB CHECK constraints by construction, so a stored pointer
 * can never disagree with this builder.
 */
export function bodyContentPath(
  kind: string,
  postId: number,
  locale: string,
  hash: string
): string {
  if (!isBodyContentKind(kind)) {
    throw new Error(`[body-content] invalid kind '${kind}' (expected blog|portfolio)`);
  }
  if (!isBodyContentLocale(locale)) {
    throw new Error(`[body-content] invalid locale '${locale}' (expected en|it)`);
  }
  if (!Number.isInteger(postId) || postId <= 0) {
    throw new Error(
      `[body-content] invalid postId '${postId}' (expected a positive integer)`
    );
  }
  if (!/^[0-9a-f]{64}$/.test(hash)) {
    throw new Error(
      `[body-content] invalid hash '${hash}' (expected 64 lowercase hex characters)`
    );
  }
  return `${kind}/${postId}/${locale}/${hash}.md`;
}

/**
 * Turns the final Markdown into a prepared object: exact UTF-8 bytes, their
 * SHA-256, and the canonical path. Size is validated here, before any caller can
 * reach the Storage API.
 */
export function prepareBodyContent(
  kind: string,
  postId: number,
  locale: string,
  markdown: string
): PreparedBodyContent {
  if (typeof markdown !== 'string') {
    throw new Error('[body-content] markdown must be a string');
  }
  if (!isBodyContentKind(kind)) {
    throw new Error(`[body-content] invalid kind '${kind}' (expected blog|portfolio)`);
  }
  if (!isBodyContentLocale(locale)) {
    throw new Error(`[body-content] invalid locale '${locale}' (expected en|it)`);
  }
  const bytes = Buffer.from(markdown, 'utf8');
  if (bytes.length > MAX_BODY_CONTENT_BYTES) {
    throw new Error(
      `[body-content] body is ${bytes.length} bytes, over the ${MAX_BODY_CONTENT_BYTES} byte limit`
    );
  }
  const hash = sha256Hex(bytes);
  return {
    kind,
    postId,
    locale,
    hash,
    path: bodyContentPath(kind, postId, locale, hash),
    bytes,
    size: bytes.length,
    contentType: BODY_CONTENT_TYPE,
  };
}

function messageOf(error: unknown): string {
  if (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof error.message === 'string'
  ) {
    return error.message;
  }
  return String(error);
}

/** Supabase reports an existing immutable key through several shapes. */
const ALREADY_EXISTS_CODES = [
  'ResourceAlreadyExists',
  'KeyAlreadyExists',
  'already_exists',
  'Duplicate',
  'Conflict',
];

/**
 * True only for an existing-resource conflict. A bare 400/409 with unrelated
 * semantics is NOT treated as already-existing; it propagates to the caller.
 */
export function isAlreadyExistsError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;

  const rawCode =
    'code' in error
      ? error.code
      : 'error' in error
        ? error.error
        : 'name' in error
          ? error.name
          : undefined;
  const code = typeof rawCode === 'string' ? rawCode : '';
  if (ALREADY_EXISTS_CODES.includes(code)) return true;

  const rawStatus =
    'statusCode' in error
      ? error.statusCode
      : 'status' in error
        ? error.status
        : undefined;
  const status =
    typeof rawStatus === 'number'
      ? rawStatus
      : typeof rawStatus === 'string'
        ? Number(rawStatus)
        : 0;
  const message =
    'message' in error && typeof error.message === 'string' ? error.message : '';

  return status === 409 && /already exists|duplicate/i.test(message);
}

/** Coerces a Storage download payload (bytes / ArrayBuffer / Blob) to bytes. */
async function payloadToBuffer(data: unknown): Promise<Buffer> {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof Uint8Array) return Buffer.from(data);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (data instanceof Blob) return Buffer.from(await data.arrayBuffer());
  throw new Error('[body-content] unsupported download payload type');
}

/** Exact bytes of a stored object. Throws on Storage error or empty payload. */
export async function readBodyContentBytes(
  storage: BodyContentStorageApi,
  path: string
): Promise<Buffer> {
  const res = await storage.download(path);
  if (res.error) {
    throw new Error(
      `[body-content] download ${path} failed: ${messageOf(res.error)}`
    );
  }
  if (res.data == null) {
    throw new Error(`[body-content] download ${path} returned no data`);
  }
  return payloadToBuffer(res.data);
}

/** Exact Markdown string for a stored object. No text normalization. */
export async function downloadBodyContent(
  storage: BodyContentStorageApi,
  path: string
): Promise<string> {
  return (await readBodyContentBytes(storage, path)).toString('utf8');
}

/**
 * Immutable upload. Never overwrites: `upsert: false` with a long cache
 * lifetime. When the content-addressed key already exists the stored object is
 * downloaded and compared byte-for-byte:
 *   - identical  -> { status: 'existing' }
 *   - different  -> integrity error (the object is never overwritten)
 */
export async function uploadBodyContent(
  storage: BodyContentStorageApi,
  prepared: PreparedBodyContent
): Promise<BodyContentUploadResult> {
  const res = await storage.upload(prepared.path, prepared.bytes, {
    contentType: BODY_CONTENT_TYPE,
    upsert: false,
    cacheControl: BODY_CONTENT_CACHE_CONTROL,
  });

  if (!res.error) {
    return {
      status: 'uploaded',
      path: prepared.path,
      hash: prepared.hash,
      size: prepared.size,
    };
  }

  if (!isAlreadyExistsError(res.error)) {
    throw new Error(
      `[body-content] upload ${prepared.path} failed: ${messageOf(res.error)}`
    );
  }

  const existing = await readBodyContentBytes(storage, prepared.path);
  if (!existing.equals(prepared.bytes)) {
    throw new Error(
      `[body-content] integrity failure at ${prepared.path}: stored ${existing.length} bytes differ from prepared ${prepared.size} bytes`
    );
  }
  return {
    status: 'existing',
    path: prepared.path,
    hash: prepared.hash,
    size: prepared.size,
  };
}

/**
 * Best-effort cleanup of a single body object, for a future pointer-switch hook.
 * Never throws: a cleanup failure after a committed DB write must not surface as
 * a failed save. Returns whether the removal reported success.
 */
export async function removeBodyContentBestEffort(
  storage: BodyContentStorageApi,
  path: string
): Promise<boolean> {
  try {
    const res = await storage.remove([path]);
    if (res.error) {
      console.error(
        `[body-content] cleanup of ${path} failed: ${messageOf(res.error)}`
      );
      return false;
    }
    return true;
  } catch (error) {
    console.error(`[body-content] cleanup of ${path} threw: ${messageOf(error)}`);
    return false;
  }
}
