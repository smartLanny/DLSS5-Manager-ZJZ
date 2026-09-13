'use strict';

(() => {
  const TAB_NAMES = ['enhance', 'graphics', 'advanced'];

  function noopTabs() {
    return {
      select: () => false,
      active: () => null,
      dispose: () => {}
    };
  }

  function mount(host, options = {}) {
    if (!host || typeof host.querySelector !== 'function' ||
        typeof host.addEventListener !== 'function') return noopTabs();
    options = options || {};

    const entries = TAB_NAMES.map(tab => ({
      tab,
      button: host.querySelector(`[data-detail-tab="${tab}"]`),
      panel: host.querySelector(`[data-detail-panel="${tab}"]`)
    })).filter(entry => entry.button && entry.panel);
    const byButton = new Map(entries.map(entry => [entry.button, entry]));
    const available = entries.map(entry => entry.tab);
    const requested = TAB_NAMES.includes(options.initial) ? options.initial : 'enhance';
    let current = available.includes(requested) ? requested : (available[0] || null);
    let disposed = false;
    const onSelect = typeof options.onSelect === 'function' ? options.onSelect : null;

    function apply(tab, focus = false, notify = false) {
      const entry = entries.find(candidate => candidate.tab === tab);
      if (!entry) return false;
      const changed = current !== tab;
      current = tab;
      for (const candidate of entries) {
        const selected = candidate.tab === current;
        candidate.button.setAttribute('aria-selected', selected ? 'true' : 'false');
        candidate.button.tabIndex = selected ? 0 : -1;
        candidate.panel.hidden = !selected;
        candidate.panel.setAttribute('aria-hidden', selected ? 'false' : 'true');
        if ('inert' in candidate.panel) candidate.panel.inert = !selected;
      }
      if (focus && typeof entry.button.focus === 'function') entry.button.focus();
      if (notify && changed && onSelect) onSelect(tab);
      return true;
    }

    function select(tab, optionsForSelect = {}) {
      if (disposed) return false;
      const focus = optionsForSelect && optionsForSelect.focus === true;
      return apply(tab, focus, true);
    }

    function navigate(tab, direction) {
      const index = available.indexOf(tab);
      if (index < 0 || available.length < 1) return;
      const next = direction === 'first'
        ? available[0]
        : direction === 'last'
          ? available[available.length - 1]
          : available[(index + direction + available.length) % available.length];
      select(next, { focus: true });
    }

    function eventEntry(event) {
      const target = event && event.target;
      const button = target && typeof target.closest === 'function'
        ? target.closest('[data-detail-tab]') : null;
      return button ? byButton.get(button) || null : null;
    }

    function handleClick(event) {
      const entry = eventEntry(event);
      if (!entry || entry.button.disabled) return;
      select(entry.tab);
    }

    function handleKeydown(event) {
      const entry = eventEntry(event);
      if (!entry || entry.button.disabled) return;
      const key = event.key;
      if (key === 'ArrowRight' || key === 'ArrowDown') navigate(entry.tab, 1);
      else if (key === 'ArrowLeft' || key === 'ArrowUp') navigate(entry.tab, -1);
      else if (key === 'Home') navigate(entry.tab, 'first');
      else if (key === 'End') navigate(entry.tab, 'last');
      else return;
      event.preventDefault();
    }

    host.addEventListener('click', handleClick);
    host.addEventListener('keydown', handleKeydown);
    for (const entry of entries) {
      if (!entry.button.hasAttribute('role')) entry.button.setAttribute('role', 'tab');
      if (!entry.panel.hasAttribute('role')) entry.panel.setAttribute('role', 'tabpanel');
    }
    apply(current);

    return {
      select,
      active: () => current,
      dispose: () => {
        if (disposed) return;
        disposed = true;
        host.removeEventListener('click', handleClick);
        host.removeEventListener('keydown', handleKeydown);
      }
    };
  }

  const api = { mount };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else if (typeof window !== 'undefined') window.GameDetailTabs = api;
})();
