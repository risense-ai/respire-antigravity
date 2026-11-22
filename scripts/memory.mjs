import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const fullId = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
const shortId = /^(?:[\da-f]{8,32}|[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12})$/i;
export const secret = /(?:password|passwd|pwd|api[_ -]?key|token|密码|口令|密钥)\s*[:=：]\s*\S+|-----BEGIN .*PRIVATE KEY-----|\b(?:ghp_|github_pat_|sk-|AKIA|xox)[\w-]{8,}/iu;

export function requireOk(doc) {
  if (doc.status !== 'ok') throw new Error(doc.command + ' returned ' + (doc.summary?.state ?? doc.status));
  return doc;
}

export async function entry(runtime, id) {
  if (!shortId.test(id)) throw new Error('Invalid memory ID');
  const doc = requireOk(await runtime.call('show', [id]));
  const item = doc.details?.entry;
  if (typeof item?.id !== 'string' || !fullId.test(item.id) || doc.summary?.id !== item.id ||
      !item.id.replaceAll('-', '').toLowerCase().startsWith(id.replaceAll('-', '').toLowerCase()) ||
      typeof item.title !== 'string' || typeof item.content !== 'string') throw new Error('Invalid show response');
  return item;
}

export async function save(runtime, input, operation, { title: reviewedTitle, onVerified } = {}) {
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
  const title = reviewedTitle ?? Array.from(line.match(/^.{6,}?[。！？!?]/u)?.[0] ?? line).slice(0, 70).join('');
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
      onVerified?.(id);
      return '已写入并回读核验（' + id.slice(0, 8) + '）。' + warning;
    }
    return '已收到写入回执，回读内容不一致（' + id.slice(0, 8) + '）。' + warning;
  } catch (error) {
    console.error('Respire write read-back unavailable:', error.name);
    return '已收到写入回执，回读待确认（' + id.slice(0, 8) + '）。' + warning;
  }
}
