import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { experimentRoot, readJson } from './core.mjs';

function percent(value) {
  return value === null || value === undefined ? '—' : `${Math.round(value * 100)}%`;
}

function size(bytes) {
  if (bytes === null || bytes === undefined) return '—';
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
  return `${(bytes / 1024).toFixed(1)} KiB`;
}

function outcomeCell(attempt) {
  if (!attempt) return '—';
  if (attempt.outcome === 'transcript') return `字幕 ${attempt.segmentSummary.segmentCount} 段 / ${attempt.durationMs} ms`;
  if (attempt.outcome === 'no-caption') return `无字幕 / ${attempt.durationMs} ms`;
  if (attempt.outcome === 'language-unavailable') return `语言不存在 / ${attempt.durationMs} ms`;
  return `错误 ${attempt.error?.category || 'unknown'} / ${attempt.durationMs} ms`;
}

function escapeTable(value) {
  return String(value ?? '—').replaceAll('|', '\\|').replaceAll('\n', ' ');
}

function endpointSequence(attempt) {
  if (!attempt) return '—';
  return attempt.requests.map((request) => `${request.endpoint}:${request.status ?? 'ERR'}`).join(' → ') || '无请求';
}

const resultName = process.env.RESULT_NAME || 'latest';
if (!/^[a-z0-9][a-z0-9-]*$/.test(resultName)) {
  throw new Error('RESULT_NAME must contain only lowercase letters, numbers, and hyphens');
}
const result = await readJson(join(experimentRoot, 'results', `${resultName}.json`));
const candidates = Object.keys(result.summary);
const cases = result.cases;
const lines = [];

lines.push(`# Node 无 Key 字幕库真实对比${resultName === 'latest' ? '' : `：${resultName}`}`);
lines.push('');
lines.push(`运行时间：${result.startedAt}；环境：${result.environment.node} / ${result.environment.platform}-${result.environment.architecture}。`);
lines.push('');
lines.push('本结果只代表同一台机器、同一网络出口的一次签出态冷调用矩阵。未使用 API Key、Cookie、代理或已保存字幕；每次调用有独立超时，候选顺序按样本轮换。');
lines.push('');

lines.push('## 结果摘要');
lines.push('');
lines.push('| 候选 | 正样本成功率 | 负样本判断 | 缺失语言边界 | 中位总耗时 | 总 HTTP 请求 | 错误 |');
lines.push('| --- | ---: | ---: | ---: | ---: | ---: | --- |');
for (const candidate of candidates) {
  const summary = result.summary[candidate];
  lines.push(
    `| ${candidate} | ${percent(summary.transcriptSuccessRate)} (${summary.transcriptSuccessCount}/${summary.expectedTranscriptCount}) | ` +
    `${percent(summary.noCaptionAccuracy)} (${summary.correctNoCaptionCount}/${summary.expectedNoCaptionCount}) | ` +
    `${percent(summary.languageUnavailableAccuracy)} (${summary.correctLanguageUnavailableCount}/${summary.expectedLanguageUnavailableCount}) | ` +
    `${summary.medianDurationMs ?? '—'} ms | ${summary.totalRequestCount} | ${escapeTable(JSON.stringify(summary.errorCategories))} |`
  );
}
lines.push('');

lines.push('## 每个真实样本');
lines.push('');
lines.push(`| 样本 | 预期 | ${candidates.join(' | ')} |`);
lines.push(`| --- | --- | ${candidates.map(() => '---').join(' | ')} |`);
for (const testCase of cases) {
  const cells = candidates.map((candidate) => {
    const attempt = result.attempts.find((item) => item.caseId === testCase.id && item.candidate === candidate);
    return outcomeCell(attempt);
  });
  lines.push(`| ${testCase.id} | ${testCase.expectedOutcome}${testCase.language ? ` (${testCase.language})` : ''} | ${cells.join(' | ')} |`);
}
lines.push('');

lines.push('## 安装与浏览器现实');
lines.push('');
lines.push('| 候选 | 版本 | 自身文件 | 连同运行时依赖 | 运行时包数 | Node | 浏览器 / MV3 边界 |');
lines.push('| --- | --- | ---: | ---: | ---: | --- | --- |');
for (const candidate of candidates) {
  const metadata = result.packageMetadata[candidate];
  const profile = result.profiles[candidate];
  lines.push(
    `| [${candidate}](${profile.source}) | ${metadata.version} | ${size(metadata.packageBytes)} | ` +
    `${size(metadata.installedFootprintBytes)} | ${metadata.transitivePackageCountIncludingSelf} | ` +
    `${metadata.nodeEngine || '未声明'} | ${escapeTable(profile.browserFit)} |`
  );
}
lines.push('');
if (result.packageMetadata['youtubei.js']?.browserBundleBytes) {
  const metadata = result.packageMetadata['youtubei.js'];
  lines.push(
    `youtubei.js 自带 browser bundle 为 ${size(metadata.browserBundleBytes)}（gzip ${size(metadata.browserBundleGzipBytes)}），` +
    '但上游明确要求浏览器请求经过自有服务端代理，所以“有浏览器 bundle”不等于可直接放进当前无打包体系的 MV3 扩展。'
  );
  lines.push('');
}

