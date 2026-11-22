import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { queueArchive } from './archive.mjs';
import { entry, requireOk, save, secret } from './memory.mjs';
import { Runtime } from './runtime.mjs';

const prefix = /^(?:记|存|记录|记住|remember)\s*[:：]\s*/i;
const receipt = text => ({
  terminationBehavior: 'terminate',
  injectSteps: [{ systemMessage: { systemMessage: 'Respire · ' + text } }],
});

async function recall(runtime, query) {
  const status = requireOk(await runtime.call('status'));
  if (status.summary?.workspace === 'off') return {};
  const doc = await runtime.call('recall', ['--limit', '5', '--titles', '--', query]);
  if (doc.status === 'skip') return {};
  const hits = requireOk(doc).details;
  if (!Array.isArray(hits)) throw new Error('Invalid recall response');
  const ids = [...new Set(hits.map(hit => hit.superseded_by || hit.id))];
  const items = await Promise.all(ids.map(id => entry(runtime, id)));
  const sections = items.filter(item => !item.superseded_by && !secret.test(item.title) && !secret.test(item.content))
    .map(item => '[' + item.id.slice(0, 8) + '] ' + item.title + '\n' + item.content);
  if (!sections.length) return {};
  return { injectSteps: [{ ephemeralMessage: 'Respire recalled reference material.\n\n' + sections.join('\n\n').slice(0, 6000) }] };
}

async function userStep(event, query) {
  // The App writes explicit user input before PreInvocation. Hook-injected records use SYSTEM_SDK.
  if (!event.conversationId || !event.transcriptPath || !Number.isInteger(event.initialNumSteps)) {
    throw new Error('Antigravity transcript identity unavailable');
  }
  const rows = (await readFile(event.transcriptPath, 'utf8')).trimEnd().split('\n');
  for (let i = rows.length - 1; i >= 0; --i) {
    const row = JSON.parse(rows[i]);
    if (row.type !== 'USER_INPUT' || row.source !== 'USER_EXPLICIT' || row.step_index >= event.initialNumSteps) continue;
    if (!Number.isInteger(row.step_index) || typeof row.created_at !== 'string' ||
        typeof row.content !== 'string' ||
        row.content.replaceAll('\r\n', '\n').match(/^<USER_REQUEST>\n([\s\S]*?)\n<\/USER_REQUEST>(?:\n|$)/)?.[1].trim() !== query.replaceAll('\r\n', '\n')) {
      throw new Error('Antigravity transcript does not match this user input');
    }
    return [event.conversationId, row.step_index, row.created_at];
  }
  throw new Error('Antigravity transcript has no explicit user input');
}

async function saveOnce(runtime, user, input) {
  // The claim stays on disk even after a crash, so a replay cannot resubmit a write.
  const state = join(homedir(), '.gemini', 'config', 'respire-antigravity', 'operations');
  await mkdir(state, { recursive: true });
  const operation = createHash('sha256').update(JSON.stringify(user)).digest('hex');
  const file = join(state, operation + '.json');
  try {
    await writeFile(file, '{}', { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const previous = JSON.parse(await readFile(file, 'utf8') || '{}');
    return previous.text ?? ('本轮操作已领取，保存回执尚未确认。操作 ID ' + operation + '。');
  }
  let text;
  try {
    text = await save(runtime, input, operation);
  } catch (error) {
    console.error('Respire save review failed:', error.name, error.message);
    text = '未完成保存审核，请检查 Runtime 与钩子日志。';
  }
  await writeFile(file + '.tmp', JSON.stringify({ text }), { mode: 0o600 });
  await rename(file + '.tmp', file);
  return text;
}

async function handle(event) {
  if (event.invocationNum !== 0 || typeof event.lastUserInput !== 'string') return {};
  const input = event.lastUserInput.trim();
  const isSave = prefix.test(input);
  if (!input || /^(?:\/nomem|#nomem)(?:\s|$)/i.test(input)) return {};
  if (secret.test(input)) return isSave ? receipt('未写入，文本疑似含凭据。') : {};
  try {
    const runtime = new Runtime();
    await runtime.bind();
    if (isSave) {
      const turn = await userStep(event, input);
      return receipt(await saveOnce(runtime, turn, input.replace(prefix, '')));
    }
    return await recall(runtime, input);
  } catch (error) {
    console.error('Respire hook:', error.name, error.message);
    if (isSave) return receipt('未能确认保存结果，请检查 Runtime 和钩子日志。');
    throw error;
  }
}

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const event = JSON.parse(Buffer.concat(chunks));
let response = {};
if (process.argv[2] === 'session-start') {
  await new Runtime().bind();
} else if (process.argv[2] === 'stop') {
  await queueArchive(event);
} else {
  response = await handle(event);
}
process.stdout.write(JSON.stringify(response) + '\n');
