import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
const require = createRequire(import.meta.url);
await mkdir(new URL('../server/generated/', import.meta.url), { recursive: true });
// sanitize-html 2.18+ requires the ESM-only htmlparser2 from CommonJS.
// Vercel disables require(ESM). Bundle both without downgrading security fixes.
await build({
  entryPoints: [require.resolve('sanitize-html')],
  outfile: new URL('../server/generated/sanitizer.cjs', import.meta.url).pathname,
  bundle: true, platform: 'node', format: 'cjs', target: 'node24',
  sourcemap: false, legalComments: 'inline',
});
