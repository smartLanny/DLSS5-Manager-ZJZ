'use strict';

// Compatibility view of the Unified5 entry in src/shared/core-catalog.js.
// New code should read the catalog instead of naming a Core build here.
const entry = require('../shared/core-catalog').byId('0.5-dline21-unified5');
const ID = entry.id;
const SOURCE = entry.sourceCommit;
const HASHES = entry.addon;
const CHAIN = entry.chain;
const CARRIER = entry.carrier;
const INI = entry.ini;
const CONTRACT = entry.configContract;
module.exports = { ID, SOURCE, HASHES, CHAIN, CARRIER, INI, CONTRACT };
