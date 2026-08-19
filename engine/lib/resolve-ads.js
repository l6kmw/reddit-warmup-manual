#!/usr/bin/env node
/**
 * resolve-ads.js — 解析 adspower-browser skill 的 lib 路径并加载模块
 *
 * 兼容三种安装方式：
 *   1. 仓库内置模块（../adspower-browser，默认）
 *   2. 环境变量 ADSPOWER_BROWSER_SKILL 显式覆盖
 *   3. 全局 symlink/复制（~/.agents/skills/adspower-browser，兼容旧安装）
 *
 * 安全设计（对应 Socket "dynamic require" 告警的收敛）：
 *   adspower-browser 可能以源码目录、全局 symlink 或环境变量指定等
 *   多种方式安装，真实路径只能在运行时确定，因此 require 路径必须
 *   运行时拼接——这是两个 skill 解耦的合理依赖解析，不是远程加载。
 *
 *   为收窄动态加载的作用域，模块导出为显式工厂 loadAdsModules()：
 *   - 模块加载期零副作用（require 本文件不再立即加载依赖）；
 *   - 动态 require 收敛在单个函数内、只执行一次并缓存结果；
 *   - 由各脚本入口显式调用，调用点可审计、可测试、可 mock。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

/** 候选安装位置（按优先级，均来自可信来源：环境变量 / 固定相对路径 / 用户目录） */
function candidateRoots() {
  return [
    path.resolve(__dirname, '..', 'adspower-browser'),
    process.env.ADSPOWER_BROWSER_SKILL,
    path.join(os.homedir(), '.agents', 'skills', 'adspower-browser'),
  ].filter(Boolean);
}

/** 探测 adspower-browser skill 根目录（存在 lib/machineManager.js 即命中） */
function resolveAdsRoot() {
  for (const p of candidateRoots()) {
    if (fs.existsSync(path.join(p, 'lib', 'machineManager.js'))) {
      return p;
    }
  }
  throw new Error(
    '找不到内置 AdsPower 浏览器模块（需要 engine/adspower-browser/lib/machineManager.js）。' +
    '请重新下载完整项目，或用环境变量 ADSPOWER_BROWSER_SKILL=<路径> 指定兼容模块。'
  );
}

let cached = null;

/**
 * 显式加载 adspower-browser 的 lib 模块（惰性 + 单例）。
 * 各脚本在入口处调用一次；模块加载期不做任何 require 副作用。
 * @returns {{ ADS_ROOT: string, machineManager: object, pageActions: object, connector: object, adsPowerApi: object, profileProcesses: object }}
 */
function loadAdsModules() {
  if (!cached) {
    const root = resolveAdsRoot();
    cached = {
      ADS_ROOT: root,
      machineManager: require(path.join(root, 'lib', 'machineManager')),
      pageActions: require(path.join(root, 'lib', 'pageActions')),
      connector: require(path.join(root, 'lib', 'connector')),
      adsPowerApi: require(path.join(root, 'lib', 'adsPowerApi')),
      profileProcesses: require(path.join(root, 'lib', 'profileProcesses')),
    };
  }
  return cached;
}

module.exports = { resolveAdsRoot, loadAdsModules };
