'use strict';

// Locks describe the resource being changed, not the page initiating the work.
function createWorkScheduler() {
  const queues = new Map();
  function run(key, work) {
    const previous = queues.get(key) || Promise.resolve();
    const result = previous.catch(() => {}).then(work);
    const tail = result.catch(() => {});
    queues.set(key, tail);
    void tail.finally(() => { if (queues.get(key) === tail) queues.delete(key); });
    return result;
  }
  return { run, get size() { return queues.size; } };
}
module.exports = { createWorkScheduler };
