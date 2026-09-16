import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
writeFileSync('www/build-info.json', JSON.stringify({
  commit: git('rev-parse', 'HEAD'),
  dirty: !!git('status', '--porcelain'),
  builtAt: new Date().toISOString(),
}, null, 2) + '\n');
