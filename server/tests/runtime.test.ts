import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('production API loads with require(ESM) disabled and reports missing database safely',()=>{
 const source=`
  import assert from 'node:assert/strict';
  await import('./api/index.ts');
  const {handleRequest}=await import('./server/runtime.ts');
  const health=await handleRequest(new Request('https://example.com/api/health'));
  assert.equal(health.status,200);
  const response=await handleRequest(new Request('https://example.com/api/auth/me'));
  assert.equal(response.status,503);
  assert.equal((await response.json()).error.code,'database_not_configured');
 `;
 const result=spawnSync(process.execPath,['--no-experimental-require-module','--import','tsx','--input-type=module','-e',source],{cwd:process.cwd(),env:{...process.env,NODE_ENV:'production',DATABASE_URL:'',POSTGRES_URL:''},encoding:'utf8',timeout:20000});
 assert.equal(result.status,0,result.stderr||result.error?.message);
});
