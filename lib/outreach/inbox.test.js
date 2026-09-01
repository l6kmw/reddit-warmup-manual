'use strict';
/**
 * inbox.test.js — 收信轮询增量检测测试
 */
const assert = require('node:assert/strict');
const inbox = require('./inbox');

const ME = '@t2_me:reddit.com';

function thread(roomId, message, sender = '@t2_peer:reddit.com', ts = '2026-09-01T03:00:00.000Z') {
  return {
    roomId,
    lastMessage: message ? { body: message, sender, ts } : null,
  };
}

function conv(username, roomId, replyHistory = []) {
  return { username, roomId, replyHistory };
}

// ---- 新消息检测 ----
{
  const threads = [thread('!a:reddit.com', 'how are you', '@t2_x:reddit.com', '2026-09-01T03:00:00.000Z')];
  const convList = [conv('UserA', '!a:reddit.com', [{ from: 'me', body: 'Hi', ts: '2026-09-01T02:00:00.000Z' }])];
  const replies = inbox.findNewReplies(threads, convList, { me: ME });
  assert.strictEqual(replies.length, 1);
  assert.strictEqual(replies[0].username, 'UserA');
  assert.strictEqual(replies[0].message, 'how are you');
}

// ---- 自己发的消息不视为新 ----
{
  const threads = [thread('!a:reddit.com', 'Hi UserA', ME, '2026-09-01T03:00:00.000Z')];
  const convList = [conv('UserA', '!a:reddit.com')];
  assert.strictEqual(inbox.findNewReplies(threads, convList, { me: ME }).length, 0);
}

// ---- 时间 <= 历史最后一条 → 不新（幂等） ----
{
  const threads = [thread('!a:reddit.com', 'already seen', '@t2_x:reddit.com', '2026-09-01T02:30:00.000Z')];
  const convList = [conv('UserA', '!a:reddit.com', [{ from: 'them', body: 'already seen', ts: '2026-09-01T02:30:00.000Z' }])];
  assert.strictEqual(inbox.findNewReplies(threads, convList, { me: ME }).length, 0, '已入历史不重复');
}

// ---- 无会话记录的房间跳过 ----
{
  const threads = [thread('!stranger:reddit.com', 'hello there', '@t2_z:reddit.com')];
  assert.strictEqual(inbox.findNewReplies(threads, [], { me: ME }).length, 0);
}

// ---- 空消息/空线程容错 ----
{
  assert.strictEqual(inbox.findNewReplies(null, [], { me: ME }).length, 0);
  assert.strictEqual(inbox.findNewReplies([thread('!a:reddit.com', null)], [], { me: ME }).length, 0);
  assert.strictEqual(inbox.findNewReplies([], null, { me: ME }).length, 0);
  assert.strictEqual(inbox.findNewReplies([thread('!a:reddit.com', '', '@t2_x:reddit.com')], [], { me: ME }).length, 0);
}

// ---- 多条新回复 + me 缺失时 ----
{
  const threads = [
    thread('!a:reddit.com', 'hi1', '@t2_x:reddit.com', '2026-09-01T03:01:00.000Z'),
    thread('!b:reddit.com', 'hi2', '@t2_y:reddit.com', '2026-09-01T03:02:00.000Z'),
    thread('!c:reddit.com', 'self', ME, '2026-09-01T03:03:00.000Z'),
  ];
  const convList = [conv('A', '!a:reddit.com', []), conv('B', '!b:reddit.com', []), conv('C', '!c:reddit.com', [])];
  const replies = inbox.findNewReplies(threads, convList, { me: ME });
  assert.strictEqual(replies.length, 2, '两条对方新消息，自己发的排除');
  assert.deepStrictEqual(replies.map((r) => r.username), ['A', 'B']);
}

console.log('inbox tests passed');