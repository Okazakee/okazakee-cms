export class TokenBucket {
  private tokens: number;
  private lastRefill: number;
  private maxTokens: number;
  private refillRate: number;

  constructor(maxTokens: number, refillRate: number) {
    this.tokens = maxTokens;
    this.lastRefill = Date.now();
    this.maxTokens = maxTokens;
    this.refillRate = refillRate;
  }

  private refill() {
    const now = Date.now();
    const timePassed = now - this.lastRefill;
    const refillAmount = timePassed * (this.refillRate / 1000);
    this.tokens = Math.min(this.maxTokens, this.tokens + refillAmount);
    this.lastRefill = now;
  }

  tryConsume(tokens = 1): boolean {
    this.refill();
    if (this.tokens >= tokens) {
      this.tokens -= tokens;
      return true;
    }
    return false;
  }
}
