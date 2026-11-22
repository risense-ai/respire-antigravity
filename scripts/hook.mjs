import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Runtime } from './runtime.mjs';

const prefix = /^(?:记|存|记录|记住|remember)\s*[:：]\s*/i;
const fullId = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
const shortId = /^(?:[\da-f]{8,32}|[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12})$/i;
const secret = /(?:password|passwd|pwd|api[_ -]?key|token|密码|口令|密钥)\s*[:=：]\s*\S+|-----BEGIN .*PRIVATE KEY-----|\b(?:ghp_|github_pat_|sk-|AKIA|xox)[\w-]{8,}/iu;
const receipt = text => ({
  terminationBehavior: 'terminate',
  injectSteps: [{ systemMessage: { systemMessage: 'Respire · ' + text } }],
});

function requireOk(doc) {
  if (doc.status !== 'ok') throw new Error(doc.command + ' returned ' + (doc.summary?.state ?? doc.status));
  return doc;
}

async function entry(runtime, id) {
  if (!shortId.test(id)) throw new Error('Invalid memory ID');
  const doc = requireOk(await runtime.call('show', [id]));
  const item = doc.details?.entry;
  if (typeof item?.id !== 'string' || !fullId.test(item.id) || doc.summary?.id !== item.id ||
      !item.id.replaceAll('-', '').toLowerCase().startsWith(id.replaceAll('-', '').toLowerCase()) ||
      typeof item.title !== 'string' || typeof item.content !== 'string') throw new Error('Invalid show response');
  return item;
}

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

async function save(runtime, input, operation) {
  const parentOption = input.match(/^\[parent=([\da-f-]+)\]\s*/i);
  const content = (parentOption ? input.slice(parentOption[0].length) : input).trim();
  if (!content) return '未写入，记忆正文为空。';

  const status = requireOk(await runtime.call('status'));
  if (status.summary?.workspace !== 'normal') return '未写入，当前工作区未允许写入。';
  requireOk(await runtime.call('prompt'));
  if (typeof runtime.health.data_dir !== 'string' || !runtime.health.data_dir) throw new Error('Runtime account directory unavailable');
  try {
    const config = JSON.parse(await readFile(join(runtime.health.data_dir, 'agent.json'), 'utf8'));
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Invalid agent configuration');
    if (config.readonly || config.memory_off) return '未写入，当前账户配置未允许写入。';
  } catch (error) {
    // An absent agent.json represents Runtime's default agent settings.
    if (error.code !== 'ENOENT') throw error;
  }

  const review = await runtime.call('candidates', ['--', content], 60000);
  if (review.status !== 'ok') return '未写入，候选评审状态为 ' + (review.summary?.state ?? review.status) + '。';
  if (!Array.isArray(review.details?.merge)) throw new Error('Invalid candidate response');
  for (const hit of review.details.merge) {
    const candidate = await entry(runtime, hit.entry?.id);
    if (!candidate.superseded_by && candidate.content.trim() === content) {
      return '已存在并核验（' + candidate.id.slice(0, 8) + '）。';
    }
  }
  if (review.details.merge.length) return '未写入，相似记忆需要人工选择更新或合并。';
  requireOk(await runtime.call('taxonomy', ['--list']));
  if (!parentOption) return '未写入，请用「记：[parent=父节点ID] 正文」指定已审核的父节点。';
  const parent = await entry(runtime, parentOption[1]);
  if (parent.superseded_by) return '未写入，所选父节点已被替代。';
  const line = content.replace(/\s+/g, ' ');
  const title = Array.from(line.match(/^.{6,}?[。！？!?]/u)?.[0] ?? line).slice(0, 70).join('');
  let doc;
  try {
    doc = await runtime.remember(['--title', title, '--importance', 'important', '--parent', parent.id, '--', content], operation);
  } catch (error) {
    console.error('Respire write outcome unknown:', error.name);
    return '写入结果未知，请先查库。操作 ID ' + operation + '。';
  }
  if (['pending', 'skip', 'fail'].includes(doc.status)) {
    return '未写入，Runtime 返回 ' + (doc.summary?.state ?? doc.status) + '。';
  }
  const id = doc.summary?.id;
  if (!['ok', 'warn'].includes(doc.status) || typeof id !== 'string' || !fullId.test(id)) {
    return '写入结果未知，请先查库。操作 ID ' + operation + '。';
  }
  const warning = doc.status === 'warn' ? ' Runtime 返回警告。' : '';
  try {
    const item = await entry(runtime, id);
    if (item.title === title && item.content.trim() === content &&
        item.parent_id === parent.id && item.importance === 'important') {
      return '已写入并回读核验（' + id.slice(0, 8) + '）。' + warning;
    }
    return '已收到写入回执，回读内容不一致（' + id.slice(0, 8) + '）。' + warning;
  } catch (error) {
    console.error('Respire write read-back unavailable:', error.name);
    return '已收到写入回执，回读待确认（' + id.slice(0, 8) + '）。' + warning;
  }
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
} else {
  response = await handle(event);
}
process.stdout.write(JSON.stringify(response) + '\n');
