'use strict';
/**
 * schema.js — 状态文件 schema 版本化（对应优化计划 P1-3）
 *
 * 目标：reports/state/*.json 带版本号，升级结构时向前兼容、可迁移、可回滚。
 *
 * 版本纪律（写入变更纪律）：
 *   - 新增可选字段 = minor，可安全读写（旧版读取新文件只忽略未知字段）
 *   - 删除/重命名字段 = 必须开新版本号 + 迁移脚本
 *   - 任何 schema 变更必须同步更新 schema 校验测试
 *
 * 用法：
 *   const { loadVersioned } = require('../lib/schema');
 *   const data = loadVersioned('comments', { schemaVersion: 1, accounts: {} }, { migrate: true });
 *   if (data.error) { 版本过高/过低，按 data.kind 处理 }
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { STATE_DIR, readState, writeState } = require('./state');

const SUPPORTED_MAX = 1; // 当前支持的最高 schemaVersion

/**
 * 注册式迁移表：{ fromVersion: fn(data) => data }
 * 示例：MIGRATIONS[1] = (d) => ({ ...d, schemaVersion: 2, newField: d.oldField });
 * 迁移前会自动备份为 <name>.json.bak.v<fromVersion>
 */
const MIGRATIONS = {};

/**
 * 带版本检查的加载（对齐 readState 语义：损坏返回 null，不抛异常）
 *
 * @param {string} name 状态文件名（不含 .json）
 * @param {object} defaultValue 默认结构（含 schemaVersion）
 * @param {object} [opts]
 * @param {boolean} [opts.migrate] 是否允许触发迁移（doctor --fix 等场景）
 * @returns {{ok: boolean, data: object|null, kind?: 'upgrade'|'downgrade'|'corrupt'|'ok', error?: string, migrated?: boolean, backup?: string}}
 */
function loadVersioned(name, defaultValue, opts = {}) {
  const { migrate = false } = opts;
  const raw = readState(name, null);
  if (raw === null) {
    // 文件损坏或不存在
    if (fs.existsSync(path.join(STATE_DIR, `${name}.json`))) {
      return { ok: false, data: null, kind: 'corrupt', error: `${name}.json 损坏` };
    }
    return { ok: true, data: defaultValue, kind: 'ok', error: null };
  }

  const version = raw.schemaVersion ?? 1; // 无版本号按 v1 处理
  if (version > SUPPORTED_MAX) {
    return {
      ok: false, data: null, kind: 'upgrade',
      error: `${name}.json 版本 ${version} 高于支持上限 ${SUPPORTED_MAX}（请升级工具）`,
    };
  }

  // 低于当前版本：需要迁移
  if (version < SUPPORTED_MAX) {
    if (!migrate) {
      return {
        ok: false, data: null, kind: 'downgrade',
        error: `${name}.json 版本 ${version} 低于当前 ${SUPPORTED_MAX}（可用 migrate 触发迁移）`,
      };
    }
    try {
      const backup = `${name}.json.bak.v${version}`;
      if (fs.existsSync(path.join(STATE_DIR, `${name}.json`))) {
        fs.copyFileSync(path.join(STATE_DIR, `${name}.json`), path.join(STATE_DIR, backup));
      }
      let data = raw;
      for (let v = version; v < SUPPORTED_MAX; v += 1) {
        const fn = MIGRATIONS[v];
        if (fn) data = fn(data);
      }
      data.schemaVersion = SUPPORTED_MAX;
      writeState(name, data);
      return { ok: true, data, kind: 'ok', migrated: true, backup };
    } catch (error) {
      return { ok: false, data: null, kind: 'downgrade', error: `迁移失败: ${error.message}` };
    }
  }

  return { ok: true, data: { ...defaultValue, ...raw }, kind: 'ok' };
}

/**
 * 注册迁移函数（供各状态文件模块调用）
 * @param {number} fromVersion 从哪个版本迁出
 * @param {(data: object) => object} fn 迁移函数
 */
function registerMigration(fromVersion, fn) {
  MIGRATIONS[fromVersion] = fn;
}

module.exports = { loadVersioned, registerMigration, MIGRATIONS, SUPPORTED_MAX };
