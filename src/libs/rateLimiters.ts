type RateLimitEntry = {
  count: number;
  timestamp: number;
};

const loginRateLimitStore = new Map<string, RateLimitEntry>();

const CLEANUP_INTERVAL = 5 * 60 * 1000; // Clean up every 5 minutes

// Login-specific rate limiting (stricter)
const LOGIN_RATE_LIMIT_DURATION = 60 * 1000; // 1 minute
const LOGIN_MAX_ATTEMPTS = 5; // Maximum 5 login attempts per minute
const LOGIN_LOCKOUT_DURATION = 15 * 60 * 1000; // 15 minute lockout after too many failures

// Cleanup function to prevent memory leaks
function cleanupExpiredEntries(): void {
  const now = Date.now();

  for (const [key, entry] of loginRateLimitStore.entries()) {
    if (now - entry.timestamp > LOGIN_LOCKOUT_DURATION) {
      loginRateLimitStore.delete(key);
    }
  }
}

// Set up periodic cleanup (only in server environment)
if (typeof window === 'undefined') {
  setInterval(cleanupExpiredEntries, CLEANUP_INTERVAL);
}

/**
 * Rate limiter specifically for login attempts
 * Returns { allowed: boolean, remainingAttempts: number, lockoutRemaining?: number }
 */
export function checkLoginRateLimit(identifier: string): {
  allowed: boolean;
  remainingAttempts: number;
  lockoutRemaining?: number;
} {
  const now = Date.now();
  const entry = loginRateLimitStore.get(identifier);

  // No previous attempts
  if (!entry) {
    loginRateLimitStore.set(identifier, { count: 1, timestamp: now });
    return { allowed: true, remainingAttempts: LOGIN_MAX_ATTEMPTS - 1 };
  }

  // Check if in lockout period (exceeded max attempts)
  if (entry.count >= LOGIN_MAX_ATTEMPTS) {
    const timeSinceLastAttempt = now - entry.timestamp;

    // Still in lockout
    if (timeSinceLastAttempt < LOGIN_LOCKOUT_DURATION) {
      const lockoutRemaining = Math.ceil(
        (LOGIN_LOCKOUT_DURATION - timeSinceLastAttempt) / 1000
      );
      return { allowed: false, remainingAttempts: 0, lockoutRemaining };
    }

    // Lockout expired, reset
    loginRateLimitStore.set(identifier, { count: 1, timestamp: now });
    return { allowed: true, remainingAttempts: LOGIN_MAX_ATTEMPTS - 1 };
  }

  // Within rate limit window
  if (now - entry.timestamp < LOGIN_RATE_LIMIT_DURATION) {
    entry.count += 1;
    entry.timestamp = now;

    if (entry.count >= LOGIN_MAX_ATTEMPTS) {
      return {
        allowed: false,
        remainingAttempts: 0,
        lockoutRemaining: LOGIN_LOCKOUT_DURATION / 1000,
      };
    }

    return {
      allowed: true,
      remainingAttempts: LOGIN_MAX_ATTEMPTS - entry.count,
    };
  }

  // Rate limit window expired, reset counter
  loginRateLimitStore.set(identifier, { count: 1, timestamp: now });
  return { allowed: true, remainingAttempts: LOGIN_MAX_ATTEMPTS - 1 };
}
