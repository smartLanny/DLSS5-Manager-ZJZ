'use strict';

const fs = require('fs');
const path = require('path');
const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'index.html'), 'utf8');
const renderer = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'renderer.js'), 'utf8');

const idRows = [...html.matchAll(/\bid=["']([^"']+)["']/g)].map(match => match[1]);
const ids = new Set(idRows);
const duplicates = [...new Set(idRows.filter((id, index) => idRows.indexOf(id) !== index))];
const references = new Set([...renderer.matchAll(/\$\('([^']+)'\)/g)].map(match => match[1]));
// Renderer-owned notices intentionally create short-lived controls from fixed
// template strings. Count those declared IDs as part of the same UI contract.
const dynamicIds = new Set([...renderer.matchAll(/\bid=["']([^"']+)["']/g)].map(match => match[1]));
const missing = [...references].filter(id => !ids.has(id) && !dynamicIds.has(id));

if (duplicates.length || missing.length) {
  if (duplicates.length) console.error(`Duplicate HTML ids: ${duplicates.join(', ')}`);
  if (missing.length) console.error(`Renderer references missing HTML ids: ${missing.join(', ')}`);
  process.exit(1);
}

console.log(`UI contract OK: ${ids.size} HTML ids, ${references.size} renderer references.`);
