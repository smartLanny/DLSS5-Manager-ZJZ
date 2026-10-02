'use strict';
// Runs the installer and conflict suites again with every file hashed on the
// digest worker thread, the path real Core and model files take.
const test = require('node:test');
const assert = require('node:assert/strict');
const digest = require('../src/product/digest-async');
digest.policy.offloadBytes = 1;
require('./installer.test.js');
require('./installer-routing.test.js');
require('./conflicts.test.js');
test.after(() => assert.ok(digest._state().offloaded > 0, 'hashes went through the worker'));
