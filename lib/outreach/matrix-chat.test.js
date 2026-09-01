'use strict';
/**
 * matrix-chat.test.js — Reddit Chat（Matrix）发送模块测试
 * 覆盖：纯函数解析 + mock fetch 网络层全链路 + 错误传播
 */
const assert = require('node:assert/strict');
const matrix = require('./matrix-chat');

// ---- 纯函数：token 解析 ----
{
  assert.strictEqual(matrix.parseAccessToken('{"token":"abc"}'), 'abc');
  assert.strictEqual(matrix.parseAccessToken('{"token":""}'), null);
  assert.strictEqual(matrix.parseAccessToken('not-json'), null);
  assert.strictEqual(matrix.parseAccessToken(null), null);
  assert.strictEqual(matrix.parseAccessToken(''), null);
  assert.strictEqual(matrix.parseAccessToken('{"no_token":1}'), null);
}

// ---- 纯函数：请求体构造 ----
{
  const body = matrix.buildCreateRoomBody('SomeUser', '@t2_abc:reddit.com');
  assert.deepStrictEqual(body.invite, ['@t2_abc:reddit.com']);
  assert.strictEqual(body.is_direct, true);
  assert.strictEqual(body.preset, 'trusted_private_chat');
  assert.strictEqual(body.name, 'SomeUser');
  assert.deepStrictEqual(matrix.buildMessageBody('hello'), { msgtype: 'm.text', body: 'hello' });
}

// ---- 纯函数：响应解析 ----
{
  assert.strictEqual(
    matrix.parseSearchResultUserId({ results: [{ user_id: '@t2_a:reddit.com', display_name: 'SomeUser' }] }, 'SomeUser'),
    '@t2_a:reddit.com',
    'display_name 精确匹配（大小写不敏感）',
  );
  assert.strictEqual(
    matrix.parseSearchResultUserId({ results: [{ user_id: '@t2_a:reddit.com', display_name: 'someuser' }] }, 'SomeUser'),
    '@t2_a:reddit.com',
  );
  assert.strictEqual(
    matrix.parseSearchResultUserId({ results: [{ user_id: '@t2_b:reddit.com', display_name: 'Other' }] }, 'SomeUser'),
    null,
    '无精确匹配且多结果时不猜',
  );
  assert.strictEqual(
    matrix.parseSearchResultUserId({ results: [{ user_id: '@t2_c:reddit.com', display_name: 'OnlyOne' }] }, 'OnlyOne'),
    '@t2_c:reddit.com',
    '单结果且精确匹配时采用',
  );
  assert.strictEqual(
    matrix.parseSearchResultUserId({ results: [{ user_id: '@t2_b:reddit.com', display_name: 'Other' }] }, 'SomeUser'),
    null,
    '单结果但不匹配时不猜（防发错人）',
  );
  assert.strictEqual(matrix.parseSearchResultUserId(null, 'x'), null);
  assert.strictEqual(matrix.parseSearchResultUserId({ results: [] }, 'x'), null);
}

{
  assert.strictEqual(matrix.parseCreateRoomId({ room_id: '!abc:reddit.com' }), '!abc:reddit.com');
  assert.strictEqual(matrix.parseCreateRoomId({}), null);

  const ok = matrix.parseSendResponse({ event_id: '$evt1' });
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(ok.eventId, '$evt1');

  const err = matrix.parseSendResponse({ errcode: 'M_FORBIDDEN', error: 'nope' });
  assert.strictEqual(err.ok, false);
  assert.match(err.error, /M_FORBIDDEN/);

  assert.strictEqual(matrix.parseSendResponse(null).ok, false);
  assert.strictEqual(matrix.parseSendResponse({ foo: 1 }).ok, false);

  assert.match(matrix.matrixFetchError(401, { errcode: 'M_UNKNOWN_TOKEN' }), /M_UNKNOWN_TOKEN/);
  assert.match(matrix.matrixFetchError(500, null), /http_500/);
}

