/**
 * Slash commands are verified by their COMMAND RECORD — a companion to core/sendQueue.ts.
 *
 * A slash command is not a user turn. `/remote-control foo` typed into a session is recorded as a
 * `system` / `local_command` record whose content is `<command-name>/remote-control</command-name>`
 * plus `<command-args>foo</command-args>`; a skill command is a user turn of the same tagged shape.
 * Neither contains the typed text as one string, so sendQueue's needle count can never see it:
 * every delivered `/remote-control <name>` was reported undelivered after the full hold while the
 * transcript showed the command had run (19 false dead letters on 2026-10-08, 39 on 2026-10-04).
 *
 * WHY A SEPARATE FILE. core/sendQueue.ts is pinned byte-identical to the Glass extension's copy
 * (protocolContract.test.ts), so the two fulfillers provably agree. This rule is App-only until it
 * is ported; putting it in the pinned file would have meant either breaking the pin or bumping its
 * hash without Glass changing. PORT IT TO GLASS — until then Glass still dead-letters slash sends.
 *
 * The three record helpers below mirror sendQueue's private ones on purpose (they are not exported
 * there, and exporting them would change the pinned bytes). If a transcript format change touches
 * one side, it must touch both.
 */
import { countUserTurnsContaining } from './sendQueue';

export interface SlashCommand { name: string; args: string }

/** A single-line `/name args` → its parts; anything else (prose, multi-line, `/ x`) is not a command. */
export function parseSlashCommand(text: string): SlashCommand | undefined {
  const m = (text || '').trim().match(/^\/([A-Za-z0-9][\w:.-]*)(?:[ \t]+([^\n]*))?$/);
  if (!m) return undefined;
  return { name: m[1], args: (m[2] || '').trim() };
}

const isUserRecord = (rec: unknown): boolean => {
  if (!rec || typeof rec !== 'object') return false;
  const r = rec as { type?: unknown; message?: { role?: unknown } };
  return r.type === 'user' || r.message?.role === 'user';
};

const recordText = (rec: unknown): string => {
  const c = (rec as { message?: { content?: unknown } }).message?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c.map((blk) => (blk && typeof blk === 'object' ? String((blk as { text?: unknown }).text ?? '') : '')).join(' ');
  }
  return '';
};

const recordTimeMs = (rec: unknown): number | undefined => {
  const ts = (rec as { timestamp?: unknown }).timestamp;
  if (typeof ts !== 'string') return undefined;
  const ms = Date.parse(ts);
  return Number.isFinite(ms) ? ms : undefined;
};

const tagValue = (content: string, tag: string): string | undefined => {
  const m = content.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return m ? m[1].trim() : undefined;
};

/** Does this record show `cmd` having been run? Either shape: local_command, or a tagged user turn. */
function recordRunsCommand(rec: unknown, cmd: SlashCommand): boolean {
  if (!rec || typeof rec !== 'object') return false;
  const r = rec as { type?: unknown; subtype?: unknown; content?: unknown };
  const isLocal = r.type === 'system' && r.subtype === 'local_command';
  if (!isLocal && !isUserRecord(rec)) return false;   // an assistant quoting the tags must not count
  const content = typeof r.content === 'string' ? r.content : recordText(rec);
  if (!content.includes(`<command-name>/${cmd.name}</command-name>`)) return false;
  // Args must match exactly: `/remote-control a` is not `/remote-control b`.
  return (tagValue(content, 'command-args') ?? '') === cmd.args;
}

/**
 * Command records for `text` since `sinceMs` that the needle count does NOT already see.
 *
 * "Not already" is the whole point of the shape. A short command such as `/config` is found by its
 * needle inside the very user turn that carries its command-name tag; adding a second count for
 * that same record would report one delivery as a duplicate. So this returns only the EXTRA
 * records, and callers add it to countUserTurnsContaining — a union, counted once per record.
 * One typed command writes two local_command records (the command, then its stdout); only the
 * first carries a command-name, so a run counts once. Returns 0 for anything that is not a command.
 */
export function countExtraSlashRuns(jsonl: string, text: string, needle: string, sinceMs?: number): number {
  const cmd = parseSlashCommand(text);
  if (!cmd) return 0;
  let n = 0;
  for (const line of jsonl.split('\n')) {
    if (!line.includes('<command-name>')) continue;   // cheap prefilter before JSON.parse
    let rec: unknown;
    try { rec = JSON.parse(line); } catch { continue; }
    if (sinceMs !== undefined) {
      const t = recordTimeMs(rec);
      if (t === undefined || t < sinceMs) continue;   // fail closed, exactly as the needle count does
    }
    if (!recordRunsCommand(rec, cmd)) continue;
    const seenByNeedle = !!needle && isUserRecord(rec) && recordText(rec).includes(needle);
    if (!seenByNeedle) n++;
  }
  return n;
}

/** The full delivery count: plain prompts by user turn, slash commands also by command record. */
export function countDeliveries(jsonl: string, text: string, needle: string, sinceMs?: number): number {
  return countUserTurnsContaining(jsonl, needle, sinceMs) + countExtraSlashRuns(jsonl, text, needle, sinceMs);
}
