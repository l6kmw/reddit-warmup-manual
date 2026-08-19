const adsPowerApi = require('./adsPowerApi');
const connector = require('./connector');
const profileProcesses = require('./profileProcesses');
const { logger: defaultLogger } = require('./logger');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function uniqueProfileIds(profileIds) {
  const seen = new Set();
  const result = [];
  for (const value of profileIds ?? []) {
    const profileId = String(value ?? '').trim();
    if (profileId && !seen.has(profileId)) {
      seen.add(profileId);
      result.push(profileId);
    }
  }
  return result;
}

class MachineManager {
  constructor({ concurrency = 2, api = adsPowerApi, connect = connector.connectWithRetry,
    disconnect = connector.disconnect, closeProcess = connector.closeProcess,
    getContext = connector.getContext, processes = profileProcesses,
    logger = defaultLogger, connectOptions = {}, stopStartedProfiles = true,
    stopDelayMs = 250, stopVerifyAttempts = 60, stopVerifyIntervalMs = 500 } = {}) {
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new Error('machine concurrency 必须是大于 0 的整数');
    }
    this.concurrency = concurrency;
    this.api = api;
    this.connectBrowser = connect;
    this.disconnectBrowser = disconnect;
    this.closeBrowserProcess = closeProcess;
    this.getBrowserContext = getContext;
    this.profileProcesses = processes;
    this.logger = logger;
    this.connectOptions = connectOptions;
    this.stopStartedProfiles = Boolean(stopStartedProfiles);
    this.stopDelayMs = stopDelayMs;
    this.stopVerifyAttempts = stopVerifyAttempts;
    this.stopVerifyIntervalMs = stopVerifyIntervalMs;
    this.machines = new Map();
    // Record immediately after startProfile succeeds so CDP failures can roll back.
    this.startedProfileIds = new Set();
    this.closing = false;
  }

  /**
   * Resolve an explicit profile list and/or every profile in an AdsPower group,
   * and/or profiles by client serial_number (the number shown in the AdsPower UI).
   * IDs are de-duplicated while preserving explicit-ID order.
   */
  async resolveProfiles({ profileIds = [], serialNumbers = [], groupName } = {}) {
    const explicitIds = uniqueProfileIds(profileIds);
    const serialValues = uniqueProfileIds(serialNumbers);
    const wantedSerials = serialValues.map(Number);
    const invalidSerials = serialValues.filter((value, index) =>
      !Number.isInteger(wantedSerials[index]) || wantedSerials[index] < 1);
    if (invalidSerials.length) {
      throw new Error(`AdsPower serial 必须是大于 0 的整数: ${invalidSerials.join(', ')}`);
    }

    // 需要查全量列表的情形: 按 serial 选、按 group 选
    const needFullList = wantedSerials.length > 0 || Boolean(groupName);
    let byId = new Map();
    if (needFullList) {
      const all = await this.api.listProfiles();
      byId = new Map(all.map((profile) => [profile.id, profile]));
    }

    const profiles = explicitIds.map((id) => byId.get(id) ?? { id, name: '', groupName: '', serial: null });
    const seen = new Set(explicitIds);

    if (wantedSerials.length) {
      const bySerial = [...byId.values()]
        .filter((profile) => profile.serial != null && wantedSerials.includes(profile.serial))
        .sort((a, b) => a.serial - b.serial);
      const matchedSerials = new Set(bySerial.map((profile) => profile.serial));
      const missingSerials = wantedSerials.filter((serial) => !matchedSerials.has(serial));
      if (missingSerials.length) {
        throw new Error(`未找到 AdsPower serial: ${missingSerials.join(', ')}`);
      }
      for (const profile of bySerial) {
        if (!seen.has(profile.id)) {
          seen.add(profile.id);
          profiles.push(profile);
        }
      }
    }

    if (groupName) {
      const normalizedGroup = String(groupName).trim();
      if (!normalizedGroup) throw new Error('AdsPower group name 不能为空');
      const groupProfiles = [...byId.values()].filter((profile) => profile.groupName === normalizedGroup);
      for (const profile of groupProfiles) {
        if (!seen.has(profile.id)) {
          seen.add(profile.id);
          profiles.push(profile);
        }
      }
    }
    return profiles;
  }

  /**
   * Start/attach multiple independent AdsPower machines. A machine is exactly one
   * profile and owns its own Playwright Browser, BrowserContext, and session record.
   * Individual failures are returned without cancelling healthy machines.
   */
  async connectProfiles(profileIds, { requireMultiple = true } = {}) {
    const ids = uniqueProfileIds(profileIds);
    if (requireMultiple && ids.length < 2) {
      throw new Error(`Phase 2 多机器至少需要 2 个不同的 AdsPower profiles；当前仅选择 ${ids.length} 个。单 profile 多 page 不算多机器。`);
    }
    if (!ids.length) throw new Error('没有选择 AdsPower profile');
    if (this.closing) throw new Error('MachineManager 正在清理');

    const results = new Array(ids.length);
    let nextIndex = 0;
    const worker = async () => {
      while (true) {
        const index = nextIndex++;
        if (index >= ids.length) return;
        const profileId = ids[index];
        try {
          const machine = await this._connectMachine(profileId);
          results[index] = { profileId, status: 'fulfilled', machine };
        } catch (error) {
          // Do not log the raw connector error: Playwright/CDP errors may include a
          // local endpoint. Callers receive the error object for programmatic handling.
          this.logger.error('machine.connect_failed', { profileId, errorName: error.name });
          results[index] = { profileId, status: 'rejected', reason: error };
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.concurrency, ids.length) }, worker));

    const machines = results.filter((result) => result.status === 'fulfilled').map((result) => result.machine);
    const errors = results.filter((result) => result.status === 'rejected');
    return {
      requested: ids.length,
      succeeded: machines.length,
      failed: errors.length,
      machines,
      errors,
      results,
    };
  }

  async connectSelection(selection, options) {
    const profiles = await this.resolveProfiles(selection);
    return this.connectProfiles(profiles.map((profile) => profile.id), options);
  }

  /** Connect one profile for diagnostics or workflows that intentionally run serially. */
  async connectMachine(profileId) {
    const [id] = uniqueProfileIds([profileId]);
    if (!id) throw new Error('profileId 不能为空');
    if (this.closing) throw new Error('MachineManager 正在清理');
    return this._connectMachine(id);
  }

  async _connectMachine(profileId) {
    if (this.machines.has(profileId)) return this.machines.get(profileId);
    let browser;
    let startedHere = false;
    try {
      const activePort = await this.api.getDebugPort(profileId);
      let port = activePort;
      if (!port) {
        // AdsPower can lose track of a live SunBrowser process and falsely report
        // Inactive. Never claim ownership or start a second instance in that case.
        const processRunning = await this._profileProcessRunning(profileId);
        if (processRunning === true) {
          throw new Error(`profile ${profileId} 的浏览器进程仍在运行，但 AdsPower API 报告未启动；请先清理残留进程`);
        }
        // Mark ownership before the request: AdsPower may start the profile but
        // return an incomplete/failed response, which still requires rollback.
        startedHere = true;
        this.startedProfileIds.add(profileId);
        port = await this.api.startProfile(profileId, { openTabs: true });
      }
      browser = await this.connectBrowser(port, this.connectOptions);
      const context = this.getBrowserContext(browser);
      const machine = Object.freeze({
        profileId,
        browser,
        context,
        session: Object.freeze({ profileId }),
        startedByManager: startedHere,
      });
      this.machines.set(profileId, machine);
      this.logger.info('machine.connected', { profileId, reusedRunningProfile: Boolean(activePort) });
      return machine;
    } catch (error) {
      if (browser) await this.disconnectBrowser(browser).catch(() => {});
      if (startedHere && this.stopStartedProfiles) {
        await this._stopStartedProfile(profileId).catch((stopError) => {
          this.logger.error('machine.rollback_stop_failed', {
            profileId,
            errorName: stopError.name,
          });
        });
      }
      throw error;
    }
  }

  async _profileProcessRunning(profileId) {
    if (!this.profileProcesses || typeof this.profileProcesses.isRunning !== 'function') return null;
    try {
      return await this.profileProcesses.isRunning(profileId);
    } catch (error) {
      this.logger.warn('machine.process_check_failed', { profileId, errorName: error.name });
      return null;
    }
  }

  async _waitForProfileProcessExit(profileId, attempts = this.stopVerifyAttempts) {
    let running = await this._profileProcessRunning(profileId);
    for (let attempt = 0; running === true && attempt < attempts; attempt += 1) {
      if (this.stopVerifyIntervalMs > 0) await sleep(this.stopVerifyIntervalMs);
      running = await this._profileProcessRunning(profileId);
    }
    return running;
  }

  async _stopStartedProfile(profileId, { browser } = {}) {
    if (!this.startedProfileIds.has(profileId)) return false;

    let apiError = null;
    try {
      await this.api.stopProfile(profileId);
    } catch (error) {
      apiError = error;
      this.logger.warn('machine.profile_stop_api_failed', { profileId, errorName: error.name });
    }

    // A supported process inspector is the source of truth. AdsPower may claim
    // Inactive while the profile window and SunBrowser process remain alive.
    let running = await this._waitForProfileProcessExit(
      profileId,
      apiError ? 0 : this.stopVerifyAttempts
    );
    let fallback = null;

    if (running === true && browser && typeof this.closeBrowserProcess === 'function') {
      try {
        await this.closeBrowserProcess(browser);
        fallback = 'cdp';
      } catch (error) {
        this.logger.warn('machine.profile_stop_cdp_failed', { profileId, errorName: error.name });
      }
      running = await this._waitForProfileProcessExit(profileId, 10);
    }

    if (running === true && this.profileProcesses && typeof this.profileProcesses.terminate === 'function') {
      const terminated = await this.profileProcesses.terminate(profileId);
      fallback = terminated?.forced ? 'process-kill' : 'process-term';
      running = await this._profileProcessRunning(profileId);
    }

    const verifiedStopped = running === false;
    const apiOnlySuccess = running == null && !apiError;
    if (!verifiedStopped && !apiOnlySuccess) {
      const error = new Error(
        running === true
          ? `profile ${profileId} 的浏览器进程未关闭`
          : `无法确认 profile ${profileId} 已关闭: ${apiError?.message || '状态不可用'}`
      );
      error.cause = apiError || undefined;
      throw error;
    }

    this.startedProfileIds.delete(profileId);
    this.logger.info('machine.profile_stopped', {
      profileId,
      verifiedByProcess: verifiedStopped,
      fallback,
    });
    return true;
  }

  /** Select one existing controllable page, creating a page only if none exists. */
  async getMainPage(machine) {
    const pages = machine.context.pages().filter((page) => !page.isClosed());
    return pages.find((page) => /^(about:blank|chrome:\/\/newtab\/?)/.test(page.url()))
      ?? pages[0]
      ?? machine.context.newPage();
  }

  async disconnectMachine(profileId) {
    const machine = this.machines.get(profileId);
    if (!machine) return false;
    let stopError = null;
    let disconnectError = null;
    try {
      // Keep CDP attached until the AdsPower stop has been verified so Browser.close
      // remains available as a graceful fallback.
      if (this.stopStartedProfiles && machine.startedByManager) {
        await this._stopStartedProfile(profileId, { browser: machine.browser });
      }
    } catch (error) {
      stopError = error;
    }
    try {
      await this.disconnectBrowser(machine.browser);
    } catch (error) {
      disconnectError = error;
    } finally {
      this.machines.delete(profileId);
    }
    if (stopError || disconnectError) {
      throw stopError || disconnectError;
    }
    this.logger.info('machine.disconnected', { profileId });
    return true;
  }

  async closeAll() {
    this.closing = true;
    const profileIds = [...this.machines.keys()];
    const allOwnedIds = new Set([...profileIds, ...this.startedProfileIds]);
    const outcomes = new Map();

    // Stop sequentially to stay below AdsPower's local API rate limit.
    for (const id of profileIds) {
      try {
        const value = await this.disconnectMachine(id);
        outcomes.set(id, { profileId: id, status: 'fulfilled', value });
      } catch (reason) {
        outcomes.set(id, { profileId: id, status: 'rejected', reason });
      }
      if (this.stopDelayMs > 0) await sleep(this.stopDelayMs);
    }

    // Retry profiles started before a failed CDP attachment or a failed first stop.
    // Only the final outcome is returned, so a successful retry is not misreported
    // merely because the first attempt failed.
    if (this.stopStartedProfiles) {
      for (const id of [...this.startedProfileIds]) {
        try {
          const value = await this._stopStartedProfile(id);
          outcomes.set(id, { profileId: id, status: 'fulfilled', value });
        } catch (reason) {
          outcomes.set(id, { profileId: id, status: 'rejected', reason });
        }
        if (this.stopDelayMs > 0) await sleep(this.stopDelayMs);
      }
    }

    for (const id of allOwnedIds) {
      if (!outcomes.has(id)) outcomes.set(id, { profileId: id, status: 'fulfilled', value: false });
    }
    const settled = [...outcomes.values()];
    this.logger.info('machine_manager.closed', {
      machineCount: profileIds.length,
      pendingStartedProfiles: this.startedProfileIds.size,
      cleanupFailures: settled.filter((item) => item.status === 'rejected').length,
    });
    return settled;
  }
}

module.exports = { MachineManager, ProfileFleet: MachineManager, uniqueProfileIds };
