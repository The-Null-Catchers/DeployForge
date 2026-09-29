import { HttpException, Injectable } from '@nestjs/common';
import { RedisService } from './redis.service';

/** Fixed-window rate limiter backed by Redis. */
@Injectable()
export class RateLimitService {
  constructor(private readonly redis: RedisService) {}

  async hit(key: string, limit: number, windowSeconds: number): Promise<{ allowed: boolean; retryAfter: number }> {
    const k = `df:rl:${key}`;
    const n = await this.redis.client.incr(k);
    if (n === 1) await this.redis.client.expire(k, windowSeconds);
    if (n > limit) {
      const ttl = await this.redis.client.ttl(k);
      return { allowed: false, retryAfter: ttl > 0 ? ttl : windowSeconds };
    }
    return { allowed: true, retryAfter: 0 };
  }

  async enforce(key: string, limit: number, windowSeconds: number): Promise<void> {
    const r = await this.hit(key, limit, windowSeconds);
    if (!r.allowed) {
      throw new HttpException(
        { statusCode: 429, error: 'Too Many Requests', code: 'rate_limited', message: `Too many attempts. Try again in ${r.retryAfter} seconds.`, retryAfter: r.retryAfter },
        429,
      );
    }
  }

  async reset(key: string): Promise<void> {
    await this.redis.client.del(`df:rl:${key}`);
  }
}
