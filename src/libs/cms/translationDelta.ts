/**
 * Prototype-safe translation delta merging (client-safe: no server imports).
 *
 * i18n translations are stored as a nested JSON object per locale. A concurrent
 * edit to an unrelated key must not be clobbered, so the CMS writes a DELTA and
 * merges it server-side instead of replacing the whole object. These helpers
 * are the single merge/compare implementation used by the CAS retry loop.
 *
 * Rules:
 * - plain objects merge recursively;
 * - arrays merge BY INDEX (index i of the incoming delta patches index i of the
 *   base; a missing base array is created);
 * - an object whose own keys are ALL numeric indices is treated as a sparse
 *   array map and merged per index;
 * - any other value (scalar/null) replaces the base value;
 * - the keys `__proto__`, `constructor` and `prototype` are dropped at every
 *   depth so an incoming delta can never mutate a prototype.
 */
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

type JsonObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIndexKey(key: string): boolean {
  return /^(0|[1-9]\d*)$/.test(key);
}

function cloneBaseObject(base: unknown): JsonObject {
  const result: JsonObject = {};
  if (isPlainObject(base)) {
    for (const key of Object.keys(base)) {
      if (FORBIDDEN_KEYS.has(key)) continue;
      result[key] = base[key];
    }
  }
  return result;
}

/**
 * Deep-merges `delta` into `base` without mutating either argument. Returns a
 * new value. Never lets a forbidden key through at any depth.
 */
export function mergeTranslationDelta(base: unknown, delta: unknown): unknown {
  if (Array.isArray(delta)) {
    const result: unknown[] = Array.isArray(base) ? [...base] : [];
    for (let i = 0; i < delta.length; i += 1) {
      if (Object.hasOwn(delta, i)) {
        result[i] = mergeTranslationDelta(result[i], delta[i]);
      }
    }
    return result;
  }

  if (isPlainObject(delta)) {
    const keys = Object.keys(delta).filter((key) => !FORBIDDEN_KEYS.has(key));

    const isSparseArrayMap =
      keys.length > 0 && keys.every((key) => isIndexKey(key));

    if (isSparseArrayMap) {
      const result: unknown[] = Array.isArray(base) ? [...base] : [];
      for (const key of keys) {
        const index = Number(key);
        result[index] = mergeTranslationDelta(result[index], delta[key]);
      }
      return result;
    }

    const result = cloneBaseObject(base);
    for (const key of keys) {
      result[key] = mergeTranslationDelta(result[key], delta[key]);
    }
    return result;
  }

  return delta;
}

/**
 * Computes the minimal delta needed to turn `previous` into `next`:
 * - unchanged primitives yield `undefined` (omitted by callers);
 * - arrays are emitted whole (index merge handles partial application);
 * - removed object keys are emitted as `null` so the merge clears them.
 *
 * The result is JSON-serializable and may be passed straight to
 * `mergeTranslationDelta`.
 */
export function computeTranslationDelta(
  previous: unknown,
  next: unknown
): unknown {
  if (isPlainObject(previous) && isPlainObject(next)) {
    const result: JsonObject = {};
    for (const key of Object.keys(next)) {
      if (FORBIDDEN_KEYS.has(key)) continue;
      const delta = computeTranslationDelta(previous[key], next[key]);
      if (delta !== undefined) result[key] = delta;
    }
    // Keys present before but absent now are explicit removals.
    for (const key of Object.keys(previous)) {
      if (FORBIDDEN_KEYS.has(key)) continue;
      if (!Object.hasOwn(next, key)) result[key] = null;
    }
    return result;
  }

  if (Array.isArray(previous) && Array.isArray(next)) {
    return shallowEqual(previous, next) ? undefined : next;
  }

  return shallowEqual(previous, next) ? undefined : next;
}

function shallowEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return (
      a.length === b.length && a.every((value, index) => value === b[index])
    );
  }
  return false;
}

/** True when a delta would change nothing (empty object / undefined). */
export function isEmptyDelta(delta: unknown): boolean {
  if (delta === undefined) return true;
  if (isPlainObject(delta)) return Object.keys(delta).length === 0;
  return false;
}
