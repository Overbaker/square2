import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.argv[2] ?? process.cwd();
const read = (p) => readFileSync(join(root, p), 'utf8').split('\n').map((l) => l.trim());
const router = new Set(read('routes/router.txt').filter(Boolean));
let bad = 0;
read('routes/published.txt').forEach((pair, i) => {
  if (pair && !router.has(pair)) {
    console.log(JSON.stringify({ path: 'routes/published.txt', line: i + 1, subject: `${pair} has no router entry` }));
    bad++;
  }
});
process.exit(bad > 0 ? 1 : 0);
