// Fixture build for the integration tests. It copies public/ to dist/ and can be told to misbehave:
//   BREAK file present in the project -> the build fails (exit 1)
//   SLOW file present in the project  -> the build takes 15 seconds
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

if (existsSync('BREAK')) {
  console.error('BREAK file present: failing on purpose');
  process.exit(1);
}
if (existsSync('SLOW')) {
  await sleep(15000);
}
rmSync('dist', { recursive: true, force: true });
mkdirSync('dist', { recursive: true });
cpSync('public', 'dist', { recursive: true });
console.log('fixture build copied public/ to dist/');
