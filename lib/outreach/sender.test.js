'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

// 隔离测试：sender 的锁/队列状态全部重定向到临时目录
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'outreach-sender-test-'));
process.env.OUTREACH_STATE_DIR = TMP_DIR;

const sender = require('./sender');
const queue = require('./queue');

const {
  acquireLock,
  releaseLock,
  runRemaining,
  selectPendingBatch,
  shouldPauseAfterFailure,
  renderDelayMs,
  graphqlDataErrors,
} = sender;

// ---- graphqlDataErrors：GraphQL 响应错误信号检测 ----
{
  assert.strictEqual(
    graphqlDataErrors({ sendDirectChatToRedditor: { ok: true, errors: null } }),
    null,
    '{"errors":null} 是成功，不误报',
  );
  assert.strictEqual(
    graphqlDataErrors({ sendDirectChatToRedditor: { ok: true, errors: [] } }),
    null,
    '{"errors":[]} 是成功，不误报',
  );
  assert.strictEqual(
    graphqlDataErrors({ a: { b: { ok: true, errors: null } }, c: { done: true } }),
    null,
    '嵌套 errors:null 不误报',
  );
  const realErr = graphqlDataErrors({ sendDirectChatToRedditor: { ok: false, errors: [{ message: 'nope' }] } });
  assert.ok(realErr && realErr.length === 1 && /nonempty_error/.test(realErr[0].signal), '非空 errors 判定为错误');
  const nullField = graphqlDataErrors({ sendMessage: null });
  assert.ok(nullField && nullField.length === 1 && nullField[0].signal === 'null_value', '顶层 null 字段判定为错误');
  assert.ok(graphqlDataErrors(null), 'data 为 null 判定为错误');
  const nestedStr = graphqlDataErrors({ a: { error: 'boom' } });
  assert.ok(nestedStr && nestedStr.length === 1, '嵌套 error 字符串判定为错误');
}

// ---- runRemaining ----
assert.strictEqual(runRemaining(20), 20);
assert.strictEqual(runRemaining(0), 0);
assert.strictEqual(runRemaining(-1), 0, '不会为负');

// ---- selectPendingBatch ----
const pending3 = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

// 单次执行上限只截取本次任务，未选中的仍保留 pending
const capped = selectPendingBatch(pending3, { runLimit: 2 });
assert.deepStrictEqual(capped.toSend.map((i) => i.id), ['a', 'b']);
assert.strictEqual(capped.remaining, 1);

const full = selectPendingBatch(pending3, { runLimit: 10 });
assert.strictEqual(full.toSend.length, 3);
assert.strictEqual(full.remaining, 0);

const zero = selectPendingBatch(pending3, { runLimit: 0 });
assert.strictEqual(zero.toSend.length, 0);
assert.strictEqual(zero.remaining, 3);

// ---- shouldPauseAfterFailure ----
assert.strictEqual(shouldPauseAfterFailure([{ ok: true }, { ok: true }]), false);
assert.strictEqual(shouldPauseAfterFailure([{ ok: false }], { maxConsecutiveFailures: 3 }), false, '1 次失败不暂停');
assert.strictEqual(shouldPauseAfterFailure([{ ok: false }, { ok: false }, { ok: false }], { maxConsecutiveFailures: 3 }), true);
assert.strictEqual(
  shouldPauseAfterFailure([{ ok: true }, { ok: false }, { ok: false }, { ok: false }], { maxConsecutiveFailures: 3 }),
  true,
  '连续失败（刷新连续计数）',
);
assert.strictEqual(
  shouldPauseAfterFailure([{ ok: false }, { ok: true }, { ok: false }, { ok: false }], { maxConsecutiveFailures: 3 }),
  false,
  '成功中断连续失败计数',
);

// ---- renderDelayMs ----
const rng0 = () => 0;
const rng1 = () => 1;
assert.strictEqual(renderDelayMs({ min: 60, max: 120, rng: rng0 }), 60000, '下限 60s');
assert.strictEqual(renderDelayMs({ min: 60, max: 120, rng: rng1 }), 120000, '上限 120s');
assert.strictEqual(renderDelayMs({ min: 60, max: 60, rng: rng1 }), 60000, 'min=max 恒为 60s');
assert.ok(renderDelayMs({ min: 0, max: 5, rng: () => 0.5 }) >= 2500 && renderDelayMs({ min: 0, max: 5, rng: () => 0.5 }) <= 7500);

// ---- 互斥锁（隔离目录） ----
(async () => {
  const lockFile = path.join(TMP_DIR, 'outreach.lock');

  // 首次获取成功
  const first = await acquireLock({ lockFile });
  assert.strictEqual(first.ok, true);

  // 持锁期间再次获取失败（不等待超时）
  const second = await acquireLock({ lockFile, timeoutMs: 0 });
  assert.strictEqual(second.ok, false, '锁被持有，获取失败');

  // 带超时等待：短暂等待后仍失败
  const third = await acquireLock({ lockFile, timeoutMs: 1200 });
  assert.strictEqual(third.ok, false, '等待超时后仍失败');

  // 释放后可重新获取
  assert.strictEqual(releaseLock({ lockFile }), true);
  const fourth = await acquireLock({ lockFile });
  assert.strictEqual(fourth.ok, true);
  releaseLock({ lockFile });

  // 释放不存在的锁不抛错
  assert.strictEqual(releaseLock({ lockFile: path.join(TMP_DIR, 'no-such.lock') }), true);

  console.log('sender tests passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});