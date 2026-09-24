import { isCronCaller } from './cron-auth';

const SECRET = 'a-cron-secret-of-at-least-32-chars';

describe('isCronCaller', () => {
  it('accepts exactly the bearer token Vercel Cron sends', () => {
    expect(isCronCaller('Bearer ' + SECRET, SECRET)).toBe(true);
  });

  it.each([
    ['no header', undefined],
    ['a wrong secret', 'Bearer guess'],
    ['the secret without the Bearer prefix', SECRET],
  ])('refuses %s', (_label, header) => {
    expect(isCronCaller(header, SECRET)).toBe(false);
  });

  it('refuses everyone while no secret is configured', () => {
    expect(isCronCaller('Bearer undefined', undefined)).toBe(false);
  });
});
