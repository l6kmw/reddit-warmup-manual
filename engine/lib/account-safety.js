'use strict';

function writeBlockReason(info = {}) {
  if (info.challenge) return { code: 'challenged', reason: `检测到风控页 (${info.challenge})，禁止写操作` };
  if (info.loginState === 'unknown') {
    return { code: 'login_unknown', reason: '登录状态暂时无法确认，禁止写操作' };
  }
  if (!info.loggedIn) return { code: 'logged_out', reason: '账号未登录，禁止写操作' };
  if (info.isSuspended === true) return { code: 'suspended', reason: '账号已被封禁，禁止写操作' };
  if (info.shadowbanned === true) return { code: 'shadowbanned', reason: '账号检出 shadowban，禁止写操作' };
  if (info.shadowbanned == null) return { code: 'shadowban_unknown', reason: 'shadowban 状态无法确认，禁止写操作' };
  return null;
}

module.exports = { writeBlockReason };