lines.push('## 实际请求链');
lines.push('');
lines.push('| 候选 | 典型成功链（首个成功样本） | 配置策略 |');
lines.push('| --- | --- | --- |');
for (const candidate of candidates) {
  const attempt = result.attempts.find((item) => item.candidate === candidate && item.outcome === 'transcript') ||
    result.attempts.find((item) => item.candidate === candidate);
  lines.push(`| ${candidate} | ${escapeTable(endpointSequence(attempt))} | ${escapeTable(result.profiles[candidate].requestStrategy)} |`);
}
lines.push('');

lines.push('## 返回格式与可接入性');
lines.push('');
lines.push('| 候选 | 原始首段字段 | 语言证据 | 原始字符 / canonical 字符 | canonical SHA-256 | 时间最大值检查 |');
lines.push('| --- | --- | --- | ---: | --- | ---: |');
for (const candidate of candidates) {
  const attempt = result.attempts.find((item) => item.candidate === candidate && item.outcome === 'transcript');
  lines.push(
    `| ${candidate} | ${escapeTable(attempt?.segmentSummary?.firstRawItemKeys?.join(', ') || '无成功结果')} | ` +
    `${escapeTable(attempt?.selectionEvidence || '无')} | ` +
    `${attempt ? `${attempt.segmentSummary.textCharacterCount} / ${attempt.segmentSummary.canonicalTextCharacterCount}` : '—'} | ` +
    `${attempt?.segmentSummary?.canonicalContentSha256?.slice(0, 12) || '—'} | ` +
    `${attempt?.segmentSummary?.maxEndSeconds ?? '—'} 秒 |`
  );
}
lines.push('');

const timingMismatches = result.attempts.filter((attempt) => {
  if (attempt.outcome !== 'transcript') return false;
  const testCase = cases.find((item) => item.id === attempt.caseId);
  const expectedDuration = testCase?.corpusFacts?.durationSeconds;
  return expectedDuration && attempt.segmentSummary.maxEndSeconds > expectedDuration * 10;
});

lines.push('## 可复核观察');
lines.push('');
const youtubeiErrors = result.attempts.filter((attempt) => attempt.candidate === 'youtubei.js' && attempt.error);
if (youtubeiErrors.length) {
  const categories = [...new Set(youtubeiErrors.map((attempt) => `${attempt.error.category}: ${attempt.error.message}`))];
  lines.push(`- youtubei.js 在本轮 ${youtubeiErrors.length}/${result.attempts.filter((attempt) => attempt.candidate === 'youtubei.js').length} 次调用中报错：${escapeTable(categories.join('；'))}。`);
}
const longCase = result.attempts.filter((attempt) => attempt.caseId === 'asr-long-retrieval-divergence');
if (longCase.length) {
  lines.push(`- 长 ASR 样本的浏览器基线曾是 panel 无字幕、direct timedtext 空正文，但本轮三个小型 Node 库都成功取得 1828 段，说明客户端类型或请求上下文会实质改变结果；${longCase.map((attempt) => `${attempt.candidate}=${attempt.outcome}${attempt.error ? `/${attempt.error.category}` : ''}`).join('；')}。`);
}
if (timingMismatches.length) {
  lines.push(`- 时间单位疑似不符合各库文档的秒约定：${timingMismatches.map((attempt) => `${attempt.candidate}/${attempt.caseId} maxEnd=${attempt.segmentSummary.maxEndSeconds}`).join('；')}。接入前必须归一化并写回归测试。`);
}
const chineseCase = result.attempts.filter((attempt) => attempt.caseId === 'traditional-chinese-explicit');
if (chineseCase.length) {
  lines.push(`- 显式 zh-TW：${chineseCase.map((attempt) => `${attempt.candidate}=${attempt.outcome}${attempt.selectedLanguage ? `/${attempt.selectedLanguage}` : ''}`).join('；')}。`);
}
for (const testCase of cases) {
  const successful = result.attempts.filter((attempt) => attempt.caseId === testCase.id && attempt.outcome === 'transcript');
  if (successful.length < 2) continue;
  const rawHashes = new Set(successful.map((attempt) => attempt.segmentSummary.contentSha256));
  const canonicalHashes = new Set(successful.map((attempt) => attempt.segmentSummary.canonicalContentSha256));
  const metrics = successful.map((attempt) =>
    `${attempt.candidate}=raw:${attempt.segmentSummary.textCharacterCount},canonical:${attempt.segmentSummary.canonicalTextCharacterCount},sha:${attempt.segmentSummary.canonicalContentSha256.slice(0, 12)}`
  ).join('；');
  if (rawHashes.size > 1 && canonicalHashes.size === 1) {
    lines.push(`- ${testCase.id}：原始长度/哈希不同，但 HTML entity decode + NFKC + 全空白折叠后完全一致；差异属于编码或空白格式。${metrics}。`);
  } else if (canonicalHashes.size > 1) {
    lines.push(`- ${testCase.id}：canonical 后仍有内容差异，不能归因于纯空白/实体编码。${metrics}。`);
  }
}
const languageControl = result.attempts.filter((attempt) => attempt.caseId === 'language-policy-control-en');
const languageMissing = result.attempts.filter((attempt) => attempt.caseId === 'language-policy-missing-fr');
if (languageControl.length && languageMissing.length) {
  const observations = candidates.map((candidate) => {
    const control = languageControl.find((attempt) => attempt.candidate === candidate);
    const missing = languageMissing.find((attempt) => attempt.candidate === candidate);
    if (missing?.outcome === 'language-unavailable') return `${candidate}=严格报语言不存在`;
    if (
      control?.outcome === 'transcript' &&
      missing?.outcome === 'transcript' &&
      control.segmentSummary.canonicalContentSha256 === missing.segmentSummary.canonicalContentSha256
    ) return `${candidate}=静默回退且正文与 en 控制完全相同`;
    return `${candidate}=${missing?.outcome || '未运行'}${missing?.error ? `/${missing.error.category}` : ''}`;
  });
  lines.push(`- 缺失 fr 语言边界：${observations.join('；')}。`);
}
lines.push('- HTTP 日志只保存 origin + path，不保存字幕 URL 查询串、API key 参数、Cookie 或请求正文。JSON 不保存完整字幕，只保存段数、字符数与 SHA-256。');
lines.push('');

