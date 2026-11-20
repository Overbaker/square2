#!/usr/bin/env node
import { main } from '../src/cli/main.mjs';

main(process.argv.slice(2), {
  cwd: process.cwd(),
  env: process.env,
  stdout: (t) => process.stdout.write(t),
  stderr: (t) => process.stderr.write(t),
}).then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`[S2-INTERNAL] ${err && err.stack ? err.stack : err} — Instead: report this as a square² bug\n`);
    process.exit(2);
  },
);
