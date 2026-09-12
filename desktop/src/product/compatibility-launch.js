'use strict';

// Optional feedback collection has a short budget and cannot hold the game launch.
// A timed-out capture must also reject its late result as a pre-launch snapshot.
async function captureCompatibilitySnapshot(feedback, id, session, { timeoutMs = 3000, log = () => {} } = {}) {
  if (!feedback?.captureLaunch) return;
  let cancelled = false, timer;
  const controls = { cancelled: () => cancelled };
  try {
    const deadline = new Promise(resolve => {
      timer = setTimeout(() => { cancelled = true; resolve({ unavailable: 'TIMEOUT' }); }, timeoutMs);
    });
    const capture = Promise.resolve().then(() => feedback.captureLaunch(id, session, controls))
      .then(() => ({}), error => ({ unavailable: error?.code || 'UNAVAILABLE' }));
    const result = await Promise.race([capture, deadline]);
    if (result.unavailable) log('compatibility-snapshot-unavailable', { code: result.unavailable });
  } finally {
    cancelled = true;
    clearTimeout(timer);
  }
}

module.exports = { captureCompatibilitySnapshot };
