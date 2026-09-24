import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Whether a request is Vercel Cron: it sends CRON_SECRET as a bearer token.
 * Constant-time and length-blind (both sides hashed first); with no secret
 * configured nobody passes.
 */
export function isCronCaller(authorization: string | undefined, secret: string | undefined): boolean {
  if (!authorization || !secret) return false;
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(authorization), digest('Bearer ' + secret));
}
