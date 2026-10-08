import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { countUserTurnsContaining, verifyVerdict } from '../core/sendQueue';

const cmdTurn = (cmd: string, iso: string): string => JSON.stringify({
  type: 'user', timestamp: iso, message: { role: 'user', content: `<command-name>${cmd}</command-name>` },
});

/* ── slash commands are verified by their command record ─────────────────────────────────── */
import { parseSlashCommand, countExtraSlashRuns, countDeliveries } from '../core/slashVerify';
import { safeNeedle as needleOf } from '../core/sendQueue';

const localCmd = (name: string, args: string, ts: string): string => [
  JSON.stringify({ type: 'system', subtype: 'local_command', timestamp: ts,
    content: `<command-name>/${name}</command-name>\n            <command-message>${name}</command-message>\n            <command-args>${args}</command-args>` }),
  JSON.stringify({ type: 'system', subtype: 'local_command', timestamp: ts,
    content: '<local-command-stdout></local-command-stdout>', commandRun: { command: name, args } }),
  JSON.stringify({ type: 'system', subtype: 'bridge_status', timestamp: ts, content: `/${name} is active` }),
].join('\n');

test('parseSlashCommand: a slash line splits into name + args; anything else is not a command', () => {
  assert.deepEqual(parseSlashCommand('/remote-control market-desk'), { name: 'remote-control', args: 'market-desk' });
  assert.deepEqual(parseSlashCommand('  /aios:close-session --auto '), { name: 'aios:close-session', args: '--auto' });
  assert.deepEqual(parseSlashCommand('/config'), { name: 'config', args: '' });
  assert.equal(parseSlashCommand('From ali: run /config please'), undefined);
  assert.equal(parseSlashCommand('/two\nlines'), undefined);
  assert.equal(parseSlashCommand('/ not-a-command'), undefined);
});

test('a delivered /remote-control is VERIFIED by its local_command record (19 false dead letters, 2026-10-08)', () => {
  const claimedAt = Date.parse('2026-10-08T08:04:24.000Z');
  const text = '/remote-control various-2';
  const needle = needleOf(text);
  const jsonl = localCmd('remote-control', 'various-2', '2026-10-08T08:04:25.108Z');
  assert.equal(countUserTurnsContaining(jsonl, needle, claimedAt), 0, 'the old count never sees it — the bug');
  assert.equal(countDeliveries(jsonl, text, needle, claimedAt), 1, 'one run = one delivery, though it writes two local_command records');
  assert.equal(verifyVerdict(0, countDeliveries(jsonl, text, needle, claimedAt)), 'verified');
});

test('slash verification is exact: other args, other commands, old runs and assistant echoes do not count', () => {
  const claimedAt = Date.parse('2026-10-08T08:04:24.000Z');
  const text = '/remote-control various-2';
  const nd = needleOf(text);
  assert.equal(countExtraSlashRuns(localCmd('remote-control', 'market-desk', '2026-10-08T08:04:25.000Z'), text, nd, claimedAt), 0, 'different args');
  assert.equal(countExtraSlashRuns(localCmd('rename', 'various-2', '2026-10-08T08:04:25.000Z'), text, nd, claimedAt), 0, 'different command');
  assert.equal(countExtraSlashRuns(localCmd('remote-control', 'various-2', '2026-10-04T09:00:00.000Z'), text, nd, claimedAt), 0, 'a run before the claim is not ours');
  const echo = JSON.stringify({ type: 'assistant', timestamp: '2026-10-08T08:04:26.000Z',
    message: { role: 'assistant', content: '<command-name>/remote-control</command-name><command-args>various-2</command-args>' } });
  assert.equal(countExtraSlashRuns(echo, text, nd, claimedAt), 0, 'an assistant quoting the tags is not a run');
  const twice = [localCmd('remote-control', 'various-2', '2026-10-08T08:04:25.000Z'), localCmd('remote-control', 'various-2', '2026-10-08T08:04:40.000Z')].join('\n');
  assert.equal(verifyVerdict(0, countDeliveries(twice, '/remote-control various-2', needleOf('/remote-control various-2'), claimedAt)), 'duplicate',
    'a genuine double delivery is still caught');
});

test('a command landing as a tagged USER turn is counted once, not twice', () => {
  /* `/config`: the needle is found inside the same user turn that carries the command-name tag.
     A sum of the two counts would call one delivery a duplicate. */
  const claimedAt = Date.parse('2026-08-14T18:00:00.000Z');
  const turn = cmdTurn('/config', '2026-08-14T18:00:03.000Z');
  assert.equal(countDeliveries(turn, '/config', needleOf('/config'), claimedAt), 1);
  const skill = JSON.stringify({ type: 'user', timestamp: '2026-08-14T18:00:03.000Z', message: { role: 'user',
    content: '<command-message>aios:close-session</command-message>\n<command-name>/aios:close-session</command-name>\n<command-args>--auto</command-args>' } });
  assert.equal(countDeliveries(skill, '/aios:close-session --auto', needleOf('/aios:close-session --auto'), claimedAt), 1,
    'a skill command with args, which the needle alone cannot find');
});

test('plain prompts are untouched: countDeliveries is countUserTurnsContaining when the text is not a command', () => {
  const ts = '2026-10-08T08:04:25.000Z';
  const text = 'From ali: please run the market check end to end now';
  const turn = JSON.stringify({ type: 'user', timestamp: ts, message: { role: 'user', content: text } });
  const needle = needleOf(text);
  assert.equal(countDeliveries(turn, text, needle, Date.parse(ts)), countUserTurnsContaining(turn, needle, Date.parse(ts)));
  assert.equal(countDeliveries(turn, text, needle, Date.parse(ts)), 1);
});
