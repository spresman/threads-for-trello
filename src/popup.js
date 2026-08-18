'use strict';

const DEFAULTS = {
  nestMode: 'nested',
  maxDepth: 4,
  indentPx: 24,
  autoCollapseAt: 0,
  autoMention: true,
  debug: false,
};

const HINTS = {
  nested: 'Replies nest under whatever you replied to, up to the depth limit.',
  flat: 'Every reply attaches to the top of its thread, so threads stay one level deep.',
};

const fields = {
  nestMode: document.getElementById('nestMode'),
  maxDepth: document.getElementById('maxDepth'),
  indentPx: document.getElementById('indentPx'),
  autoMention: document.getElementById('autoMention'),
  debug: document.getElementById('debug'),
};

const nestHint = document.getElementById('nestHint');

function render(settings) {
  fields.nestMode.value = settings.nestMode;
  fields.maxDepth.value = settings.maxDepth;
  fields.indentPx.value = settings.indentPx;
  fields.autoMention.checked = Boolean(settings.autoMention);
  fields.debug.checked = Boolean(settings.debug);
  nestHint.textContent = HINTS[settings.nestMode] || '';
  fields.maxDepth.disabled = settings.nestMode === 'flat';
}

function save() {
  const next = {
    nestMode: fields.nestMode.value,
    maxDepth: Math.max(1, Math.min(10, Number(fields.maxDepth.value) || DEFAULTS.maxDepth)),
    // Below ~16px the spine curve would land inside the comment it connects to.
    indentPx: Math.max(16, Math.min(64, Number(fields.indentPx.value) || DEFAULTS.indentPx)),
    autoMention: fields.autoMention.checked,
    debug: fields.debug.checked,
  };
  chrome.storage.sync.set(next, () => render(Object.assign({}, DEFAULTS, next)));
}

chrome.storage.sync.get(DEFAULTS, (data) => render(Object.assign({}, DEFAULTS, data)));

for (const el of Object.values(fields)) {
  el.addEventListener('change', save);
}
