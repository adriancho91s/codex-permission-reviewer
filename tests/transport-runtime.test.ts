import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readBoundedLines } from '../src/transport/mcp.ts';
import { AppServerReviewError, buildMinimalChildEnvironment, appServerConfigText, buildAppServerRequests, runCodexAppServer } from '../src/runtime/app-server-client.ts';
import { PACKAGE_VERSION } from '../src/version.ts';

test('MCP rejects pre-initialize tool access and negotiates protocol through stable launcher', async () => {
  const child = spawn(process.execPath, ['scripts/server.mjs'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const closed = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => resolve(code)); });
  child.stdin.end([
    { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    { jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
    { jsonrpc: '2.0', id: 3, method: 'tools/list' },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'review_sensitive_action', arguments: {} } },
  ].map(value => JSON.stringify(value)).join('\n') + '\n');
  assert.equal(await closed, 0, stderr);
  const replies = new Map(stdout.trim().split('\n').map(line => { const value = JSON.parse(line); return [value.id, value]; }));
  assert.equal(replies.get(1).error.code, -32002);
  assert.equal(replies.get(2).result.protocolVersion, '2025-06-18');
  assert.equal(replies.get(2).result.serverInfo.version, PACKAGE_VERSION);
  assert.equal(replies.get(3).result.tools[0].name, 'review_sensitive_action');
  assert.equal(replies.get(4).result.structuredContent.verdict, 'deny');
});

test('stream bounds recover after oversized chunks and preserve split UTF-8', async () => {
  async function* chunks() { yield Buffer.from('abcde'); yield Buffer.from('f\nok\r\n'); yield Buffer.from([0xc3]); yield Buffer.from([0xa9, 0x0a]); }
  const result = [];
  for await (const item of readBoundedLines(chunks(), 5)) result.push(item.oversized ? 'oversized' : item.line!.toString());
  assert.deepEqual(result, ['oversized', 'ok', 'é']);
});

test('runtime composition preserves no-tools configuration and filters inherited environment', () => {
  const env = buildMinimalChildEnvironment({ PATH: '/usr/bin', HOME: '/home/test', UNTRUSTED_TOKEN: 'fixture' }, '/tmp/isolated');
  assert.equal(env.UNTRUSTED_TOKEN, undefined);
  assert.equal(env.CODEX_HOME, '/tmp/isolated');
  const config = appServerConfigText();
  assert.match(config, /web_search = "disabled"/u);
  assert.match(config, /shell_tool = false/u);
  assert.match(config, /enabled = false/u);
  const requests = buildAppServerRequests({ cwd: '/tmp/isolated', prompt: 'Review fixture', outputSchema: { type: 'object' } });
  const initializeParams = requests.initialize.params as { clientInfo: { version: string } };
  assert.equal(initializeParams.clientInfo.version, PACKAGE_VERSION);
  assert.ok(requests);
});

test('isolated app-server validates advisory warnings without substituting them for review', {
  skip: process.platform === 'win32' && 'executable fixture uses a POSIX shebang',
}, async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'review-warning-fixture-'));
  const priorPath = process.env.PATH;
  const priorHome = process.env.CODEX_HOME;
  const verdict = JSON.stringify({ verdict: 'deny', riskLevel: 'high' });
  const warning = { method: 'warning', params: { message: 'Advisory fixture', threadId: 'fixture-thread' } };
  const writeFixture = (notification: object, options: { omitResult?: boolean; warningAfterTurn?: boolean; badProfile?: boolean } = {}) =>
    writeFile(join(home, 'codex'), `#!${process.execPath}
const { createInterface } = require('node:readline');
const emit = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
const notification = ${JSON.stringify(notification)};
const options = ${JSON.stringify(options)};
for (const event of ['SIGTERM', 'SIGINT']) process.on(event, () => process.exit(0));
createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line);
  if (request.method === 'initialize') {
    emit({ id: request.id, result: { userAgent: 'codex-fixture', codexHome: process.env.CODEX_HOME } });
  } else if (request.method === 'thread/start') {
    if (!options.warningAfterTurn) emit(notification);
    emit({ id: request.id, result: { model: request.params.model, approvalPolicy: 'never',
      cwd: request.params.cwd, thread: { id: 'fixture-thread', ephemeral: true },
      activePermissionProfile: { id: options.badProfile ? 'unexpected' : 'no-tools' }, sandbox: { type: 'readOnly' } } });
  } else if (request.method === 'turn/start') {
    emit({ id: request.id, result: { turn: { id: 'fixture-turn', status: 'inProgress' } } });
    emit({ method: 'thread/settings/updated', params: { threadId: 'fixture-thread', threadSettings: {
      cwd: process.cwd(), model: request.params.model, approvalPolicy: 'never', effort: request.params.effort,
      activePermissionProfile: { id: 'no-tools' }, sandboxPolicy: { type: 'readOnly' } } } });
    const items = options.omitResult ? [] : [{ type: 'agentMessage', id: 'fixture-message', text: ${JSON.stringify(verdict)} }];
    emit({ method: 'turn/completed', params: { turn: { id: 'fixture-turn', status: 'completed', items } } });
    if (options.warningAfterTurn) emit(notification);
  }
});
`, { mode: 0o700 });
  const run = () => runCodexAppServer('Review inert fixture', { outputSchema: { type: 'object' }, timeoutMs: 5_000 });
  const failsWith = (hazard: string) => (error: unknown) =>
    error instanceof AppServerReviewError && error.hazard === hazard;

  try {
    await writeFile(join(home, 'auth.json'), '{}', { mode: 0o600 });
    process.env.PATH = home;
    process.env.CODEX_HOME = home;
    await t.test('a scoped or global warning leaves the completed verdict intact', async () => {
      for (const params of [warning.params, { message: 'Global warning' }, { message: 'Global warning', threadId: null }]) {
        await writeFixture({ method: 'warning', params });
        assert.equal(await run(), verdict);
      }
    });
    await t.test('malformed, wrong-thread, unknown, and request-shaped messages fail closed', async () => {
      for (const [message, hazard] of [
        [{ method: 'warning', params: { message: 123 } }, 'reviewer_malformed_output'],
        [{ method: 'warning', params: { ...warning.params, threadId: 'other-thread' } }, 'reviewer_malformed_output'],
        [{ ...warning, method: 'unsupportedWarning' }, 'reviewer_unsupported_notification_unsupportedwarning'],
        [{ ...warning, id: 2 }, 'reviewer_unexpected_tool_item'],
      ] as const) {
        await writeFixture(message);
        await assert.rejects(run(), failsWith(hazard));
      }
    });
    await t.test('warnings do not replace isolation proof or a completed assistant result', async () => {
      await writeFixture(warning, { badProfile: true });
      await assert.rejects(run(), failsWith('reviewer_permission_profile_mismatch'));
      await writeFixture(warning, { omitResult: true });
      await assert.rejects(run(), failsWith('reviewer_malformed_output'));
      await writeFixture(warning, { warningAfterTurn: true });
      await assert.rejects(run(), failsWith('reviewer_unexpected_trailing_output'));
    });
  } finally {
    if (priorPath === undefined) delete process.env.PATH;
    else process.env.PATH = priorPath;
    if (priorHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = priorHome;
    await rm(home, { recursive: true, force: true });
  }
});
