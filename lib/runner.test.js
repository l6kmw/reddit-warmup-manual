'use strict';

const assert = require('assert');
const path = require('path');
const { resolveAdsRoot } = require('../engine/lib/resolve-ads');
const {
  selectSubs,
  classifyBannedPage,
  detectBanned,
  selectReplacementSub,
  canReplaceBannedSub,
  renderHumanReport,
  targetArgs,
  writeRuleArgs,
} = require('./runner');

function fixedRng() {
  return 0.5;
}

assert.strictEqual(
  resolveAdsRoot(),
  path.resolve(__dirname, '..', 'engine', 'adspower-browser'),
  '运行时必须优先使用仓库内置的 AdsPower 模块',
);

const repeated = selectSubs({ subMode: 'specified', subs: ['AskReddit'], subCount: 4 }, fixedRng);
assert.deepStrictEqual(repeated, ['AskReddit', 'AskReddit', 'AskReddit', 'AskReddit']);

const cycled = selectSubs({ subMode: 'specified', subs: ['a', 'b'], subCount: 4 }, fixedRng);
assert.strictEqual(cycled.length, 4);
assert.strictEqual(cycled.filter((sub) => sub === 'a').length, 2);
assert.strictEqual(cycled.filter((sub) => sub === 'b').length, 2);

const capped = selectSubs({ subMode: 'specified', subs: ['a', 'b', 'c', 'd', 'e'], subCount: 4 }, fixedRng);
assert.strictEqual(capped.length, 4);
assert.strictEqual(new Set(capped).size, 4);

const remaining = ['b', 'a', 'b'];
const replacement = selectReplacementSub(
  { subMode: 'specified', subs: ['a', 'b'], subCount: 4 },
  fixedRng,
  new Set(['a']),
  remaining,
);
assert.strictEqual(replacement, 'b');
assert.deepStrictEqual(remaining, ['b', 'a', 'b'], '替换不能消耗后续浏览槽位');

const knownGoodReplacement = selectReplacementSub(
  { subMode: 'specified', subs: ['good', 'banned'], subCount: 2 },
  fixedRng,
  new Set(['banned']),
  [],
);
assert.strictEqual(knownGoodReplacement, 'good', '访问过的可用社区仍可作为替换项');

const caseInsensitiveReplacement = selectReplacementSub(
  { subMode: 'specified', subs: ['FBA', 'AmazonSeller'], subCount: 2 },
  fixedRng,
  new Set(['fba']),
  [],
);
assert.strictEqual(caseInsensitiveReplacement, 'AmazonSeller');

assert.deepStrictEqual(
  classifyBannedPage({ title: 'Reddit', text: 'r/FBA has been banned from Reddit' }),
  { banned: true, reason: 'r/fba has been banned from reddit' },
);
assert.strictEqual(classifyBannedPage({ title: 'FBA', text: 'Posts about fulfillment' }).banned, false);

assert.strictEqual(canReplaceBannedSub({ subMode: 'specified', subs: ['a'] }), false);
assert.strictEqual(canReplaceBannedSub({ subMode: 'specified', subs: ['a', 'b'] }), true);
assert.strictEqual(canReplaceBannedSub({ subMode: 'random', subs: [] }), true);

assert.deepStrictEqual(targetArgs({ serial: 4, id: 'profile-4' }), ['--serial', '4']);
assert.deepStrictEqual(targetArgs({ serial: null, id: 'profile-4' }), ['--profiles', 'profile-4']);
assert.deepStrictEqual(
  writeRuleArgs({ amazonseller: { ack: 'hash-1', confirmedUnresolved: ['rule-1'] } }, 'AmazonSeller'),
  ['--rules-ack', 'hash-1', '--confirm-unresolved', 'rule-1'],
);
assert.deepStrictEqual(
  writeRuleArgs({ ecommerce: { ack: 'hash-2', confirmedUnresolved: [], flair: 'Discussion' } }, 'ecommerce', { flair: true }),
  ['--rules-ack', 'hash-2', '--flair', 'Discussion'],
);

const humanReport = renderHumanReport({
  startedAt: '2026-08-17T08:00:00.000Z',
  finishedAt: '2026-08-17T08:05:00.000Z',
  config: {
    target: { type: 'serial', value: '1' },
    subMode: 'random',
    subs: [],
    subCount: 2,
    minMinutesPerSub: 2,
    maxMinutesPerSub: 3,
  },
  summary: { total: 1, ok: 1, reads: 3, upvoted: 2, comments: 0, posts: 0, banned: 1, replacementSubs: 1 },
  results: [{
    serial: 1,
    name: 'Account',
    username: 'tester',
    status: 'done',
    tier: 'T1',
    subs: ['AmazonSeller'],
    reads: 3,
    upvoted: 2,
    dwellSeconds: 125,
    bannedSubs: [{ sub: 'FBA', reason: 'r/fba has been banned from reddit', url: 'https://www.reddit.com/r/FBA/' }],
    replacements: [{ from: 'FBA', to: 'AmazonSeller' }],
  }],
});
assert.match(humanReport, /# Reddit 养号运行报告/);
assert.match(humanReport, /自动切换：r\/FBA → r\/AmazonSeller/);
assert.match(humanReport, /2分钟5秒/);

(async () => {
  const detected = await detectBanned({
    evaluate: async (fn) => {
      const previous = { document: global.document, location: global.location };
      global.document = { body: { innerText: 'This community has been banned' }, title: 'Reddit' };
      global.location = { href: 'https://www.reddit.com/r/FBA/' };
      try {
        return fn();
      } finally {
        global.document = previous.document;
        global.location = previous.location;
      }
    },
  });
  assert.strictEqual(detected.banned, true);
  assert.strictEqual(detected.url, 'https://www.reddit.com/r/FBA/');
  console.log('runner tests passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