// ---- isUsableDisplayName ----
{
  assert.strictEqual(matrix.isUsableDisplayName('RealUser'), true);
  assert.strictEqual(matrix.isUsableDisplayName('Initial-One-5308'), true);
  assert.strictEqual(matrix.isUsableDisplayName('t2_1qwk'), false, 't2_ 假名不可用');
  assert.strictEqual(matrix.isUsableDisplayName('@t2_xxx:reddit.com'), false, 'Matrix id 不可用');
  assert.strictEqual(matrix.isUsableDisplayName(null), false);
  assert.strictEqual(matrix.isUsableDisplayName(''), false);
}

// ---- 网络层：mock fetch（含 await，包在 async main 中执行） ----

function mockFetch(handler) {
  return async (url, options) => {
    const record = { url: String(url), method: options.method, auth: options.headers['Authorization'], body: options.body ? JSON.parse(options.body) : null };
    const result = await handler(record);
    return {
      ok: result.status >= 200 && result.status < 300,
      status: result.status,
      json: async () => result.json,
    };
  };
}

async function networkTests() {
  {
    // resolveUserId：请求形状 + 响应解析
    let seen = null;
    const fetchImpl = mockFetch((rec) => {
      seen = rec;
      return { status: 200, json: { results: [{ user_id: '@t2_xyz:reddit.com', display_name: 'Tester' }] } };
    });
    const out = await matrix.resolveUserId('tok', 'Tester', { fetchImpl });
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.userId, '@t2_xyz:reddit.com');
    assert.strictEqual(seen.method, 'POST');
    assert.match(seen.url, /user_directory\/search$/);
    assert.strictEqual(seen.auth, 'Bearer tok');
    assert.deepStrictEqual(seen.body, { search_term: 'Tester', limit: 5 });
  }

  {
    // 搜索失败错误传播
    const fetchImpl = mockFetch(() => ({ status: 401, json: { errcode: 'M_UNKNOWN_TOKEN' } }));
    const out = await matrix.resolveUserId('bad', 'Tester', { fetchImpl });
    assert.strictEqual(out.ok, false);
    assert.match(out.error, /M_UNKNOWN_TOKEN/);
  }

  {
    // 找不到用户
    const fetchImpl = mockFetch(() => ({ status: 200, json: { results: [] } }));
    const out = await matrix.resolveUserId('tok', 'NoOne', { fetchImpl });
    assert.strictEqual(out.ok, false);
    assert.match(out.error, /user_not_found/);
  }

  {
    // createDirectRoom：请求体 + room_id 解析
    let seen = null;
    const fetchImpl = mockFetch((rec) => {
      seen = rec;
      return { status: 200, json: { room_id: '!room1:reddit.com' } };
    });
    const out = await matrix.createDirectRoom('tok', 'Tester', '@t2_xyz:reddit.com', { fetchImpl });
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.roomId, '!room1:reddit.com');
    assert.strictEqual(seen.body.is_direct, true);
    assert.deepStrictEqual(seen.body.invite, ['@t2_xyz:reddit.com']);
  }

  {
    // sendMatrixMessage：PUT 到 room/send + event_id
    let seen = null;
    const fetchImpl = mockFetch((rec) => {
      seen = rec;
      return { status: 200, json: { event_id: '$evt9' } };
    });
    const out = await matrix.sendMatrixMessage('tok', '!room1:reddit.com', 'hi there', { fetchImpl });
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.eventId, '$evt9');
    assert.strictEqual(seen.method, 'PUT');
    assert.match(seen.url, /rooms\/!room1%3Areddit\.com\/send\/m\.room\.message\//);
    assert.deepStrictEqual(seen.body, { msgtype: 'm.text', body: 'hi there' });
  }

  {
    // send 错误传播
    const fetchImpl = mockFetch(() => ({ status: 400, json: { errcode: 'M_UNAUTHORIZED', error: 'no' } }));
    const out = await matrix.sendMatrixMessage('tok', '!r:reddit.com', 'x', { fetchImpl });
    assert.strictEqual(out.ok, false);
    assert.match(out.error, /M_UNAUTHORIZED/);
  }

  {
    // sendChatToUsername 全链路成功
    let calls = [];
    const fetchImpl = mockFetch((rec) => {
      calls.push(rec);
      if (rec.url.includes('user_directory')) return { status: 200, json: { results: [{ user_id: '@t2_abc:reddit.com', display_name: 'Bob' }] } };
      if (rec.url.includes('createRoom')) return { status: 200, json: { room_id: '!roomX:reddit.com' } };
      return { status: 200, json: { event_id: '$evtX' } };
    });
    const out = await matrix.sendChatToUsername('tok', 'Bob', 'msg body', { fetchImpl });
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.userId, '@t2_abc:reddit.com');
    assert.strictEqual(out.roomId, '!roomX:reddit.com');
    assert.strictEqual(out.eventId, '$evtX');
    assert.strictEqual(out.stage, 'done');
    assert.strictEqual(calls.length, 3, 'search + createRoom + send 三次请求');
  }

  {
    // sendChatToUsername：用户找不到时失败且不建房间
    const fetchImpl = mockFetch(() => ({ status: 200, json: { results: [] } }));
    const out = await matrix.sendChatToUsername('tok', 'Ghost', 'x', { fetchImpl });
    assert.strictEqual(out.ok, false);
    assert.strictEqual(out.stage, 'resolve');
  }

  {
    // resolveUsername：profile 返回 t2_ 假名时回退到消息体
    const fetchImpl = mockFetch((rec) => {
      if (rec.url.includes('/members')) return { status: 200, json: { chunk: [{ state_key: '@t2_peer:reddit.com', content: { membership: 'join', displayname: 't2_peer' } }] } };
      if (rec.url.includes('/profile/')) return { status: 200, json: { displayname: 't2_1qwk' } };
      return { status: 200, json: {} };
    });
    const out = await matrix.resolveUsername('tok', {
      roomId: '!r:reddit.com',
      displayName: null,
      recentMessages: [{ sender: '@t2_me:reddit.com', body: 'Hi Initial-One-5308, welcome!' }],
    }, { me: '@t2_me:reddit.com', fetchImpl });
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.username, 'Initial-One-5308', '从消息体兜底取到正确用户名');
    assert.strictEqual(out.source, 'message_body');
  }

  {
    // resolveUsername：sync displayName 可用则直接用
    const out = await matrix.resolveUsername('tok', { roomId: '!r:reddit.com', displayName: 'RealUser' }, {});
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.username, 'RealUser');
    assert.strictEqual(out.source, 'sync_state');
  }

  {
    // isUsableDisplayName 过滤后 profile 也可用
    const fetchImpl = mockFetch((rec) => {
      if (rec.url.includes('/members')) return { status: 200, json: { chunk: [{ state_key: '@t2_peer:reddit.com', content: { membership: 'join' } }] } };
      if (rec.url.includes('/profile/')) return { status: 200, json: { displayname: 'StandByTheJAMs' } };
      return { status: 200, json: { chunk: [] } };
    });
    const out = await matrix.resolveUsername('tok', { roomId: '!r:reddit.com', displayName: null, recentMessages: [] }, { me: '@t2_me:reddit.com', fetchImpl });
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.username, 'StandByTheJAMs');
    assert.strictEqual(out.source, 'profile');
  }

  // ---- 浏览器层 ----
  {
    const out = await matrix.readAccessTokenFromPage(null);
    assert.strictEqual(out.ok, false);
    assert.strictEqual(out.error, 'no_page');
  }

  {
    // page mock：localStorage 有 token
    const page = {
      evaluate: async (fn, key) => (key === 'chat:access-token' ? '{"token":"tok123"}' : null),
    };
    const out = await matrix.readAccessTokenFromPage(page);
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.token, 'tok123');
  }

  {
    // page mock：无 token
    const page = { evaluate: async () => null };
    const out = await matrix.readAccessTokenFromPage(page);
    assert.strictEqual(out.ok, false);
    assert.strictEqual(out.error, 'matrix_token_missing');
  }
}

(async () => {
  await networkTests();
  console.log('matrix-chat tests passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});