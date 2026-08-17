const BLURHASH_RE = /^[0-9A-Za-z#$%*+,\-.:;=?@[\]^_{|}~]{4,100}$/;

export const FALLBACK_BLURHASH = 'L6PZfSi_.AyE_3t7t7R**0o#DgR4';

export function isValidBlurhash(hash: unknown): hash is string {
  return typeof hash === 'string' && BLURHASH_RE.test(hash);
}
