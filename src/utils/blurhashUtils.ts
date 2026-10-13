/**
 * Canonical image-placeholder contract (CMS + public site).
 *
 * `blurhashURL` columns and `![caption-placeholder](url)` bodies hold a
 * ready-to-use Next.js `blurDataURL`: `data:image/...;base64,...` as
 * returned by `blurkit.encode(...).dataURL`. The column name is legacy;
 * its semantics are a data URL, never a raw BlurHash string.
 *
 * Anything else (raw BlurHash, empty, malformed) means "no placeholder":
 * renderers must use `placeholder="empty"` and omit `blurDataURL`.
 * Raw hashes are legacy data: they still render the full image, just
 * without the blur-up. No runtime BlurHash decoding happens on the site.
 */
const BLURHASH_RE = /^[0-9A-Za-z#$%*+,\-.:;=?@[\]^_{|}~]{4,100}$/;

const BLUR_DATA_URL_RE =
  /^data:image\/(png|jpeg|jpg|webp);base64,[A-Za-z0-9+/=]+$/;

export const FALLBACK_BLURHASH = 'L6PZfSi_.AyE_3t7t7R**0o#DgR4';

/** Deliberate fallback when placeholder generation fails. */
export const FALLBACK_BLUR_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

export function isValidBlurhash(hash: unknown): hash is string {
  return typeof hash === 'string' && BLURHASH_RE.test(hash);
}

export function isValidBlurPlaceholder(value: unknown): value is string {
  return typeof value === 'string' && BLUR_DATA_URL_RE.test(value);
}

/** Valid data URL or undefined: never pass a raw hash to `blurDataURL`. */
export function resolveBlurDataURL(
  value: string | null | undefined
): string | undefined {
  return isValidBlurPlaceholder(value) ? value : undefined;
}

/** `blur` only for a valid data URL, otherwise `empty`. */
export function resolveBlurPlaceholder(
  value: string | null | undefined
): 'blur' | 'empty' {
  return isValidBlurPlaceholder(value) ? 'blur' : 'empty';
}