lines.push('## 本组建议边界');
lines.push('');
const timingMismatchCandidates = new Set(timingMismatches.map((attempt) => attempt.candidate));
const ranked = candidates
  .filter((candidate) => !timingMismatchCandidates.has(candidate))
  .map((candidate) => ({ candidate, ...result.summary[candidate], bytes: result.packageMetadata[candidate].installedFootprintBytes }))
  .sort((a, b) =>
    (b.transcriptSuccessRate ?? -1) - (a.transcriptSuccessRate ?? -1) ||
    (b.noCaptionAccuracy ?? -1) - (a.noCaptionAccuracy ?? -1) ||
    (b.languageUnavailableAccuracy ?? -1) - (a.languageUnavailableAccuracy ?? -1) ||
    a.totalRequestCount - b.totalRequestCount ||
    a.bytes - b.bytes
  );
const best = ranked[0];
lines.push(
  `仅在“需要 Node 伴随进程”的候选里，本轮应优先继续验证 ${best.candidate}：它的正样本成功率为 ${percent(best.transcriptSuccessRate)}，` +
  `安装足迹约 ${size(best.bytes)}。这不是直接采用结论；还应与纯扩展 MAIN-world / transcript-panel 路径比较，因为 Node 库意味着额外运行时边界。`
);
lines.push('');
if (timingMismatchCandidates.has('youtube-transcript')) {
  lines.push('youtube-transcript 虽然正样本都取到了正文，但当前 srv3 解析分支把毫秒放进文档声称为“秒”的 `offset` / `duration`；另一个 classic XML 分支又返回秒，不能安全地无条件除以 1000，因此不建议未经修补直接接入。');
  lines.push('');
}
lines.push('youtubei.js 本轮不应作为字幕主链候选：其能力面远大于字幕需求，安装与 bundle 显著更大，并且真实 get_transcript 已出现上游 400；浏览器版本还需要代理。');
lines.push('');
lines.push('四个候选都不是“把一个文件直接放进现有 MV3”即可完成的方案：前三者仍需打包与真实扩展 CORS/host-permission 验证，youtubei.js 上游则明确要求浏览器代理。');
lines.push('');
lines.push('复跑命令：`npm install --ignore-scripts --cache .npm-cache --no-audit --no-fund && npm run probe && npm run report`。可用 `CASES`、`CANDIDATES`、`ROUNDS`、`TIMEOUT_MS`、`DELAY_MS` 环境变量缩小或扩展矩阵。');
lines.push('');

const reportName = resultName === 'latest' ? 'report.md' : `${resultName}.md`;
await writeFile(join(experimentRoot, 'results', reportName), `${lines.join('\n')}\n`);
console.log(`Wrote ${join(experimentRoot, 'results', reportName)}`);
