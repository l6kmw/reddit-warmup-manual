'use strict';

const assert = require('assert');
const { parseOutreachConfig } = require('./config');

// ---- 合法配置 ----
const ok = parseOutreachConfig({
  target: { type: 'serial', value: '1,2' },
  sub: 'r/SaaS',
  keywords: ['startup', 'founder'],
  template: 'Hi {username}, saw your comment on {post_title} in {sub}',
});
assert.strictEqual(ok.sub, 'SaaS', 'sub 去掉 r/ 前缀');
assert.deepStrictEqual(ok.keywords, ['startup', 'founder']);
assert.strictEqual(ok.runLimit, 20, '默认单次执行上限 20');
assert.strictEqual(ok.sendIntervalMin, 60);
assert.strictEqual(ok.sendIntervalMax, 120);
assert.strictEqual(ok.maxCommentsPerPost, 50);
assert.strictEqual(ok.commentHours, 168, '默认时间窗 168h（7 天）');
assert.strictEqual(ok.minScore, 1);

// ---- 社区关键词预置 ----
const { SUB_KEYWORD_PRESETS } = require('./config');
assert.ok(Array.isArray(SUB_KEYWORD_PRESETS.lawncare) && SUB_KEYWORD_PRESETS.lawncare.includes('overseed'), 'lawncare 预置含 overseed');
assert.ok(Array.isArray(SUB_KEYWORD_PRESETS.soccer) && SUB_KEYWORD_PRESETS.soccer.includes('transfer'), 'soccer 预置含 transfer');

// ---- 默认值与显式覆盖 ----
const explicit = parseOutreachConfig({
  target: { type: 'profiles', value: 'p1' },
  sub: 'Test',
  keywords: ['k'],
  template: 'Hello {username}',
  runLimit: 5,
  sendIntervalMin: 30,
  sendIntervalMax: 45,
  mods: ['mod1'],
  bots: ['AutoModerator'],
  excludeNames: ['skip_me'],
  subjects: ['Test'],
});
assert.strictEqual(explicit.runLimit, 5);
assert.strictEqual(explicit.sendIntervalMin, 30);
assert.strictEqual(explicit.sendIntervalMax, 45);
assert.deepStrictEqual(explicit.mods, ['mod1']);
assert.deepStrictEqual(explicit.bots, ['AutoModerator']);
assert.ok(explicit.subjects.includes('Test'));

// ---- 校验失败 ----
assert.throws(() => parseOutreachConfig(null), /配置必须是 JSON 对象/);
assert.throws(() => parseOutreachConfig({}), /缺少 target/);
assert.throws(() => parseOutreachConfig({ target: { type: 'serial', value: '1' } }), /缺少 sub/);
assert.throws(
  () => parseOutreachConfig({ target: { type: 'serial', value: '1' }, sub: 'SaaS' }),
  /keywords 至少需要一个/,
);
assert.throws(
  () => parseOutreachConfig({ target: { type: 'serial', value: '1' }, sub: 'SaaS', keywords: ['k'] }),
  /template 不能为空/,
);
assert.throws(
  () => parseOutreachConfig({ target: { type: 'serial', value: '1' }, sub: 'SaaS', keywords: ['k'], template: 'no user placeholder' }),
  /必须包含 \{username\}/,
);
assert.throws(
  () => parseOutreachConfig({
    target: { type: 'serial', value: '1' }, sub: 'SaaS', keywords: ['k'], template: 'Hi {username}',
    sendIntervalMin: 100, sendIntervalMax: 50,
  }),
  /sendIntervalMax 必须 >= sendIntervalMin/,
);
assert.throws(
  () => parseOutreachConfig({ target: { type: 'bad', value: 'x' }, sub: 'SaaS', keywords: ['k'], template: 'Hi {username}' }),
  /target\.type 必须是/,
);

console.log('config tests passed');