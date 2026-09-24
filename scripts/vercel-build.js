// The Vercel build (see vercel.json).
//
// 1. The Prisma client, for this machine's engine.
// 2. Migrations on production deploys only — a preview must never change the
//    production database — over Neon's direct connection, which migrations
//    need; the app itself runs on the pooled one.
// 3. nest build, which api/index.js loads.
// 4. An empty public/ as the static output, so no repository file is served.
const { execSync } = require('node:child_process');
const { mkdirSync } = require('node:fs');

const run = (command, env = process.env) => execSync(command, { stdio: 'inherit', env });

run('npx prisma generate');

if (process.env.VERCEL_ENV === 'production') {
  const direct = process.env.DATABASE_URL_UNPOOLED;
  if (!direct) throw new Error('DATABASE_URL_UNPOOLED is not set: migrations need the direct Neon connection');
  run('npx prisma migrate deploy', { ...process.env, DATABASE_URL: direct });
} else {
  console.log('Skipping migrations (VERCEL_ENV=' + (process.env.VERCEL_ENV || 'unset') + ')');
}

run('npx nest build');
mkdirSync('public', { recursive: true });
