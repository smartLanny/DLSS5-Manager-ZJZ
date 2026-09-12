'use strict';

// Keep the completed file operation separate from the follow-up UI refresh.
// A transient scan failure must not turn a successful install into a failure.
async function executeUiAction(work, refresh = null) {
  let value;
  try {
    value = await work();
  } catch (error) {
    return { completed: false, error };
  }

  let refreshError = null;
  if (typeof refresh === 'function') {
    try {
      await refresh();
    } catch (error) {
      refreshError = error;
    }
  }
  return { completed: true, value, refreshError };
}

// Confirmed actions need to inspect a failed IPC envelope so that the
// anti-cheat confirmation can be shown, but must keep a successful envelope
// intact for runAction(), which performs the single final unwrap.
async function resolveUiEnvelope(work, unwrap) {
  const result = await work();
  if (result && result.ok === true) return result;
  return unwrap(result);
}

if (typeof module !== 'undefined' && module.exports) module.exports = { executeUiAction, resolveUiEnvelope };
else {
  window.executeUiAction = executeUiAction;
  window.resolveUiEnvelope = resolveUiEnvelope;
}
