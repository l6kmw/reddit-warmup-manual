'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createLogger, createLineBuffer } = require('./logger');

const logger = createLogger({ capacity: 10 });
const entry = logger.info('safe', {
  n: -1,
  t: 'invalid',
  level: 'error',
  source: 'runner',
  event: 'test.event',
  runId: 'run-1',
});
assert.strictEqual(entry.n, 0);
assert.notStrictEqual(entry.t, 'invalid');
assert.strictEqual(entry.level, 'info');
assert.strictEqual(entry.source, 'runner');
assert.strictEqual(entry.event, 'test.event');
assert.strictEqual(entry.runId, 'run-1');

const lines = [];
const lineBuffer = createLineBuffer((line) => lines.push(line));
lineBuffer.push('first\n@@STATUS@@{"phase"');
lineBuffer.push(':"done"}\r');
lineBuffer.push('\nlast');
lineBuffer.flush();
assert.deepStrictEqual(lines, ['first', '@@STATUS@@{"phase":"done"}', 'last']);

const invalidDirectory = path.join(os.tmpdir(), `logger-file-${process.pid}-${Date.now()}`);
fs.writeFileSync(invalidDirectory, 'not a directory');
const memoryOnly = createLogger({ directory: invalidDirectory });
assert.doesNotThrow(() => memoryOnly.info('still works'));
fs.unlinkSync(invalidDirectory);

console.log('logger tests passed');
