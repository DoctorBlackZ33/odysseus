// static/js/settings.js — Settings panel module (ES6)
// User-facing preferences: AI models, search, appearance

import uiModule from './ui.js?v=20260916largetoolscroll1';
import searchModule from './search.js';
import { byId } from './settings/dom.js';
import { postSettings as _postSettings } from './settings/api.js';
import { initTtsSettings, initSttSettings } from './settings/speech.js';
import { initDocumentWritingStyle } from './settings/writingStyle.js';
import { initImageSettings } from './settings/imageModels.js';
import { initAgentSettings } from './settings/agent.js';
import { getSettingsRegistryIssues } from './settings/registry.js';
import { bindSettingsSearch } from './settings/search.js';
import { bindSettingsSidebar } from './settings/sidebar.js';
import { bindSettingsNavigation } from './settings/navigation.js';
import {
  bindSettingsDrag,
  bindSettingsClose,
  bindOpenPromptModalLink,
} from './settings/lifecycle.js';
import { bindSettingsPeekToggle } from './settings/peek.js';
import { createSettingsShell } from './settings/shell.js';
import { handleSettingsOauthReturn } from './settings/oauthReturn.js';
import { sortModelIds } from './modelSort.js';
import { providerLogo } from './providers.js';
import { isAltGrEvent } from './platform.js';
import { bindMenuDismiss } from './escMenuStack.js';
import { invalidateSettings } from './appConfig.js';
import { SEARCH_PROVIDER_LOGOS as _SEARCH_PROVIDER_LOGOS } from './searchProviderIcons.js';

let initialized = false;
let modalEl = null;
let _authPolicy = { password_min_length: 8 };

/**
 * POST a settings patch, then drop the shared snapshot in appConfig.js.
 *
 * Every write in this file goes through here so no save path can forget the
 * invalidation — a stale settings object served for the rest of the session is
 * a worse bug than the duplicate fetches the cache removes. The invalidation is
 * in a `finally` because a request that throws on the way back may still have
 * been applied server-side.
 *
 * Reads in this file deliberately stay direct fetches: this panel is the writer
 * and edits what it reads, so it must see the authoritative state, not a cache.
 */

const el = byId;
function esc(s) { return uiModule.esc(s); }
function safeRasterDataUrl(raw) {
  const value = String(raw || '').trim();
  return /^data:image\/(?:png|jpe?g|gif|webp);base64,[a-z0-9+/=\s]+$/i.test(value) ? value : '';
}

/* ── Settings shell coordination ──
   Panel activation side effects, the admin handoff, admin-only visibility and
   the public open/close API live in ./settings/shell.js. This coordinator only
   supplies the panel-owned pieces the shell needs. */
const _shell = createSettingsShell({
  getModal: () => modalEl,
  ensureInitialized: () => { if (!initialized) initAll(); },
  syncAppearanceCheckboxes: () => syncAppearanceCheckboxes(),
  refreshAiModelEndpoints: () => refreshAiModelEndpoints(),
  isAdmin: () => !!window._isAdmin,
  getAdminModule: () => window.adminModule,
});

// Bind the sidebar entry before lazy Settings initialization.
const openIntegrationsButton = el('sidebar-integrations-btn');
if (openIntegrationsButton && openIntegrationsButton.dataset.bound !== '1') {
  openIntegrationsButton.dataset.bound = '1';
  openIntegrationsButton.addEventListener('click', () => {
    if (window._isAdmin && window.adminModule?.open) window.adminModule.open('integrations');
    else open('integrations');
  });
}

/* ═══════════════════════════════════════════
   AI TAB
   ═══════════════════════════════════════════ */

const _aiEndpointRefreshers = new Set();
let _aiEndpointRefreshInFlight = null;

async function _fetchModelEndpoints() {
  const epRes = await fetch('/api/model-endpoints', { credentials: 'same-origin' });
  if (!epRes.ok) throw new Error(`HTTP ${epRes.status}`);
  const endpoints = await epRes.json();
  return Array.isArray(endpoints) ? endpoints : [];
}

function _selectableEndpointModels(endpoint) {
  if (!endpoint) return [];
  return Array.from(new Set([
    ...(Array.isArray(endpoint.models) ? endpoint.models : []),
    ...(Array.isArray(endpoint.pinned_models) ? endpoint.pinned_models : []),
  ].filter(Boolean).map(String)));
}

function _endpointLabel(ep) {
  return ep.name + (ep.online ? '' : ' (offline)');
}

function _fillEndpointSelect(selectEl, endpoints, selected, keepBlank) {
  if (!selectEl) return;
  const previous = selected !== undefined ? selected : selectEl.value;
  const blankText = keepBlank && selectEl.options[0] && selectEl.options[0].value === ''
    ? selectEl.options[0].textContent
    : null;
  while (selectEl.options.length) selectEl.remove(0);
  if (blankText !== null) {
    const blank = document.createElement('option');
    blank.value = '';
    blank.textContent = blankText;
    selectEl.appendChild(blank);
  }
  (endpoints || []).forEach(function(ep) {
    if (!ep.is_enabled) return;
    const opt = document.createElement('option');
    opt.value = ep.id;
    opt.textContent = _endpointLabel(ep);
    selectEl.appendChild(opt);
  });
  if (previous && Array.from(selectEl.options).some(function(o) { return o.value === previous; })) {
    selectEl.value = previous;
  } else if (blankText !== null) {
    selectEl.value = '';
  }
  _syncEndpointLogo(selectEl);
}

// Mirror the selected model's provider logo into a sibling <span id="<selectId>-logo">.
// Wires the change listener exactly once so we can call this every time the
// select is repopulated without piling on duplicate handlers.
function _syncModelLogo(selectEl) {
  if (!selectEl) return;
  const logoEl = document.getElementById(selectEl.id + '-logo');
  if (!logoEl) return;
  const apply = () => { logoEl.innerHTML = providerLogo(selectEl.value) || ''; };
  apply();
  if (!selectEl.dataset.logoSync) {
    selectEl.dataset.logoSync = '1';
    selectEl.addEventListener('change', apply);
  }
}

// Same idea but for endpoint dropdowns where the <option value="…">
// is an opaque endpoint UUID — fall back to the option's text label
// so providerLogo() can pattern-match (Anthropic, OpenAI, Ollama, …).
function _syncEndpointLogo(selectEl) {
  if (!selectEl) return;
  const logoEl = document.getElementById(selectEl.id + '-logo');
  if (!logoEl) return;
  const apply = () => {
    const opt = selectEl.options[selectEl.selectedIndex];
    const label = (opt && opt.textContent) || selectEl.value || '';
    logoEl.innerHTML = providerLogo(label) || '';
  };
  apply();
  if (!selectEl.dataset.epLogoSync) {
    selectEl.dataset.epLogoSync = '1';
    selectEl.addEventListener('change', apply);
  }
}

function _fillModelSelect(selectEl, models, selected, keepBlank) {
  if (!selectEl) return;
  const previous = selected !== undefined ? selected : selectEl.value;
  const blankText = keepBlank && selectEl.options[0] && selectEl.options[0].value === ''
    ? selectEl.options[0].textContent
    : null;
  while (selectEl.options.length) selectEl.remove(0);
  if (blankText !== null) {
    const blank = document.createElement('option');
    blank.value = '';
    blank.textContent = blankText;
    selectEl.appendChild(blank);
  }
  sortModelIds(models).forEach(function(m) {
    const opt = document.createElement('option');
    opt.value = m;
    opt.textContent = String(m).split('/').pop();
    selectEl.appendChild(opt);
  });
  if (previous && Array.from(selectEl.options).some(function(o) { return o.value === previous; })) {
    selectEl.value = previous;
  } else if (blankText !== null) {
    selectEl.value = '';
  }
  _syncModelLogo(selectEl);
}

function _registerAiEndpointRefresh(fn) {
  _aiEndpointRefreshers.add(fn);
}

export async function refreshAiModelEndpoints() {
  if (_aiEndpointRefreshInFlight) return _aiEndpointRefreshInFlight;
  _aiEndpointRefreshInFlight = (async function() {
    try {
      const endpoints = await _fetchModelEndpoints();
      _aiEndpointRefreshers.forEach(function(fn) {
        try { fn(endpoints); } catch (e) { console.warn('[settings] endpoint refresh handler failed', e); }
      });
    } catch (e) {
      console.warn('[settings] failed to refresh model endpoints', e);
    } finally {
      _aiEndpointRefreshInFlight = null;
    }
  })();
  return _aiEndpointRefreshInFlight;
}

/* Shared fallback-chain widget — mirrors the Default Chat Model fallback UI
 * for other model cards (Utility, Vision, …). Pass in the container/button
 * IDs, the endpoints list, the settings key to persist under, and the
 * model-filter (for Vision we exclude non-chat-capable models).
 */
function _bindFallbackWidget(opts) {
  var fbContainer = el(opts.containerId);
  var addBtn = el(opts.addBtnId);
  var endpointsRef = opts.endpoints;       // mutable list reference
  var modelsFilter = opts.modelsFilter || function() { return true; };
  var settingKey = opts.settingKey;
  var current = opts.initial || [];        // [{endpoint_id, model, reasoning_effort}]
  var supportsEffort = Boolean(opts.supportsEffort);
  var getEffortLevels = opts.getEffortLevels;

  if (!fbContainer || !addBtn) return { setEndpoints: function() {}, setInitial: function() {}, refresh: function() {} };

  function enabledEps() { return (endpointsRef() || []).filter(function(e) { return e.is_enabled; }); }

  function fillModels(selectEl, epId, selected) {
    while (selectEl.options.length) selectEl.remove(0);
    var ep = (endpointsRef() || []).find(function(e) { return e.id === epId; });
    if (ep && ep.models) {
      sortModelIds(ep.models).forEach(function(m) {
        if (!modelsFilter(m, ep)) return;
        var o = document.createElement('option');
        o.value = m;
        o.textContent = m.split('/').pop();
        selectEl.appendChild(o);
      });
    }
    if (selected) selectEl.value = selected;
  }

  function fillEffort(selectEl, epId, modelId, selected) {
    if (!selectEl) return;
    while (selectEl.options.length) selectEl.remove(0);
    var levels = getEffortLevels ? getEffortLevels(epId, modelId) : [];
    var base = document.createElement('option');
    base.value = '';
    base.textContent = 'Provider default';
    selectEl.appendChild(base);
    levels.forEach(function(lvl) {
      var val = typeof lvl === 'string' ? lvl : (lvl && lvl.effort);
      if (val) {
        var o = document.createElement('option');
        o.value = val.toLowerCase();
        o.textContent = val;
        selectEl.appendChild(o);
      }
    });
    var validValues = [''].concat(levels.map(function(l) { return (typeof l === 'string' ? l : l.effort).toLowerCase(); }));
    selectEl.value = validValues.indexOf((selected || '').toLowerCase()) >= 0 ? (selected || '').toLowerCase() : '';
    selectEl.style.display = levels.length > 0 ? '' : 'none';
  }

  async function save() {
    var clean = current.filter(function(f) { return f.endpoint_id && f.model; }).map(function(f) {
      var item = { endpoint_id: f.endpoint_id, model: f.model };
      if (supportsEffort && typeof f.reasoning_effort !== 'undefined') {
        item.reasoning_effort = f.reasoning_effort || '';
      }
      return item;
    });
    var body = {};
    body[settingKey] = clean;
    try {
      await _postSettings(body);
    } catch (e) { console.warn('[fallback] save failed for ' + settingKey, e); }
  }

  function render() {
    fbContainer.innerHTML = '';
    current.forEach(function(fb, idx) {
      var row = document.createElement('div');
      row.className = 'settings-fallback-row';

      var num = document.createElement('span');
      num.className = 'settings-fallback-num';
      num.textContent = (idx + 1) + '.';

      var epS = document.createElement('select');
      epS.className = 'settings-select';
      enabledEps().forEach(function(ep) {
        var o = document.createElement('option');
        o.value = ep.id;
        o.textContent = ep.name + (ep.online ? '' : ' (offline)');
        epS.appendChild(o);
      });
      var first = enabledEps()[0];
      epS.value = fb.endpoint_id || (first ? first.id : '');

      var mS = document.createElement('select');
      mS.className = 'settings-select';
      fillModels(mS, epS.value, fb.model);

      fb.endpoint_id = epS.value;
      fb.model = mS.value;

      var effS = null;
      if (supportsEffort) {
        effS = document.createElement('select');
        effS.className = 'settings-select settings-fallback-effort';
        fillEffort(effS, epS.value, mS.value, fb.reasoning_effort);
        fb.reasoning_effort = effS.value;
        effS.addEventListener('change', function() {
          fb.reasoning_effort = effS.value;
          save();
        });
      }

      epS.addEventListener('change', function() {
        fb.endpoint_id = epS.value;
        fillModels(mS, epS.value, '');
        fb.model = mS.value;
        if (effS) {
          fillEffort(effS, epS.value, mS.value, '');
          fb.reasoning_effort = effS.value;
        }
        save();
      });
      mS.addEventListener('change', function() {
        fb.model = mS.value;
        if (effS) {
          fillEffort(effS, epS.value, mS.value, fb.reasoning_effort);
          fb.reasoning_effort = effS.value;
        }
        save();
      });

      var rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'settings-fallback-remove';
      rm.title = 'Remove fallback';
      rm.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>';
      rm.addEventListener('click', function() {
        current.splice(idx, 1);
        render();
        save();
      });

      row.appendChild(num);
      row.appendChild(epS);
      row.appendChild(mS);
      if (effS) row.appendChild(effS);
      row.appendChild(rm);
      fbContainer.appendChild(row);
    });
  }

  addBtn.addEventListener('click', function() {
    var first = enabledEps()[0];
    current.push({ endpoint_id: first ? first.id : '', model: '', reasoning_effort: '' });
    render();
    save();
  });

  render();

  return {
    setInitial: function(list) { current = (list || []).slice(); render(); },
    refresh: render,
  };
}

/* ── Default Chat Model ── */
async function initDefaultChat() {
  var epSel = el('set-defaultEpSelect');
  var modelSel = el('set-defaultModelSelect');
  var msg = el('set-defaultChatMsg');
  var _endpoints = [];

  // Fill any <select> with the models for a given endpoint id.
  function fillModels(selectEl, epId, selected) {
    var ep = _endpoints.find(function(e) { return e.id === epId; });
    _fillModelSelect(selectEl, _selectableEndpointModels(ep), selected, false);
  }

  try {
    _endpoints = await _fetchModelEndpoints();
    _fillEndpointSelect(epSel, _endpoints, epSel.value, false);
  } catch (e) { console.warn('Failed to load endpoints for default chat', e); }

  function refreshModels(selectedModel) { fillModels(modelSel, epSel.value, selectedModel); }
  function refreshEndpointOptions(selectedEndpoint, selectedModel) {
    _fillEndpointSelect(epSel, _endpoints, selectedEndpoint !== undefined ? selectedEndpoint : epSel.value, false);
    refreshModels(selectedModel !== undefined ? selectedModel : modelSel.value);
  }

  try {
    var res = await fetch('/api/auth/settings', { credentials: 'same-origin' });
    var settings = await res.json();
    if (settings.default_endpoint_id
        && _endpoints.some(function(ep) { return ep.id === settings.default_endpoint_id && ep.is_enabled; })) {
      epSel.value = settings.default_endpoint_id;
    }
    refreshModels(settings.default_model || '');
  } catch (e) { console.warn('Failed to load default chat settings', e); }

  epSel.addEventListener('change', function() { refreshModels(''); saveDefault(); });
  modelSel.addEventListener('change', saveDefault);

  async function saveDefault() {
    try {
      var response = await _postSettings({
        default_endpoint_id: epSel.value,
        default_model: modelSel.value
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      msg.textContent = 'Saved'; msg.style.color = 'var(--fg)';
      setTimeout(function() { msg.textContent = ''; }, 2000);
    } catch (e) { msg.textContent = e.status === 403 ? 'Admin access is required to change these settings.' : 'Failed to save'; msg.style.color = 'var(--red)'; }
  }

  _registerAiEndpointRefresh(function(endpoints) {
    _endpoints = endpoints;
    refreshEndpointOptions(epSel.value, modelSel.value);
  });
}

/* ── Utility Model ── */
async function initUtilityModel() {
  var epSel = el('set-utilityEpSelect');
  var modelSel = el('set-utilityModelSelect');
  var effortSel = el('set-utilityEffortSelect');
  var effortRow = el('set-utilityEffortRow');
  var effortHelp = el('set-utilityEffortHelp');
  var effortQualifier = el('set-utilityEffortQualifier');
  var msg = el('set-utilityChatMsg');
  var _endpoints = [];
  var fallbackWidget = null;
  var _levelsByEndpoint = {};
  if (epSel && epSel.options[0]) epSel.options[0].textContent = 'Same as chat';
  if (modelSel && modelSel.options[0]) modelSel.options[0].textContent = 'Same as chat';

  try {
    _endpoints = await _fetchModelEndpoints();
    _fillEndpointSelect(epSel, _endpoints, epSel.value, true);
  } catch (e) { console.warn('Failed to load endpoints for utility model', e); }

  // Effort levels come from /api/models `models_metadata` (same evidence the
  // chat composer uses); /api/model-endpoints does not carry them.
  async function loadEffortLevels() {
    try {
      var r = await fetch('/api/models', { credentials: 'same-origin' });
      if (!r.ok) return;
      var data = await r.json();
      var items = Array.isArray(data) ? data : (data.models || data.items || []);
      _levelsByEndpoint = {};
      items.forEach(function(item) {
        if (item && item.endpoint_id) _levelsByEndpoint[item.endpoint_id] = item.models_metadata || {};
      });
    } catch (e) { console.warn('Failed to load reasoning levels for utility model', e); }
  }

  function refreshEffort(selected) {
    if (!effortSel) return;
    var targetEp = epSel.value;
    var targetModel = modelSel.value;
    if (!targetEp) {
      var defEp = el('set-defaultEpSelect');
      var defModel = el('set-defaultModelSelect');
      if (defEp) targetEp = defEp.value;
      if (defModel) targetModel = defModel.value;
    }
    var meta = (_levelsByEndpoint[targetEp] || {})[targetModel] || {};
    var levels = Array.isArray(meta.supported_reasoning_levels) ? meta.supported_reasoning_levels.slice() : [];
    var isInherited = !epSel.value;
    if (isInherited && levels.length === 0) {
      var allLevels = {};
      Object.keys(_levelsByEndpoint).forEach(function(epId) {
        var models = _levelsByEndpoint[epId] || {};
        Object.keys(models).forEach(function(mId) {
          var mLevels = (models[mId] || {}).supported_reasoning_levels;
          if (Array.isArray(mLevels)) {
            mLevels.forEach(function(lvl) {
              var val = typeof lvl === 'string' ? lvl : (lvl && lvl.effort);
              if (val) allLevels[val.toLowerCase()] = true;
            });
          }
        });
      });
      levels = Object.keys(allLevels);
      if (levels.length === 0) {
        levels = ['low', 'medium', 'high'];
      }
    }
    while (effortSel.options.length) effortSel.remove(0);
    var base = document.createElement('option');
    base.value = '';
    base.textContent = isInherited ? 'Same as chat' : 'Provider default';
    if (effortQualifier) effortQualifier.style.display = isInherited ? '' : 'none';
    effortSel.appendChild(base);
    if (isInherited) {
      var offOpt = document.createElement('option');
      offOpt.value = 'off';
      offOpt.textContent = 'Provider default';
      effortSel.appendChild(offOpt);
    }
    levels.forEach(function(level) {
      var opt = document.createElement('option');
      opt.value = level;
      opt.textContent = level;
      effortSel.appendChild(opt);
    });
    var validValues = [''].concat(isInherited ? ['off'] : []).concat(levels);
    effortSel.value = validValues.indexOf(selected) >= 0 ? selected : '';
    var show = isInherited || levels.length > 0;
    if (effortRow) effortRow.style.display = show ? '' : 'none';
    if (effortHelp) effortHelp.style.display = show ? '' : 'none';
  }

  function refreshModels(selectedModel) {
    var epId = epSel.value;
    var ep = _endpoints.find(function(e) { return e.id === epId; });
    _fillModelSelect(modelSel, ep ? ep.models : [], selectedModel, true);
  }

  await loadEffortLevels();

  try {
    var res = await fetch('/api/auth/settings', { credentials: 'same-origin' });
    var settings = await res.json();
    if (settings.utility_endpoint_id) epSel.value = settings.utility_endpoint_id;
    refreshModels(settings.utility_model || '');
    refreshEffort(settings.utility_reasoning_effort || '');
    fallbackWidget = _bindFallbackWidget({
      containerId: 'set-utilityFallbacks',
      addBtnId: 'set-utilityAddFallback',
      endpoints: function() { return _endpoints; },
      settingKey: 'utility_model_fallbacks',
      supportsEffort: true,
      getEffortLevels: function(epId, modelId) {
        var meta = (_levelsByEndpoint[epId] || {})[modelId] || {};
        return Array.isArray(meta.supported_reasoning_levels) ? meta.supported_reasoning_levels : [];
      },
      initial: Array.isArray(settings.utility_model_fallbacks)
        ? settings.utility_model_fallbacks.map(function(f) {
            return {
              endpoint_id: (f && f.endpoint_id) || '',
              model: (f && f.model) || '',
              reasoning_effort: (f && f.reasoning_effort) || '',
            };
          })
        : [],
    });
  } catch (e) { console.warn('Failed to load utility model settings', e); }

  // Persist whatever's currently selected. Empty endpoint or model → backend
  // transparently falls back to the chat model (mirrors the teacher panel:
  // no toggle, "—" means "unset, use chat").
  async function saveUtility() {
    try {
      await _postSettings({
        utility_endpoint_id: epSel.value || '',
        utility_model: modelSel.value || '',
        utility_reasoning_effort: effortSel ? (effortSel.value || '') : ''
      });
      msg.textContent = 'Saved'; msg.style.color = 'var(--fg)';
      setTimeout(function() { msg.textContent = ''; }, 1500);
    } catch (e) { msg.textContent = e.status === 403 ? 'Admin access is required to change these settings.' : 'Failed to save'; msg.style.color = 'var(--red)'; }
  }

  // A new endpoint/model may not advertise the saved effort; refreshEffort
  // resets it to the provider default, and saveUtility persists that.
  epSel.addEventListener('change', function() { refreshModels(''); refreshEffort(''); saveUtility(); });
  modelSel.addEventListener('change', function() { refreshEffort(effortSel ? effortSel.value : ''); saveUtility(); });
  if (effortSel) effortSel.addEventListener('change', saveUtility);
  var defEp = el('set-defaultEpSelect');
  var defModel = el('set-defaultModelSelect');
  if (defEp) defEp.addEventListener('change', function() { if (!epSel.value) refreshEffort(effortSel ? effortSel.value : ''); });
  if (defModel) defModel.addEventListener('change', function() { if (!epSel.value) refreshEffort(effortSel ? effortSel.value : ''); });

  _registerAiEndpointRefresh(async function(endpoints) {
    _endpoints = endpoints;
    _fillEndpointSelect(epSel, _endpoints, epSel.value, true);
    refreshModels(modelSel.value);
    await loadEffortLevels();
    refreshEffort(effortSel ? effortSel.value : '');
    if (fallbackWidget && fallbackWidget.refresh) fallbackWidget.refresh();
  });
}

/* ── Teacher Model ── */
// SOTA model called automatically when a self-hosted student model
// fails an agent-mode task. Stored as a single `teacher_model` string
// in the form `model@endpoint_name` so the backend's _resolve_model
// can dispatch directly. Master toggle is the separate
// `teacher_enabled` flag so the user can pause the feature without
// losing their endpoint+model selection.
async function initTeacherModel() {
  var enabledToggle = el('set-teacherEnabledToggle');
  var epSel = el('set-teacherEpSelect');
  var modelSel = el('set-teacherModelSelect');
  var msg = el('set-teacherChatMsg');
  if (!epSel || !modelSel) return;
  var _endpoints = [];

  try {
    _endpoints = await _fetchModelEndpoints();
    _fillEndpointSelect(epSel, _endpoints, epSel.value, true);
  } catch (e) { console.warn('Failed to load endpoints for teacher model', e); }

  function refreshModels(selectedModel) {
    var epId = epSel.value;
    var ep = _endpoints.find(function(e) { return e.id === epId; });
    _fillModelSelect(modelSel, ep ? ep.models : [], selectedModel, true);
  }

  // Disable / enable the endpoint+model dropdowns based on the
  // master switch. Greys them out so users see at a glance that the
  // selection is dormant.
  function syncEnabled() {
    var off = enabledToggle ? !enabledToggle.checked : true;
    // Dim the card when off as a "dormant" cue, but keep the endpoint+model
    // dropdowns INTERACTIVE — the toggle gates whether escalation runs, not
    // whether you can configure it. (Previously the config was inert when off,
    // so users couldn't pick an endpoint until they'd already enabled it.)
    var card = enabledToggle ? enabledToggle.closest('.admin-card') : null;
    if (card) card.style.opacity = off ? '0.7' : '';
    var wrap = card ? card.querySelector('.settings-col') : null;
    if (wrap) wrap.style.pointerEvents = '';
    epSel.disabled = false;
    modelSel.disabled = false;
  }

  try {
    var res = await fetch('/api/auth/settings', { credentials: 'same-origin' });
    var settings = await res.json();
    if (enabledToggle) enabledToggle.checked = !!settings.teacher_enabled;
    // teacher_model is stored as "model@endpoint_name". Split on the
    // LAST `@` so model ids that contain @ aren't mangled.
    var spec = settings.teacher_model || '';
    var savedModel = spec;
    var savedEpName = '';
    var at = spec.lastIndexOf('@');
    if (at >= 0) {
      savedModel = spec.slice(0, at);
      savedEpName = spec.slice(at + 1);
    }
    if (savedEpName) {
      var match = _endpoints.find(function(ep) {
        return ep.name && ep.name.toLowerCase().indexOf(savedEpName.toLowerCase()) >= 0;
      });
      if (match) epSel.value = match.id;
    }
    refreshModels(savedModel);
    syncEnabled();
  } catch (e) { console.warn('Failed to load teacher model settings', e); }

  async function saveTeacher() {
    try {
      var spec = '';
      if (epSel.value && modelSel.value) {
        var ep = _endpoints.find(function(e) { return e.id === epSel.value; });
        spec = ep ? (modelSel.value + '@' + ep.name) : modelSel.value;
      }
      var enabled = enabledToggle ? !!enabledToggle.checked : false;
      await _postSettings({ teacher_enabled: enabled, teacher_model: spec });
      msg.textContent = enabled ? (spec ? 'Saved' : 'Pick an endpoint + model') : 'Disabled';
      msg.style.color = enabled && !spec ? 'var(--red)' : 'var(--fg)';
      setTimeout(function() { msg.textContent = ''; }, 2000);
    } catch (e) { msg.textContent = e.status === 403 ? 'Admin access is required to change these settings.' : 'Failed to save'; msg.style.color = 'var(--red)'; }
  }

  if (enabledToggle) {
    enabledToggle.addEventListener('change', function() {
      syncEnabled();
      saveTeacher();
    });
  }
  epSel.addEventListener('change', function() { refreshModels(''); saveTeacher(); });
  modelSel.addEventListener('change', saveTeacher);

  _registerAiEndpointRefresh(function(endpoints) {
    _endpoints = endpoints;
    _fillEndpointSelect(epSel, _endpoints, epSel.value, true);
    refreshModels(modelSel.value);
  });
}

/* ── Image Generation ── */

/* ── Vision ── */
async function initVisionSettings() {
  const vlSel = el('set-vlModelSelect');
  const msg = el('set-visionSettingsMsg');
  const enabledToggle = el('set-visionEnabledToggle');
  const configWrap = vlSel ? vlSel.closest('div[style*="flex-direction"]') : null;
  var _visionEndpoints = [];
  var visionFallbackWidget = null;
  var _vlExclude = ['audio', 'realtime', 'tts', 'dall-e', 'embedding', 'search', 'whisper'];
  function _isVisionModel(mid) {
    var lower = String(mid || '').toLowerCase();
    return !_vlExclude.some(function(kw) { return lower.includes(kw); });
  }
  try {
    const modelsRes = await fetch('/api/models', { credentials: 'same-origin' });
    const modelsData = await modelsRes.json();
    const visionModels = [];
    (modelsData.items || []).forEach(item => {
      if (item.offline) return;
      (item.models || []).forEach(mid => {
        if (_isVisionModel(mid)) {
          visionModels.push(mid);
        }
      });
    });
    sortModelIds(visionModels).forEach(mid => {
      var opt = document.createElement('option'); opt.value = mid; opt.textContent = mid; vlSel.appendChild(opt);
    });
  } catch (e) { console.warn('Failed to load models for vision settings', e); }
  // Also pull the raw endpoint list so the fallback widget can resolve
  // endpoint-id → models the same way the other cards do.
  try {
    _visionEndpoints = await _fetchModelEndpoints();
  } catch (e) { console.warn('Failed to load endpoints for vision fallback', e); }
  try {
    const settingsRes = await fetch('/api/auth/settings', { credentials: 'same-origin' });
    const settings = await settingsRes.json();
    if (settings.vision_model) vlSel.value = settings.vision_model;
    _syncModelLogo(vlSel);
    if (enabledToggle) enabledToggle.checked = settings.vision_enabled !== false;
    visionFallbackWidget = _bindFallbackWidget({
      containerId: 'set-visionFallbacks',
      addBtnId: 'set-visionAddFallback',
      endpoints: function() { return _visionEndpoints; },
      // Vision fallback list filters to vision-capable models (same heuristic
      // as the primary select above — exclude audio/tts/embedding/etc.).
      modelsFilter: function(mid) { return _isVisionModel(mid); },
      settingKey: 'vision_model_fallbacks',
      initial: Array.isArray(settings.vision_model_fallbacks)
        ? settings.vision_model_fallbacks.map(function(f) { return { endpoint_id: (f && f.endpoint_id) || '', model: (f && f.model) || '' }; })
        : [],
    });
  } catch (e) { console.warn('Failed to load vision settings', e); }

  function syncVisionDisabled() {
    var off = enabledToggle && !enabledToggle.checked;
    var card = enabledToggle ? enabledToggle.closest('.admin-card') : null;
    if (card) card.style.opacity = off ? '0.45' : '';
    if (configWrap) configWrap.style.pointerEvents = off ? 'none' : '';
  }
  syncVisionDisabled();

  async function saveSettings() {
    try {
      await _postSettings({ vision_enabled: enabledToggle ? enabledToggle.checked : true, vision_model: vlSel.value });
      msg.textContent = 'Saved'; msg.style.color = 'var(--fg)'; setTimeout(() => { msg.textContent = ''; }, 2000);
    } catch (e) { msg.textContent = e.status === 403 ? 'Admin access is required to change these settings.' : 'Failed to save'; msg.style.color = 'var(--red)'; }
  }
  vlSel.addEventListener('change', saveSettings);
  if (enabledToggle) enabledToggle.addEventListener('change', function() { syncVisionDisabled(); saveSettings(); });

  _registerAiEndpointRefresh(function(endpoints) {
    _visionEndpoints = endpoints;
    if (visionFallbackWidget && visionFallbackWidget.refresh) visionFallbackWidget.refresh();
  });
}

/* ── Face Recognition ── */

/* ── Text to Speech ── */

/* ── Speech to Text ── */

/* ═══════════════════════════════════════════
   SEARCH TAB
   ═══════════════════════════════════════════ */

var _LINK = function(href, text) {
  return '<a href="' + href + '" target="_blank" rel="noopener noreferrer" style="color:var(--accent, var(--red));text-decoration:underline;">' + text + '</a>';
};
var _searchProviderHints = {
  searxng: 'Recommended: the app-managed SearXNG service is the private, no-key default. The service is supplied with the Odysseus deployment; choose Test to check that it is responding. Queries stay with the selected provider unless you explicitly add a fallback.',
  duckduckgo: 'No API key needed. Choosing DuckDuckGo sends searches to DuckDuckGo; rate limits may produce empty results. Any fallback provider must be selected below.',
  brave: 'Brave Search needs an API key. ' + _LINK('https://api-dashboard.search.brave.com/register', 'Create a Brave Search API key') + '<ol><li>Sign in or create an account in the Brave Search API dashboard.</li><li>Choose a plan and create an API subscription.</li><li>Copy its API key into the field below, then save and test.</li></ol>',
  google_pse: 'Existing eligible Google Custom Search API customers only; the API is closed to new customers and sunsets 1 January 2027. Choose another provider if you are new. Existing projects need an API key and Search Engine ID (CX). ' + _LINK('https://developers.google.com/custom-search/v1/overview', 'Check Google API eligibility') + ' · ' + _LINK('https://programmablesearchengine.google.com/controlpanel/create', 'Configure an existing search engine'),
  tavily: 'Tavily requires an API key. ' + _LINK('https://app.tavily.com', 'Create a Tavily account and key') + '<ol><li>Sign in or create an account.</li><li>Create/copy an API key from the dashboard.</li><li>Paste the key below, then save and test.</li></ol>',
  serper: 'Serper requires an API key. ' + _LINK('https://serper.dev/signup', 'Create a Serper account and key') + '<ol><li>Sign in or create an account.</li><li>Copy the API key from the dashboard.</li><li>Paste the key below, then save and test.</li></ol>',
  disabled: 'Web search and deep-research search are unavailable while this is selected.',
};
var _searchNeedsKey = { brave: 1, google_pse: 1, tavily: 1, serper: 1 };
var _searchLabels = {
  searxng: 'SearXNG', duckduckgo: 'DuckDuckGo', brave: 'Brave Search',
  google_pse: 'Google PSE', tavily: 'Tavily', serper: 'Serper', disabled: 'Disabled',
};
var _searchKeyFields = {
  brave: 'brave_api_key', google_pse: 'google_pse_key',
  tavily: 'tavily_api_key', serper: 'serper_api_key',
};
async function initSearchSettings() {
  var provSel = el('set-searchProvider');
  var countSel = el('set-searchResultCount');
  var countCustomInput = el('set-searchResultCountCustom');
  var urlInput = el('set-searchUrl');
  var urlRow = el('set-searchUrlRow');
  var keyInput = el('set-searchApiKey');
  var keyRow = el('set-searchKeyRow');
  var keyHelp = el('set-searchKeyHelp');
  var cxInput = el('set-searchCx');
  var cxRow = el('set-searchCxRow');
  var hint = el('set-searchHint');
  var msg = el('set-searchMsg');
  var _settings = {};
  var _searchKeyConfigured = {};
  var _searchSetup = {};
  var _lastSearchTest = null;
  function keyFieldFor(prov) { return _searchKeyFields[prov] || ''; }

  function loadKeyForProvider() {
    // Provider API secrets are write-only in this panel and are never echoed back.
    keyInput.value = '';
    keyInput.autocomplete = 'new-password';
  }

  function retainSearchSettingsWithoutSecrets(settings) {
    _searchKeyConfigured = {};
    for (var field of Object.values(_searchKeyFields)) {
      _searchKeyConfigured[field] = !!(String(settings[field] || '').trim());
      delete settings[field];
    }
    _searchKeyConfigured.search_api_key = !!(String(settings.search_api_key || '').trim());
    delete settings.search_api_key;
    _settings = settings;
  }

  function searchProviderMetadata(provider) {
    return (_searchSetup.providers || []).find(item => item.id === provider) || {};
  }

  function updateVisibility() {
    var prov = provSel.value;
    urlRow.style.display = prov === 'searxng' ? 'flex' : 'none';
    keyRow.style.display = _searchNeedsKey[prov] ? 'flex' : 'none';
    if (keyHelp) keyHelp.style.display = _searchNeedsKey[prov] ? 'block' : 'none';
    cxRow.style.display = prov === 'google_pse' ? 'flex' : 'none';
    const provider = searchProviderMetadata(prov);
    const help = provider.help || {};
    const providerLinks = (help.links || []).map(link => {
      try {
        const href = new URL(link.url);
        if (href.protocol !== 'https:') return '';
        return _LINK(href.href, esc(link.label || 'Provider setup'));
      } catch (_) { return ''; }
    }).filter(Boolean);
    const steps = (help.steps || []).map(step => `<li>${esc(step)}</li>`).join('');
    const details = [
      provider.description ? `<p>${esc(provider.description)}</p>` : '',
      help.url ? (() => {
        try { const href = new URL(help.url); return href.protocol === 'https:' ? _LINK(href.href, 'Provider setup guide') : ''; }
        catch (_) { return ''; }
      })() : '',
      providerLinks.length ? `<p>${providerLinks.join(' · ')}</p>` : '',
      steps ? `<ol>${steps}</ol>` : '',
    ].filter(Boolean).join('');
    hint.innerHTML = `<div class="integration-help"><p><strong>Shared administrator setting</strong> — applies to all users, not a personal account.</p>${help.steps?.length ? '' : (_searchProviderHints[prov] || '')}${details ? `<div>${details}</div>` : ''}</div>`;
    if (prov === 'brave') keyInput.placeholder = 'Brave API key (hidden after saving)';
    else if (prov === 'google_pse') keyInput.placeholder = 'Google API key (hidden after saving)';
    else if (prov === 'tavily') keyInput.placeholder = 'Tavily API key (hidden after saving)';
    else if (prov === 'serper') keyInput.placeholder = 'Serper API key (hidden after saving)';
    else keyInput.placeholder = 'API key';
    loadKeyForProvider(prov);
  }

  function updateCountDisplay() {
    var val = _settings.search_result_count || 5;
    var presets = ['3', '5', '10', '20'];
    if (presets.includes(String(val))) {
      countSel.value = String(val);
      countCustomInput.style.display = 'none';
    } else {
      countSel.value = 'custom';
      countCustomInput.value = Math.max(1, Math.min(100, val));
      countCustomInput.style.display = 'block';
    }
  }

  async function loadSearchSetup() {
    const response = await fetch('/api/connectors/setup', { credentials: 'same-origin' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.detail || `Setup status unavailable (${response.status}).`);
    _searchSetup = data.search || {};
    for (const provider of _searchSetup.providers || []) {
      if (provider.id) _searchKeyConfigured[provider.id] = !!provider.configured;
    }
  }

  async function postSearchSetup(body) {
    const response = await fetch('/api/connectors/setup/search', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(result.detail || result.message || `Could not configure search (${response.status}).`);
      error.status = response.status;
      throw error;
    }
    return result;
  }

  try {
    const [res] = await Promise.all([
      fetch('/api/auth/settings', { credentials: 'same-origin' }),
      loadSearchSetup(),
    ]);
    const initial = await res.json();
    retainSearchSettingsWithoutSecrets(initial);
    if (_searchSetup.active_provider) provSel.value = _searchSetup.active_provider;
    else if (_settings.search_provider) provSel.value = _settings.search_provider;
    updateCountDisplay();
    if (_settings.search_url) urlInput.value = _settings.search_url;
    if (_settings.google_pse_cx) cxInput.value = _settings.google_pse_cx;
    if (_searchSetup.can_configure === false) {
      for (const control of [provSel, countSel, countCustomInput, urlInput, keyInput, cxInput]) control.disabled = true;
      const testButton = el('set-searchTestBtn');
      if (testButton) testButton.disabled = true;
      msg.textContent = _searchSetup.message || 'Administrator access is required to configure search.';
    }
  } catch (e) {
    msg.textContent = e.message || 'Search setup information is unavailable.';
    msg.style.color = 'var(--red)';
  }

  countSel.addEventListener('change', function() {
    if (this.value === 'custom') {
      countCustomInput.style.display = 'block';
      countCustomInput.focus();
    } else {
      countCustomInput.style.display = 'none';
    }
  });

  updateVisibility();

  async function refreshStatus() {
    try {
      await loadSearchSetup();
      const active = _searchSetup.active_provider || 'searxng';
      const provider = searchProviderMetadata(active);
      const label = _searchLabels[active] || provider.label || active;
      const count = _settings.search_result_count || 5;
      const extra = _searchNeedsKey[active]
        ? (provider.configured ? ' · API key saved (hidden)' : ' · API key required')
        : active === 'searxng' && (urlInput.value || '').trim() ? ` · ${urlInput.value.trim()}` : '';
      const test = _lastSearchTest?.provider === active ? _lastSearchTest : null;
      const state = test?.state === 'connected'
        ? ` · Test connected${Number.isInteger(test.result_count) ? ` (${test.result_count} results)` : ''}`
        : test?.state === 'error' || test?.state === 'setup_required'
          ? ` · Test ${test.state.replace(/_/g, ' ')}${test.error ? `: ${typeof test.error === 'string' ? test.error : test.error.message || 'Check provider setup.'}` : ''}`
          : '';
      msg.textContent = `${label}${extra}${state} · ${count} results per query${_searchSetup.message ? ` · ${_searchSetup.message}` : ''}`;
      msg.style.color = active === 'disabled' || (_searchNeedsKey[active] && !provider.configured) || test?.state === 'error' || test?.state === 'setup_required'
        ? 'var(--red)' : 'var(--fg)';
    } catch (e) {
      msg.textContent = `Search setup status unavailable: ${e.message || 'try again.'}`;
      msg.style.color = 'var(--red)';
    }
  }
  refreshStatus();

  async function saveSearch() {
    const prov = provSel.value;
    const customVal = countSel.value === 'custom' ? parseInt(countCustomInput.value, 10) : NaN;
    const resultCount = countSel.value === 'custom'
      ? (!isNaN(customVal) && customVal >= 1 && customVal <= 100 ? customVal : (_settings.search_result_count || 5))
      : parseInt(countSel.value, 10);
    const enteredKey = keyInput.value.trim();
    const payload = { provider: prov };
    if (enteredKey) payload.api_key = enteredKey;
    if (prov === 'google_pse') payload.google_pse_cx = cxInput.value.trim();
    if (prov === 'searxng') payload.search_url = urlInput.value.trim();
    try {
      await postSearchSetup(payload);
      const provider = searchProviderMetadata(prov);
      if (enteredKey) _searchKeyConfigured[prov] = true;
      if (provider) provider.configured = true;
      _searchSetup.active_provider = prov;
      await _postSettings({ search_result_count: resultCount });
      _settings.search_result_count = resultCount;
      const explicitFallbacks = Array.isArray(_settings.search_fallback_chain) ? _settings.search_fallback_chain : [];
      if (explicitFallbacks.length) await _postSettings({ search_fallback_chain: explicitFallbacks });
      keyInput.value = '';
      msg.textContent = 'Search provider settings saved; test the selected provider to confirm it responds.';
      msg.style.color = 'var(--fg)';
      setTimeout(refreshStatus, 200);
      if (searchModule && searchModule.refresh) searchModule.refresh();
      return true;
    } catch (e) {
      keyInput.value = '';
      msg.textContent = e.status === 403
        ? 'Administrator access is required to change search settings.'
        : e.message || 'Failed to save search settings.';
      msg.style.color = 'var(--red)';
      return false;
    }
  }

  provSel.addEventListener('change', function() { updateVisibility(); saveSearch(); _syncSearchPicker(); });
  countSel.addEventListener('change', saveSearch);
  urlInput.addEventListener('change', saveSearch);
  keyInput.addEventListener('change', saveSearch);
  cxInput.addEventListener('change', saveSearch);

  // ── Provider picker with logos (mirrors the hidden <select>) ──
  var picker = el('search-provider-picker');
  var pickerBtn = el('search-provider-btn');
  var pickerMenu = el('search-provider-menu');
  var pickerCurrent = picker ? picker.querySelector('.adm-provider-current') : null;
  function _searchProviderLogoSvg(key) {
    return _SEARCH_PROVIDER_LOGOS[key] || '';
  }
  function _renderSearchPickerMenu() {
    if (!pickerMenu) return;
    pickerMenu.innerHTML = Array.from(provSel.options).map(function(o) {
      var logo = _searchProviderLogoSvg(o.dataset.searchLogo);
      var active = o.value === provSel.value ? ' active' : '';
      var selected = o.value === provSel.value ? 'true' : 'false';
      return '<button type="button" class="adm-provider-item' + active + '" role="option" aria-selected="' + selected + '" tabindex="-1" data-value="' + o.value.replace(/"/g, '&quot;') + '" style="width:100%;border:0;background:transparent;color:inherit;font:inherit;text-align:left;">' +
        '<span class="adm-provider-logo" aria-hidden="true">' + logo + '</span>' +
        '<span>' + o.textContent + '</span>' +
      '</button>';
    }).join('');
  }
  function _syncSearchPicker() {
    if (!pickerCurrent) return;
    var opt = provSel.selectedOptions[0] || provSel.options[0];
    var logo = _searchProviderLogoSvg(opt.dataset.searchLogo);
    pickerCurrent.querySelector('.adm-provider-logo').innerHTML = logo;
    pickerCurrent.querySelector('.adm-provider-name').textContent = opt.textContent;
    pickerMenu?.querySelectorAll('.adm-provider-item').forEach(item => {
      const active = item.dataset.value === opt.value;
      item.setAttribute('aria-selected', String(active));
      item.classList.toggle('active', active);
    });
  }
  if (picker && pickerBtn && pickerMenu && pickerCurrent) {
    const closePicker = restoreFocus => {
      pickerMenu.classList.add('hidden');
      pickerBtn.setAttribute('aria-expanded', 'false');
      if (restoreFocus) pickerBtn.focus();
    };
    const focusCurrentOption = () => {
      (pickerMenu.querySelector('.adm-provider-item[aria-selected="true"]') || pickerMenu.querySelector('.adm-provider-item'))?.focus();
    };
    _renderSearchPickerMenu();
    _syncSearchPicker();
    pickerBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      const opening = pickerMenu.classList.contains('hidden');
      pickerMenu.classList.toggle('hidden', !opening);
      pickerBtn.setAttribute('aria-expanded', String(opening));
      if (opening) focusCurrentOption();
    });
    pickerBtn.addEventListener('keydown', event => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        if (pickerMenu.classList.contains('hidden')) {
          pickerMenu.classList.remove('hidden');
          pickerBtn.setAttribute('aria-expanded', 'true');
        }
        focusCurrentOption();
      }
    });
    pickerMenu.addEventListener('click', function(e) {
      var item = e.target.closest('.adm-provider-item');
      if (!item) return;
      provSel.value = item.dataset.value;
      provSel.dispatchEvent(new Event('change', { bubbles: true }));
      closePicker(true);
      _renderSearchPickerMenu();
      _syncSearchPicker();
    });
    pickerMenu.addEventListener('keydown', event => {
      const items = Array.from(pickerMenu.querySelectorAll('.adm-provider-item'));
      const current = items.indexOf(document.activeElement);
      let next = current;
      if (event.key === 'ArrowDown') next = (current + 1 + items.length) % items.length;
      else if (event.key === 'ArrowUp') next = (current - 1 + items.length) % items.length;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = items.length - 1;
      else if (event.key === 'Escape') { event.preventDefault(); closePicker(true); return; }
      else return;
      event.preventDefault();
      items[next]?.focus();
    });
    document.addEventListener('click', function(e) {
      if (!picker.contains(e.target)) closePicker(false);
    });
  }

  // ── Fallback chain ──
  // Stored as an ordered array of provider IDs (primary not included).
  // When the primary fails or hits rate-limit, the backend walks this
  // list in order trying each one.
  var fbWrap = el('set-searchFallbackChain');
  function _availableFallbackOptions() {
    var primary = provSel.value;
    var chain = _settings.search_fallback_chain || [];
    var inChain = new Set(chain.concat([primary, 'disabled']));
    return Array.from(provSel.options)
      .map(function(o) { return { value: o.value, label: o.textContent, logo: o.dataset.searchLogo }; })
      .filter(function(o) { return !inChain.has(o.value); });
  }
  var addBtn = el('set-searchAddFallback');
  var TRASH_SVG = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>';
  function _renderFallbackChain() {
    if (!fbWrap) return;
    var chain = (_settings.search_fallback_chain || []).slice();
    fbWrap.innerHTML = '';
    chain.forEach(function(p, idx) {
      var row = document.createElement('div');
      row.className = 'settings-fallback-row';

      var num = document.createElement('span');
      num.className = 'settings-fallback-num';
      num.textContent = (idx + 1) + '.';
      row.appendChild(num);

      // Inline logo so the row identifies its provider at a glance even
      // before opening the dropdown. The <select> below still drives
      // selection; we just mirror its value into the logo span.
      var logoWrap = document.createElement('span');
      logoWrap.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;flex-shrink:0;color:var(--fg);';
      var setLogo = function(val) {
        var srcOpt = Array.from(provSel.options).find(function(o) { return o.value === val; });
        logoWrap.innerHTML = srcOpt ? _searchProviderLogoSvg(srcOpt.dataset.searchLogo) : '';
      };
      setLogo(p);
      row.appendChild(logoWrap);

      var sel = document.createElement('select');
      sel.className = 'settings-select';
      // Options: this row's current value + every other provider not yet in the chain (and not the primary or 'disabled').
      var primary = provSel.value;
      var others = new Set(chain.filter(function(x) { return x !== p; }).concat([primary, 'disabled']));
      Array.from(provSel.options).forEach(function(o) {
        if (o.value !== p && others.has(o.value)) return;
        var opt = document.createElement('option');
        opt.value = o.value;
        opt.textContent = o.textContent;
        sel.appendChild(opt);
      });
      sel.value = p;
      sel.addEventListener('change', function() {
        setLogo(sel.value);
        var next = (_settings.search_fallback_chain || []).slice();
        next[idx] = sel.value;
        _saveFallbackChain(next);
      });
      row.appendChild(sel);

      var rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'settings-fallback-remove';
      rm.title = 'Remove fallback';
      rm.innerHTML = TRASH_SVG;
      rm.addEventListener('click', function() {
        var next = (_settings.search_fallback_chain || []).filter(function(x, i) { return i !== idx; });
        _saveFallbackChain(next);
      });
      row.appendChild(rm);

      fbWrap.appendChild(row);
    });
    // Add-fallback button: disabled when there are no remaining providers to add.
    if (addBtn) {
      var hasMore = _availableFallbackOptions().length > 0;
      addBtn.style.display = hasMore ? '' : 'none';
    }
  }
  if (addBtn && !addBtn._wired) {
    addBtn._wired = true;
    addBtn.addEventListener('click', function() {
      var avail = _availableFallbackOptions();
      if (!avail.length) return;
      var next = (_settings.search_fallback_chain || []).slice();
      next.push(avail[0].value);
      _saveFallbackChain(next);
    });
  }
  async function _saveFallbackChain(chain) {
    _settings.search_fallback_chain = chain;
    try {
      await _postSettings({ search_fallback_chain: chain });
      msg.textContent = 'Saved'; msg.style.color = 'var(--fg)';
      setTimeout(refreshStatus, 2000);
    } catch (e) { msg.textContent = e.status === 403 ? 'Admin access is required to change these settings.' : 'Failed to save'; msg.style.color = 'var(--red)'; }
    _renderFallbackChain();
  }
  _renderFallbackChain();
  // Re-render whenever the primary changes (it gets filtered out of "Add").
  provSel.addEventListener('change', _renderFallbackChain);

  // Test the selected provider using the setup endpoint; no query text or result content is retained here.
  var testBtn = el('set-searchTestBtn');
  if (testBtn) {
    testBtn.addEventListener('click', async function() {
      if (!provSel.value || provSel.value === 'disabled') {
        msg.textContent = 'Choose an active provider before testing.';
        msg.style.color = 'var(--red)';
        return;
      }
      testBtn.disabled = true;
      const originalHtml = testBtn.innerHTML;
      try {
        const saved = await saveSearch();
        if (!saved) return;
        testBtn.textContent = 'Testing…';
        msg.textContent = 'Checking the selected search provider…';
        msg.style.color = 'var(--fg)';
        const response = await fetch('/api/connectors/setup/search/test', {
          method: 'POST',
          credentials: 'same-origin',
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(result.detail || result.message || `Search test failed (${response.status}).`);
        _lastSearchTest = result;
        if (result.state === 'connected') {
          msg.textContent = `Search provider responds${Number.isInteger(result.result_count) ? ` · ${result.result_count} results` : ''}.`;
          msg.style.color = 'var(--fg)';
        } else {
          const reason = typeof result.error === 'string' ? result.error : result.error?.message;
          msg.textContent = `Search test ${String(result.state || 'failed').replace(/_/g, ' ')}${reason ? `: ${reason}` : '. Check the provider setup above.'}`;
          msg.style.color = 'var(--red)';
        }
        await refreshStatus();
      } catch (error) {
        _lastSearchTest = { provider: provSel.value, state: 'error', error: error.message };
        msg.textContent = error.message || 'Search provider test failed. Check the setup guide and retry.';
        msg.style.color = 'var(--red)';
      } finally {
        testBtn.disabled = false;
        testBtn.innerHTML = originalHtml;
      }
    });
  }
}

/* ── Deep Research Model (AI tab) ── */
async function initResearchSettings() {
  var epSel = el('set-researchEndpoint');
  var modelSel = el('set-researchModel');
  var tokensInput = el('set-researchMaxTokens');
  var extractTimeoutInput = el('set-researchExtractTimeout');
  var extractConcurrencyInput = el('set-researchExtractConcurrency');
  var runTimeoutInput = el('set-researchRunTimeout');
  var msg = el('set-researchMsg');
  var endpoints = [];

  try {
    endpoints = await _fetchModelEndpoints();
    _fillEndpointSelect(epSel, endpoints, epSel.value, true);
  } catch (e) { console.warn('Failed to load endpoints for research', e); }

  function refreshModels(selectedModel) {
    var epId = epSel.value;
    var ep = endpoints.find(function(e) { return e.id === epId; });
    _fillModelSelect(modelSel, ep ? ep.models : [], selectedModel, true);
  }

  try {
    var res = await fetch('/api/auth/settings', { credentials: 'same-origin' });
    var settings = await res.json();
    if (settings.research_endpoint_id) epSel.value = settings.research_endpoint_id;
    refreshModels(settings.research_model || '');
    if (settings.research_max_tokens) tokensInput.value = settings.research_max_tokens;
    if (settings.research_extraction_timeout_seconds) extractTimeoutInput.value = settings.research_extraction_timeout_seconds;
    if (settings.research_extraction_concurrency) extractConcurrencyInput.value = settings.research_extraction_concurrency;
    if (settings.research_run_timeout_seconds !== undefined && settings.research_run_timeout_seconds !== null) {
      runTimeoutInput.value = settings.research_run_timeout_seconds;
    }
  } catch (e) { console.warn('Failed to load research settings', e); }

  function showStatus() {
    var parts = [];
    if (epSel.value) {
      var epName = epSel.options[epSel.selectedIndex].textContent;
      var mName = modelSel.value ? modelSel.value.split('/').pop() : 'auto';
      parts.push(epName + ' / ' + mName);
    }
    if (tokensInput.value) {
      parts.push('Max tokens: ' + tokensInput.value);
    }
    if (extractTimeoutInput.value) {
      parts.push('Extract: ' + extractTimeoutInput.value + 's');
    }
    if (extractConcurrencyInput.value) {
      parts.push('Parallel: ' + extractConcurrencyInput.value);
    }
    if (runTimeoutInput.value !== '') {
      var rtv = parseInt(runTimeoutInput.value, 10);
      if (!isNaN(rtv)) {
        parts.push(rtv === 0 ? 'Max time: no limit' : 'Max time: ' + rtv + 's');
      }
    }
    if (parts.length) {
      msg.textContent = parts.join(' · ');
      msg.style.color = 'var(--fg)';
    } else {
      msg.textContent = 'Using chat defaults';
      msg.style.color = 'var(--fg)';
    }
  }
  showStatus();

  async function saveResearch() {
    var payload = {
      research_endpoint_id: epSel.value,
      research_model: modelSel.value,
    };
    var tv = parseInt(tokensInput.value, 10);
    if (tv && tv >= 1024) payload.research_max_tokens = tv;
    var et = parseInt(extractTimeoutInput.value, 10);
    if (et && et >= 15 && et <= 3600) payload.research_extraction_timeout_seconds = et;
    var ec = parseInt(extractConcurrencyInput.value, 10);
    if (ec && ec >= 1 && ec <= 12) payload.research_extraction_concurrency = ec;
    if (runTimeoutInput.value !== '') {
      var rt = parseInt(runTimeoutInput.value, 10);
      // 0 = no limit (disables the hard timeout); otherwise 60s..86400s (24h)
      if (!isNaN(rt) && (rt === 0 || (rt >= 60 && rt <= 86400))) {
        payload.research_run_timeout_seconds = rt;
      }
    }
    try {
      await _postSettings(payload);
      msg.textContent = 'Saved'; msg.style.color = 'var(--fg)';
      setTimeout(showStatus, 2000);
    } catch (e) { msg.textContent = e.status === 403 ? 'Admin access is required to change these settings.' : 'Failed to save'; msg.style.color = 'var(--red)'; }
  }

  epSel.addEventListener('change', async function() {
    refreshModels('');
    saveResearch();
  });
  modelSel.addEventListener('change', saveResearch);
  tokensInput.addEventListener('change', saveResearch);
  extractTimeoutInput.addEventListener('change', saveResearch);
  extractConcurrencyInput.addEventListener('change', saveResearch);
  runTimeoutInput.addEventListener('change', saveResearch);

  _registerAiEndpointRefresh(function(nextEndpoints) {
    endpoints = nextEndpoints;
    _fillEndpointSelect(epSel, endpoints, epSel.value, true);
    refreshModels(modelSel.value);
  });
}

/* ── Deep Research Search (Search tab) ── */
async function initResearchSearchSettings() {
  var searchSel = el('set-researchSearch');
  var msg = el('set-researchSearchMsg');
  var logoEl = el('set-researchSearch-logo');

  function updateSearchLogo() {
    if (!logoEl) return;
    var opt = searchSel.selectedOptions[0];
    var key = opt && opt.dataset ? opt.dataset.searchLogo : '';
    logoEl.innerHTML = key ? (_SEARCH_PROVIDER_LOGOS[key] || '') : '';
  }

  function updateSearchOptions(settings) {
    var options = searchSel.querySelectorAll('option');
    options.forEach(function(opt) {
      var prov = opt.value;
      if (!prov) return;
      var kf = _searchKeyFields[prov];
      if (!kf) return;
      var hasKey = ((settings[kf] || '').trim() || (settings.search_api_key || '').trim());
      if (!hasKey) {
        opt.textContent = (_searchLabels[prov] || prov) + ' (no key)';
        opt.style.color = 'var(--red)';
      } else {
        opt.textContent = _searchLabels[prov] || prov;
        opt.style.color = '';
      }
    });
  }

  try {
    var res = await fetch('/api/auth/settings', { credentials: 'same-origin' });
    var settings = await res.json();
    if (settings.research_search_provider) searchSel.value = settings.research_search_provider;
    updateSearchOptions(settings);
    updateSearchLogo();
  } catch (e) { console.warn('Failed to load research search settings', e); }

  async function saveResearchSearch() {
    try {
      await _postSettings({ research_search_provider: searchSel.value });
      msg.textContent = 'Saved'; msg.style.color = 'var(--fg)';
      setTimeout(function() { msg.textContent = ''; }, 2000);
    } catch (e) { msg.textContent = e.status === 403 ? 'Admin access is required to change these settings.' : 'Failed to save'; msg.style.color = 'var(--red)'; }
  }

  searchSel.addEventListener('change', function() { updateSearchLogo(); saveResearchSearch(); });
}

/* ── Agent Settings (AI tab) ── */

/* ═══════════════════════════════════════════
   APPEARANCE TAB
   ═══════════════════════════════════════════ */
function initAppearance() {
  syncAppearanceCheckboxes();
  syncPrivacyCheckboxes();

  modalEl.querySelectorAll('[data-ui-key]').forEach(function(chk) {
    chk.addEventListener('change', async function() {
      var key = chk.dataset.uiKey;

      if (window.UI_VIS_ADMIN_ONLY && window.UI_VIS_ADMIN_ONLY.has(key) && !chk.checked && !window._isAdmin) {
        chk.checked = true;
        if (uiModule && uiModule.showToast) {
          uiModule.showToast('Only admins can hide Settings.');
        }
        return;
      }

      // Hiding the Settings cog removes the only visible way to re-open this
      // panel. Warn the user and remind them about the `/settings` slash
      // command so they don't lock themselves out.
      if (key === 'sidebar-settings-btn' && !chk.checked) {
        var ok = true;
        try {
          ok = await (uiModule && uiModule.styledConfirm
            ? uiModule.styledConfirm(
                'Hide the Settings cog?\n\nYou can re-open this panel any time by typing /settings in the chat input.',
                { confirmText: 'Hide', cancelText: 'Cancel' }
              )
            : Promise.resolve(window.confirm('Hide the Settings cog?\n\nYou can re-open this panel any time by typing /settings in the chat input.')));
        } catch (_) { ok = false; }
        if (!ok) {
          chk.checked = true;
          return;
        }
        if (uiModule && uiModule.showToast) {
          uiModule.showToast('Settings cog hidden — type /settings to bring it back.', 5000);
        }
      }

      var s = window.loadUIVis();
      s[key] = chk.checked;
      window.saveUIVis(s);
      window.applyUIVis(s);
    });
  });

  modalEl.querySelectorAll('[data-privacy-key]').forEach(function(chk) {
    chk.addEventListener('change', function() {
      if (chk.dataset.privacyKey !== 'sensitive-blur') return;
      localStorage.setItem('odysseus-sensitive-blur', chk.checked ? 'on' : 'off');
      window.dispatchEvent(new CustomEvent('odysseus-sensitive-blur-change', {
        detail: { enabled: chk.checked }
      }));
    });
  });

  // Per-section reset buttons (arrow-circle-back icon in each card's h2).
  // Removes only the keys belonging to this section from the persisted
  // visibility map so other sections keep their user settings.
  modalEl.querySelectorAll('[data-vis-reset]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var card = btn.closest('.admin-card');
      if (!card) return;
      var keys = Array.from(card.querySelectorAll('[data-ui-key]'))
        .map(function(c) { return c.dataset.uiKey; })
        .filter(Boolean);
      if (!keys.length) return;
      var s = window.loadUIVis ? window.loadUIVis() : {};
      keys.forEach(function(k) { delete s[k]; });
      if (window.saveUIVis) window.saveUIVis(s);
      syncAppearanceCheckboxes();
      syncPrivacyCheckboxes();
      if (window.applyUIVis) window.applyUIVis(s);
    });
  });
}

function syncAppearanceCheckboxes() {
  var s = window.loadUIVis ? window.loadUIVis() : {};
  var defaultOff = window.UI_VIS_DEFAULT_OFF || new Set();
  modalEl.querySelectorAll('[data-ui-key]').forEach(function(chk) {
    var key = chk.dataset.uiKey;
    chk.checked = key in s ? s[key] !== false : !defaultOff.has(key);
  });
}

function syncPrivacyCheckboxes() {
  modalEl.querySelectorAll('[data-privacy-key="sensitive-blur"]').forEach(function(chk) {
    chk.checked = localStorage.getItem('odysseus-sensitive-blur') === 'on';
  });
}

/* ═══════════════════════════════════════════
   SHORTCUTS TAB
   ═══════════════════════════════════════════ */

const SHORTCUT_DEFAULTS = {
  search:         'ctrl+k',
  toggle_sidebar: 'ctrl+alt+b',
  new_session:    'ctrl+alt+n',
  fav_session:    'ctrl+alt+f',
  delete_session: 'ctrl+alt+d',
  cancel:         'escape',
  tts:            'alt+shift+t',
  incognito:      'ctrl+alt+i',
  settings:       'ctrl+,',
  focus_input:    'ctrl+/',
  // Open-tool shortcuts. Calendar is bound by default; the rest are
  // unbound (empty) so the user can assign their own in the panel.
  open_calendar:  'ctrl+alt+c',
  open_compare:   '',
  open_cookbook:  '',
  open_research:  '',
  open_gallery:   '',
  open_library:   '',
  open_memory:    '',
  open_skills:    '',
  open_notes:     '',
  open_tasks:     '',
  open_theme:     '',
};

const SHORTCUT_ICONS = {
  search:         '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><circle cx="10" cy="10" r="7"/><path d="M21 21l-4.35-4.35"/></svg>',
  toggle_sidebar: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>',
  new_session:    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
  fav_session:    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>',
  delete_session: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
  cancel:         '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
  tts:            '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>',
  incognito:      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><line x1="8" y1="16" x2="16" y2="8"/><line x1="8" y1="8" x2="16" y2="16"/></svg>',
  settings:       '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
  focus_input:    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
  open_calendar:  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>',
  open_compare:   '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="7" height="16" rx="1.5"/><rect x="14" y="4" width="7" height="16" rx="1.5"/><path d="M10 8h4"/><path d="M10 16h4"/></svg>',
  open_cookbook:  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>',
  open_research:  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/></svg>',
  open_gallery:   '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>',
  open_library:   '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>',
  open_memory:    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a7 7 0 0 1 7 7c0 2.4-1.2 4.5-3 5.7V17a2 2 0 0 1-2 2h-4a2 2 0 0 1-2-2v-2.3C6.2 13.5 5 11.4 5 9a7 7 0 0 1 7-7z"/><line x1="10" y1="22" x2="14" y2="22"/></svg>',
  open_skills:    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>',
  open_notes:     '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 3h10l4 4v14H5z"/><path d="M15 3v5h5"/><path d="M8 17.5 15.5 10l2.5 2.5L10.5 20H8z"/></svg>',
  open_tasks:     '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/><path d="M9 16l2 2 4-4"/></svg>',
  open_theme:     '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 2a10 10 0 0 0 0 20 5 5 0 0 0 5-5 3 3 0 0 0-3-3h-2a3 3 0 0 1-3-3 5 5 0 0 1 5-5"/></svg>',
};

const SHORTCUT_LABELS = {
  search:         'Search conversations',
  toggle_sidebar: 'Toggle sidebar',
  new_session:    'New session',
  fav_session:    'Favorite session',
  delete_session: 'Delete session',
  cancel:         'Cancel / close',
  tts:            'Play/stop TTS',
  incognito:      'Toggle incognito',
  settings:       'Toggle Window',
  focus_input:    'Focus chat input',
  open_calendar:  'Open Calendar',
  open_compare:   'Open Compare',
  open_cookbook:  'Open Cookbook',
  open_research:  'Open Deep Research',
  open_gallery:   'Open Gallery',
  open_library:   'Open Library',
  open_memory:    'Open Memory',
  open_skills:    'Open Skills',
  open_notes:     'Open Notes',
  open_tasks:     'Open Tasks',
  open_theme:     'Open Theme',
};

const SHORTCUT_CATEGORIES = [
  { name: 'Navigation', keys: ['search', 'toggle_sidebar', 'focus_input', 'settings'] },
  { name: 'Sessions', keys: ['new_session', 'fav_session', 'delete_session'] },
  { name: 'Tools', keys: ['incognito', 'tts', 'cancel'] },
  { name: 'Open Tools', keys: ['open_calendar', 'open_compare', 'open_cookbook', 'open_research', 'open_gallery', 'open_library', 'open_memory', 'open_skills', 'open_notes', 'open_tasks', 'open_theme'] },
];

function _formatKeyCaps(combo) {
  return combo.split('+').map(p => {
    let label;
    if (p === 'ctrl') label = 'Ctrl';
    else if (p === 'alt') label = 'Alt';
    else if (p === 'shift') label = 'Shift';
    else if (p === 'meta') label = 'Cmd';
    else if (p === 'escape') label = 'Esc';
    else if (p === ',') label = ',';
    else if (p === '/') label = '/';
    else if (p === 'space') label = 'Space';
    else label = p.charAt(0).toUpperCase() + p.slice(1);
    return `<kbd>${label}</kbd>`;
  }).join('');
}

function _comboFromEvent(e) {
  // Drop a stray AltGr keystroke (e.g. AltGr+E to type €) so it isn't recorded
  // as a bogus ctrl+alt+<char> binding — onKey ignores empty combos. See
  // platform.js for the macOS carve-out and Windows trade-off.
  if (isAltGrEvent(e)) return '';
  const parts = [];
  if (e.ctrlKey || e.metaKey) parts.push('ctrl');
  if (e.altKey) parts.push('alt');
  if (e.shiftKey) parts.push('shift');
  const key = e.key.toLowerCase();
  if (!['control', 'alt', 'shift', 'meta'].includes(key)) {
    parts.push(key === ' ' ? 'space' : key);
  }
  return parts.join('+');
}

async function initShortcuts() {
  const listEl = el('shortcuts-list');
  const resetBtn = el('shortcuts-reset-btn');
  if (!listEl) return;

  // Load saved keybinds
  let keybinds = { ...SHORTCUT_DEFAULTS };
  try {
    const res = await fetch('/api/auth/settings', { credentials: 'same-origin' });
    const settings = await res.json();
    if (settings.keybinds) keybinds = { ...keybinds, ...settings.keybinds };
    if (keybinds.toggle_sidebar === 'ctrl+b') {
      keybinds.toggle_sidebar = SHORTCUT_DEFAULTS.toggle_sidebar;
    }
  } catch (e) {}

  function _findConflicts() {
    const comboMap = {};
    for (const [action, combo] of Object.entries(keybinds)) {
      if (!comboMap[combo]) comboMap[combo] = [];
      comboMap[combo].push(action);
    }
    const conflicts = new Set();
    for (const actions of Object.values(comboMap)) {
      if (actions.length > 1) actions.forEach(a => conflicts.add(a));
    }
    return conflicts;
  }

  function render() {
    listEl.innerHTML = '';
    const conflicts = _findConflicts();

    for (const cat of SHORTCUT_CATEGORIES) {
      const catHeader = document.createElement('div');
      catHeader.className = 'shortcut-category';
      catHeader.textContent = cat.name;
      listEl.appendChild(catHeader);

      for (const action of cat.keys) {
        if (!(action in keybinds)) continue;
        const combo = keybinds[action];
        // Unbound shortcuts (empty combo) still render so the user can
        // assign one \u2014 they show a "Set" affordance instead of keycaps.
        const label = SHORTCUT_LABELS[action] || action;
        const icon = SHORTCUT_ICONS[action] || '';
        const isCustom = combo !== (SHORTCUT_DEFAULTS[action] || '');
        const hasConflict = combo && conflicts.has(action);
        const row = document.createElement('div');
        row.className = 'shortcut-row' + (hasConflict ? ' shortcut-conflict' : '');
        row.dataset.action = action;
        const keyContent = combo ? _formatKeyCaps(combo) : '<span class="shortcut-unset">Set</span>';
        row.innerHTML = `
          <span class="shortcut-label"><span class="shortcut-icon">${icon}</span>${esc(label)}${hasConflict ? '<span class="shortcut-warn" title="Duplicate shortcut">!</span>' : ''}</span>
          <div class="shortcut-controls">
            <span class="shortcut-hint" hidden></span>
            <button class="shortcut-key${combo ? '' : ' shortcut-key-unset'}" data-action="${action}" title="Click to rebind">${keyContent}</button>
            <button class="shortcut-action-btn ${isCustom ? 'is-reset' : ''}" data-action="${action}" title="${isCustom ? 'Reset to default' : 'Confirm'}" style="${isCustom ? '' : 'visibility:hidden'}">
              ${isCustom
                ? '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>'
                : '\u2713'}
            </button>
          </div>
        `;
        listEl.appendChild(row);
      }
    }

    listEl.querySelectorAll('.shortcut-key').forEach(btn => {
      btn.addEventListener('click', () => startRebind(btn));
    });

    listEl.querySelectorAll('.shortcut-action-btn.is-reset').forEach(btn => {
      btn.addEventListener('click', () => {
        const action = btn.dataset.action;
        keybinds[action] = SHORTCUT_DEFAULTS[action];
        saveKeybinds();
        render();
      });
    });
  }

  function startRebind(btn) {
    const action = btn.dataset.action;
    const row = btn.closest('.shortcut-row');
    const actionBtn = row.querySelector('.shortcut-action-btn');
    const hintEl = row.querySelector('.shortcut-hint');

    // Remove any other active rebind
    listEl.querySelectorAll('.shortcut-key.listening').forEach(b => {
      b.classList.remove('listening');
      b.innerHTML = _formatKeyCaps(keybinds[b.dataset.action]);
      const otherRow = b.closest('.shortcut-row');
      const otherAction = otherRow.querySelector('.shortcut-action-btn');
      if (otherAction && !otherAction.classList.contains('is-reset')) otherAction.style.visibility = 'hidden';
    });

    btn.classList.add('listening');
    btn.textContent = 'Press keys...';
    // Show confirm button
    actionBtn.textContent = '\u2713';
    actionBtn.classList.remove('is-reset');
    actionBtn.style.visibility = 'visible';
    actionBtn.title = 'Confirm';
    // Hint: tell the user how to commit / cancel the rebind.
    if (hintEl) {
      hintEl.hidden = false;
      hintEl.textContent = 'press a key';
    }

    let pendingCombo = null;

    // Wire confirm button
    const confirmHandler = () => {
      if (pendingCombo) {
        keybinds[action] = pendingCombo;
        saveKeybinds();
      }
      cleanup();
      render();
    };
    actionBtn.addEventListener('click', confirmHandler, { once: true });

    function onKey(e) {
      e.preventDefault();
      e.stopPropagation();

      if (e.key === 'Escape') {
        cleanup();
        btn.innerHTML = _formatKeyCaps(keybinds[action]);
        const isCustom = keybinds[action] !== SHORTCUT_DEFAULTS[action];
        if (isCustom) {
          actionBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>';
          actionBtn.classList.add('is-reset');
          actionBtn.title = 'Reset to default';
        } else {
          actionBtn.style.visibility = 'hidden';
        }
        return;
      }

      // Enter commits the previewed combo (same as clicking \u2713). Only acts
      // as commit once a combo has been captured \u2014 otherwise it would just
      // try to bind Enter itself.
      if (e.key === 'Enter' && pendingCombo) {
        confirmHandler();
        return;
      }

      const combo = _comboFromEvent(e);
      if (!combo || combo === 'ctrl' || combo === 'alt' || combo === 'shift' || combo === 'ctrl+alt' || combo === 'ctrl+shift' || combo === 'alt+shift' || combo === 'ctrl+alt+shift') return;

      // Preview the combo, wait for confirm
      pendingCombo = combo;
      btn.innerHTML = _formatKeyCaps(combo);
      // Now that a combo is captured, prompt to commit with Enter.
      if (hintEl) hintEl.textContent = '\u21B5 Enter to save';
    }

    function cleanup() {
      btn.classList.remove('listening');
      if (hintEl) { hintEl.hidden = true; hintEl.textContent = ''; }
      document.removeEventListener('keydown', onKey, true);
      actionBtn.removeEventListener('click', confirmHandler);
    }

    document.addEventListener('keydown', onKey, true);
  }

  async function saveKeybinds() {
    try {
      await _postSettings({ keybinds });
      // Update global keybinds so they take effect immediately
      window._odysseusKeybinds = keybinds;
      if (uiModule && uiModule.showToast) uiModule.showToast('Shortcut saved');
    } catch (e) {
      console.error('Failed to save keybinds:', e);
      if (uiModule && uiModule.showToast) uiModule.showToast('Failed to save shortcut');
    }
  }

  if (resetBtn) {
    resetBtn.addEventListener('click', async () => {
      keybinds = { ...SHORTCUT_DEFAULTS };
      render();
      await saveKeybinds();
      if (uiModule && uiModule.showToast) uiModule.showToast('Shortcuts reset to defaults');
    });
  }

  render();
}

/* ═══════════════════════════════════════════
   INIT & REFRESH
   ═══════════════════════════════════════════ */
function initAccount() {
  // Populate user info
  fetch('/api/auth/status', { credentials: 'same-origin' })
    .then(r => r.json())
    .then(d => {
      const nameEl = el('settings-account-username');
      const roleEl = el('settings-account-role');
      const avatarEl = el('settings-account-avatar');
      if (nameEl) nameEl.textContent = d.username || 'Unknown';
      if (roleEl) roleEl.textContent = d.is_admin ? 'Admin' : 'User';
      if (avatarEl) {
        const initial = (d.username || '?')[0].toUpperCase();
        avatarEl.textContent = initial;
      }
    }).catch(() => {});

  // Update password placeholder and policy from server
  fetch('/api/auth/policy', { credentials: 'same-origin' })
    .then(r => r.ok ? r.json() : null)
    .then(policy => {
      if (!policy) return;
      _authPolicy = policy;
      const pwNew = el('settings-pw-new');
      if (pwNew) pwNew.placeholder = `New password (min ${policy.password_min_length})`;
    }).catch(() => {});

  // Change password
  const saveBtn = el('settings-pw-save');
  const msgEl = el('settings-pw-msg');
  if (saveBtn) {
    saveBtn.addEventListener('click', async () => {
      const cur = el('settings-pw-current').value;
      const nw = el('settings-pw-new').value;
      const conf = el('settings-pw-confirm').value;
      msgEl.style.color = '';
      if (!cur || !nw) { msgEl.textContent = 'Fill in all fields'; msgEl.style.color = 'var(--red)'; return; }
      if (nw.length < _authPolicy.password_min_length) { msgEl.textContent = `Min ${_authPolicy.password_min_length} characters`; msgEl.style.color = 'var(--red)'; return; }
      if (nw !== conf) { msgEl.textContent = 'Passwords don\'t match'; msgEl.style.color = 'var(--red)'; return; }
      saveBtn.disabled = true;
      try {
        const res = await fetch('/api/auth/change-password', {
          method: 'POST', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ current_password: cur, new_password: nw })
        });
        if (!res.ok) { const d = await res.json(); throw new Error(d.detail || 'Failed'); }
        msgEl.style.color = 'var(--green)';
        msgEl.textContent = 'Password updated';
        el('settings-pw-current').value = '';
        el('settings-pw-new').value = '';
        el('settings-pw-confirm').value = '';
      } catch (e) {
        msgEl.style.color = 'var(--red)';
        msgEl.textContent = e.message;
      } finally {
        saveBtn.disabled = false;
      }
    });
  }

  // ── Two-Factor Authentication ──
  const tfaContent = el('settings-2fa-content');
  if (tfaContent) {
    async function render2FA() {
      try {
        const res = await fetch('/api/auth/2fa/status', { credentials: 'same-origin' });
        const data = await res.json();
        if (data.enabled) {
          // 2FA is ON — show disable option
          tfaContent.innerHTML = `
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;">
              <span style="color:var(--color-save-green, #4caf50);font-size:12px;font-weight:600;">&#x2713; Enabled</span>
              <span style="font-size:11px;opacity:0.5;">Authenticator app required on login</span>
            </div>
            <input id="tfa-disable-pw" type="password" placeholder="Enter password to disable" autocomplete="current-password" style="padding:6px 8px;background:var(--bg);border:1px solid var(--border);border-radius:4px;color:var(--fg);font-family:inherit;font-size:12px;width:100%;box-sizing:border-box;margin-bottom:6px;">
            <div class="settings-row" style="justify-content:flex-end;">
              <span id="tfa-msg" style="font-size:11px;margin-right:auto;"></span>
              <button class="admin-btn-add" id="tfa-disable-btn" style="opacity:0.7;">Disable 2FA</button>
            </div>`;
          el('tfa-disable-btn').addEventListener('click', async () => {
            const pw = el('tfa-disable-pw').value;
            const msg = el('tfa-msg');
            if (!pw) { msg.textContent = 'Enter your password'; msg.style.color = 'var(--red)'; return; }
            try {
              const r = await fetch('/api/auth/2fa/disable', {
                method: 'POST', credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ password: pw })
              });
              if (!r.ok) { const d = await r.json(); throw new Error(d.detail || 'Failed'); }
              render2FA();
            } catch (e) { msg.textContent = e.message; msg.style.color = 'var(--red)'; }
          });
        } else {
          // 2FA is OFF — show setup button
          tfaContent.innerHTML = `
            <div style="font-size:12px;opacity:0.6;margin-bottom:8px;">Add an extra layer of security with an authenticator app (Aegis, Google Authenticator, etc.)</div>
            <div class="settings-row" style="justify-content:flex-end;">
              <span id="tfa-msg" style="font-size:11px;margin-right:auto;"></span>
              <button class="admin-btn-add" id="tfa-setup-btn">Set Up 2FA</button>
            </div>`;
          el('tfa-setup-btn').addEventListener('click', async () => {
            const msg = el('tfa-msg');
            try {
              const r = await fetch('/api/auth/2fa/setup', { method: 'POST', credentials: 'same-origin' });
              if (!r.ok) { const d = await r.json(); throw new Error(d.detail || 'Failed'); }
              const setup = await r.json();
              const qrCode = safeRasterDataUrl(setup.qr_code);
              // Show QR code + manual secret + verify input
              tfaContent.innerHTML = `
                <div style="text-align:center;margin-bottom:12px;">
                  ${qrCode ? `<img src="${esc(qrCode)}" alt="QR Code" style="border-radius:8px;max-width:200px;">` : ''}
                </div>
                <div style="font-size:11px;opacity:0.5;text-align:center;margin-bottom:8px;">
                  Scan with your authenticator app, or enter manually:
                </div>
                <div style="font-family:monospace;font-size:12px;text-align:center;padding:6px;background:var(--bg);border:1px solid var(--border);border-radius:4px;margin-bottom:12px;word-break:break-all;user-select:all;cursor:text;">${esc(setup.secret)}</div>
                <input id="tfa-verify-code" type="text" placeholder="Enter 6-digit code to verify" autocomplete="one-time-code" inputmode="numeric" maxlength="8" style="width:100%;padding:8px;background:var(--bg);border:1px solid var(--border);border-radius:4px;color:var(--fg);font-family:inherit;font-size:13px;box-sizing:border-box;text-align:center;letter-spacing:3px;margin-bottom:6px;">
                <div class="settings-row" style="justify-content:flex-end;">
                  <span id="tfa-msg" style="font-size:11px;margin-right:auto;"></span>
                  <button class="admin-btn-add" id="tfa-cancel-btn" style="opacity:0.5;">Cancel</button>
                  <button class="admin-btn-add" id="tfa-verify-btn">Verify & Enable</button>
                </div>`;
              el('tfa-verify-code').focus();
              el('tfa-cancel-btn').addEventListener('click', () => render2FA());
              el('tfa-verify-btn').addEventListener('click', async () => {
                const code = el('tfa-verify-code').value.trim();
                const vmsg = el('tfa-msg');
                if (!code) { vmsg.textContent = 'Enter the code'; vmsg.style.color = 'var(--red)'; return; }
                try {
                  const vr = await fetch('/api/auth/2fa/confirm', {
                    method: 'POST', credentials: 'same-origin',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ code })
                  });
                  if (!vr.ok) { const d = await vr.json(); throw new Error(d.detail || 'Invalid code'); }
                  const result = await vr.json();
                  // Show backup codes
                  const codes = result.backup_codes || [];
                  tfaContent.innerHTML = `
                    <div style="color:var(--color-save-green, #4caf50);font-size:13px;font-weight:600;margin-bottom:8px;">&#x2713; 2FA Enabled!</div>
                    <div style="font-size:12px;opacity:0.7;margin-bottom:8px;">Save these backup codes somewhere safe. Each can be used once if you lose your authenticator:</div>
                    <div style="font-family:monospace;font-size:12px;padding:8px;background:var(--bg);border:1px solid var(--border);border-radius:4px;columns:2;column-gap:16px;margin-bottom:8px;">${codes.map(c => '<div style="margin-bottom:2px;">' + c + '</div>').join('')}</div>
                    <button class="admin-btn-add" id="tfa-done-btn">Done</button>`;
                  el('tfa-done-btn').addEventListener('click', () => render2FA());
                } catch (e) { vmsg.textContent = e.message; vmsg.style.color = 'var(--red)'; }
              });
            } catch (e) { msg.textContent = e.message; msg.style.color = 'var(--red)'; }
          });
        }
      } catch (_) {
        tfaContent.innerHTML = '<div style="font-size:11px;opacity:0.4;">Could not load 2FA status</div>';
      }
    }
    render2FA();
  }

  // Logout
  const logoutBtn = el('settings-logout-btn');
  if (logoutBtn) {
    logoutBtn.addEventListener('mouseenter', () => { logoutBtn.style.opacity = '1'; logoutBtn.style.borderColor = 'var(--red)'; logoutBtn.style.color = 'var(--red)'; });
    logoutBtn.addEventListener('mouseleave', () => { logoutBtn.style.opacity = ''; logoutBtn.style.borderColor = ''; logoutBtn.style.color = ''; });
    logoutBtn.addEventListener('click', async () => {
      try { await fetch('/api/auth/logout', { method: 'POST' }); } catch (_) {}
      // SECURITY: wipe all client-side state on logout so the next user that
      // signs in on this browser doesn't inherit the previous account's
      // session id, last-used model, draft chat input, or any cached lists.
      // Keep "odysseus-last-user" so the login form remembers the username
      // (if "Remember me" was on). Without this the chat composer pre-loaded
      // the previous user's last model into a fresh session, which read as
      // cross-account leakage.
      try {
        const _keepKeys = new Set(['odysseus-last-user']);
        const _toRemove = [];
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k && !_keepKeys.has(k)) _toRemove.push(k);
        }
        _toRemove.forEach(k => localStorage.removeItem(k));
        sessionStorage.clear();
      } catch (_) {}
      window.location.href = '/login';
    });
  }
}

function initAll() {
  modalEl = el('settings-modal');

  bindSettingsNavigation(modalEl, {
    openAdminTab: _shell.openAdminTab,
    onPanelActivated: _shell.onPanelActivated,
  });

  bindSettingsSearch(modalEl, {
    isAdmin: () => !!window._isAdmin,
    openPanel(tab) {
      const button = modalEl.querySelector(`[data-settings-tab="${tab}"]`);
      if (button) button.click();
    },
  });

  bindSettingsSidebar(modalEl);

  const registryIssues = getSettingsRegistryIssues(modalEl);
  if (registryIssues.length) {
    console.warn('Settings registry/DOM mismatch:', registryIssues);
  }

  bindSettingsDrag(modalEl);

  bindSettingsClose(modalEl, {
    closeSettings: close,
    isTouchInsideModal: () => uiModule.isTouchInsideModal(),
  });

  bindOpenPromptModalLink({
    getModal: () => modalEl,
    closeSettings: close,
  });

  bindSettingsPeekToggle(modalEl);
  initialized = true;
  initDefaultChat();
  initTeacherModel();
  initUtilityModel();
  initImageSettings();
  initVisionSettings();
  initTtsSettings();
  initSttSettings();
  initSearchSettings();
  initResearchSettings();
  initResearchSearchSettings();
  initAgentSettings();
  initAppearance();
  initShortcuts();
  initAccount();
  initIntegrations();
  initEmailSettings();
  initEmailAccountsSettings();
  initReminderSettings();
  initUnifiedIntegrations();
  initDocumentWritingStyle();
}


function notifyIntegrationsChanged() {
  try {
    window.dispatchEvent(new CustomEvent('odysseus-integrations-changed'));
  } catch (_) {}
}

async function initReminderSettings() {
  const root = el('settings-modal');
  if (!root || !root.querySelector('[data-settings-panel="reminders"]')) return;

  // Public URL field (used for deep-links in outgoing alert emails)
  const pubUrlIn = el('set-app-public-url');
  const pubUrlMsg = el('set-app-public-url-msg');
  if (pubUrlIn) {
    try {
      const r = await fetch('/api/auth/settings', { credentials: 'same-origin' });
      const s = await r.json();
      pubUrlIn.value = s.app_public_url || '';
    } catch (_) {}
    let pubDebounce;
    pubUrlIn.addEventListener('input', () => {
      clearTimeout(pubDebounce);
      pubDebounce = setTimeout(async () => {
        try {
          const val = pubUrlIn.value.trim().replace(/\/+$/, '');
          await _postSettings({ app_public_url: val });
          if (pubUrlMsg) {
            pubUrlMsg.textContent = val ? 'Saved' : 'Cleared (deep-links disabled)';
            pubUrlMsg.style.color = 'var(--green,#50fa7b)';
            setTimeout(() => { pubUrlMsg.textContent = ''; }, 2000);
          }
        } catch (_) {
          if (pubUrlMsg) { pubUrlMsg.textContent = 'Save failed'; pubUrlMsg.style.color = 'var(--red)'; }
        }
      }, 600);
    });
  }

  const channelSel = el('set-reminder-channel');
  const emailOpt = el('set-reminder-channel-email-opt');
  const ntfyOpt = el('set-reminder-channel-ntfy-opt');
  const webhookOpt = el('set-reminder-channel-webhook-opt');
  const hint = el('set-reminder-channel-hint');
  const llmToggle = el('set-reminder-llm-toggle');
  // "Integrations" link in the channel-hint copy. Jumps to the
  // Integrations tab so the user can configure the underlying accounts
  // (email, ntfy server) the channel dropdown depends on. Idempotent.
  const openIntgBtn = el('set-reminders-open-integrations');
  if (openIntgBtn && !openIntgBtn.dataset.wired) {
    openIntgBtn.dataset.wired = '1';
    openIntgBtn.addEventListener('click', (e) => {
      e.preventDefault();
      const target = modalEl?.querySelector('[data-settings-tab="integrations"]');
      if (target) target.click();
    });
  }
  if (!channelSel || !llmToggle) return;

  // Detect configured email accounts. The legacy single-account
  // `/api/email/config` endpoint was a no-op stub for most installs;
  // the real per-account list lives at `/api/email/accounts` and is
  // what the Integrations panel manages. Treat the email channel as
  // configured if there's at least one account with SMTP set.
  let emailAccounts = [];
  const smtpAccountReady = (account) => !!(
    account.smtp_host
    && account.smtp_user
    && (account.has_smtp_password || account.oauth_provider === 'google')
  );
  try {
    const res = await fetch('/api/email/accounts', { credentials: 'same-origin' });
    if (res.ok) {
      const d = await res.json();
      emailAccounts = (d.accounts || []).filter(smtpAccountReady);
    }
  } catch (_) {}
  let smtpConfigured = emailAccounts.length > 0;

  if (!smtpConfigured && emailOpt) {
    emailOpt.disabled = true;
    emailOpt.textContent = 'Email (add an account in Integrations)';
  }

  // Detect whether ntfy integration exists — try admin endpoint, fall back to
  // checking if an ntfy integration was saved in settings (non-admin users).
  let ntfyConfigured = false;
  try {
    const res = await fetch('/api/auth/integrations', { credentials: 'same-origin' });
    if (res.ok) {
      const data = await res.json();
      ntfyConfigured = (data.integrations || []).some(
        i => (i.preset === 'ntfy' || (i.name || '').toLowerCase() === 'ntfy') && i.enabled !== false && i.base_url
      );
    }
  } catch (_) {}
  // If admin check failed, check if ntfy was previously selected (trust the saved setting)
  if (!ntfyConfigured) {
    try {
      const res = await fetch('/api/auth/settings', { credentials: 'same-origin' });
      const s = await res.json();
      if (s.reminder_channel === 'ntfy') ntfyConfigured = true;
    } catch (_) {}
  }

  if (!ntfyConfigured && ntfyOpt) {
    ntfyOpt.disabled = true;
    ntfyOpt.textContent = 'ntfy (add in Integrations first)';
  }

  // Webhook: available whenever at least one integration with a base_url exists.
  // The user picks which integration to target and supplies a payload template.
  let allIntegrations = [];
  let webhookConfigured = false;
  try {
    const res = await fetch('/api/auth/integrations', { credentials: 'same-origin' });
    if (res.ok) {
      const data = await res.json();
      allIntegrations = (data.integrations || []).filter(i => i.base_url && i.enabled !== false);
      webhookConfigured = allIntegrations.length > 0;
    }
  } catch (_) {}
  if (!webhookConfigured && webhookOpt) {
    webhookOpt.disabled = true;
    webhookOpt.textContent = 'Webhook (add an Integration first)';
  }

  const emailFromRow = el('set-reminder-email-from-row');
  const emailAcctSel = el('set-reminder-email-account');
  const emailToRow = el('set-reminder-email-to-row');
  const emailToIn = el('set-reminder-email-to');
  const ntfyTopicRow = el('set-reminder-ntfy-topic-row');
  const ntfyTopicIn = el('set-reminder-ntfy-topic');
  const webhookIntgRow = el('set-reminder-webhook-intg-row');
  const webhookIntgSel = el('set-reminder-webhook-intg');
  const webhookTemplateRow = el('set-reminder-webhook-template-row');
  const webhookTemplateIn = el('set-reminder-webhook-template');

  function populateReminderEmailAccounts(selectedId = '') {
    if (!emailAcctSel) return;
    emailAcctSel.innerHTML = emailAccounts.map(a =>
      `<option value="${a.id}">${esc(a.name || a.from_address || a.imap_user || 'Unnamed')}${a.is_default ? ' (default)' : ''}</option>`
    ).join('');
    const fallback = (emailAccounts.find(a => a.is_default) || emailAccounts[0] || {}).id || '';
    emailAcctSel.value = (selectedId && emailAccounts.some(a => a.id === selectedId)) ? selectedId : fallback;
  }

  function populateWebhookIntegrations(selectedId = '') {
    if (!webhookIntgSel) return;
    webhookIntgSel.innerHTML = allIntegrations.length
      ? allIntegrations.map(i => `<option value="${esc(i.id)}">${esc(i.name || i.id)}</option>`).join('')
      : '<option value="">No integrations configured</option>';
    if (selectedId && allIntegrations.some(i => i.id === selectedId)) webhookIntgSel.value = selectedId;
  }

  function applyReminderChannelAvailability() {
    if (emailOpt) {
      emailOpt.disabled = !smtpConfigured;
      emailOpt.textContent = smtpConfigured ? 'Email' : 'Email (add an account in Integrations)';
    }
    if (ntfyOpt) {
      ntfyOpt.disabled = !ntfyConfigured;
      ntfyOpt.textContent = ntfyConfigured ? 'ntfy' : 'ntfy (add in Integrations first)';
    }
    if (webhookOpt) {
      webhookOpt.disabled = !webhookConfigured;
      webhookOpt.textContent = webhookConfigured ? 'Webhook' : 'Webhook (add an Integration first)';
    }
  }

  async function refreshReminderChannelAvailability() {
    const currentChannel = channelSel.value || 'browser';
    const currentEmailAccount = emailAcctSel?.value || '';
    const currentWebhookIntg = webhookIntgSel?.value || '';
    try {
      const res = await fetch('/api/email/accounts', { credentials: 'same-origin' });
      if (res.ok) {
        const d = await res.json();
        emailAccounts = (d.accounts || []).filter(smtpAccountReady);
      }
    } catch (_) {}
    smtpConfigured = emailAccounts.length > 0;

    ntfyConfigured = false;
    try {
      const res = await fetch('/api/auth/integrations', { credentials: 'same-origin' });
      if (res.ok) {
        const data = await res.json();
        ntfyConfigured = (data.integrations || []).some(
          i => (i.preset === 'ntfy' || (i.name || '').toLowerCase() === 'ntfy') && i.enabled !== false && i.base_url
        );
        allIntegrations = (data.integrations || []).filter(i => i.base_url && i.enabled !== false);
        webhookConfigured = allIntegrations.length > 0;
      }
    } catch (_) {}
    if (!ntfyConfigured) {
      try {
        const res = await fetch('/api/auth/settings', { credentials: 'same-origin' });
        const s = await res.json();
        if (s.reminder_channel === 'ntfy') ntfyConfigured = true;
      } catch (_) {}
    }

    applyReminderChannelAvailability();
    populateReminderEmailAccounts(currentEmailAccount);
    populateWebhookIntegrations(currentWebhookIntg);
    if (currentChannel === 'email' && !smtpConfigured) channelSel.value = 'browser';
    else if (currentChannel === 'ntfy' && !ntfyConfigured) channelSel.value = 'browser';
    else if (currentChannel === 'webhook' && !webhookConfigured) channelSel.value = 'browser';
    else channelSel.value = currentChannel;
    if (hint) hint.textContent = CHANNEL_HINTS[channelSel.value] || '';
    syncChannelRows();
  }

  // Populate the "Send from" picker with all configured email accounts.
  populateReminderEmailAccounts();

  function syncChannelRows() {
    const isEmail = channelSel.value === 'email';
    const isWebhook = channelSel.value === 'webhook';
    if (emailFromRow) emailFromRow.style.display = (isEmail && emailAccounts.length > 1) ? 'flex' : 'none';
    if (emailToRow) emailToRow.style.display = isEmail ? 'flex' : 'none';
    if (ntfyTopicRow) ntfyTopicRow.style.display = channelSel.value === 'ntfy' ? 'flex' : 'none';
    if (webhookIntgRow) webhookIntgRow.style.display = isWebhook ? 'flex' : 'none';
    if (webhookTemplateRow) webhookTemplateRow.style.display = isWebhook ? 'flex' : 'none';
  }

  // Browser notifications fire on EVERY reminder (see
  // routes/note_routes.py — the in-app notif is always queued
  // regardless of channel). The hint should make that clear so
  // users don't think they have to choose between channels.
  const CHANNEL_HINTS = {
    browser: 'Reminders appear as browser notifications inside Odysseus.',
    email: 'Reminders are emailed and shown as a browser notification.',
    ntfy: 'Reminders are pushed via ntfy AND shown as a browser notification.',
    webhook: 'Reminders are POSTed to the selected integration AND shown as a browser notification. Use {{title}} and {{message}} in the payload template.',
  };

  applyReminderChannelAvailability();
  if (!channelSel.dataset.integrationRefreshWired) {
    channelSel.dataset.integrationRefreshWired = '1';
    window.addEventListener('odysseus-integrations-changed', () => {
      refreshReminderChannelAvailability().catch(e => console.warn('Failed to refresh reminder channels', e));
    });
  }

  // Default payload templates for known presets — auto-filled when the user
  // picks a matching integration so they don't have to write JSON from scratch.
  // Defined here (before the load block) so both the load path and the change
  // handler can reference it.
  const WEBHOOK_PRESET_TEMPLATES = {
    discord_webhook: '{"embeds": [{"title": "{{title}}", "description": "{{message}}", "color": 5793266}]}',
  };

  try {
    const res = await fetch('/api/auth/settings', { credentials: 'same-origin' });
    const s = await res.json();
    let savedChannel = s.reminder_channel || 'browser';
    if (savedChannel === 'email' && !smtpConfigured) savedChannel = 'browser';
    if (savedChannel === 'ntfy' && !ntfyConfigured) savedChannel = 'browser';
    if (savedChannel === 'webhook' && !webhookConfigured) savedChannel = 'browser';
    channelSel.value = savedChannel;
    llmToggle.checked = !!s.reminder_llm_synthesis;
    // Persona dropdown — populate from built-in PROMPT_TEMPLATES (characters)
    // plus any custom character preset. Selected value persists to
    // reminder_llm_persona (backend hook lives in src/notes.py once
    // /api/notes/fire-reminder lands).
    const personaSel = el('set-reminder-llm-persona');
    if (personaSel) {
      try {
        const presetsMod = await import('./presets.js?v=20260908personaname1');
        const tpl = presetsMod.PROMPT_TEMPLATES || [];
        const chars = tpl.filter(t => t.isCharacter);
        for (const c of chars) {
          const opt = document.createElement('option');
          opt.value = c.id;
          opt.textContent = c.name;
          personaSel.appendChild(opt);
        }
        // Custom character (single-slot preset)
        try {
          const all = (presetsMod.getAllPresets && presetsMod.getAllPresets()) || {};
          if (all.custom && all.custom.character_name) {
            const opt = document.createElement('option');
            opt.value = 'custom';
            opt.textContent = all.custom.character_name + ' (custom)';
            personaSel.appendChild(opt);
          }
        } catch (_) {}
      } catch (_) {}
      personaSel.value = s.reminder_llm_persona || '';
      personaSel.addEventListener('change', () => {
        save({ reminder_llm_persona: personaSel.value });
      });
    }
    if (emailToIn) emailToIn.value = s.reminder_email_to || '';
    if (ntfyTopicIn) ntfyTopicIn.value = s.reminder_ntfy_topic || 'Reminders';
    populateWebhookIntegrations(s.reminder_webhook_integration_id || '');
    if (webhookTemplateIn) {
      webhookTemplateIn.value = s.reminder_webhook_payload_template || '';
      // If an integration is already selected but no template was ever saved,
      // auto-fill with the preset default so the first test works out of the box.
      if (!webhookTemplateIn.value && webhookIntgSel?.value) {
        const intg = allIntegrations.find(i => i.id === webhookIntgSel.value);
        const tpl = WEBHOOK_PRESET_TEMPLATES[intg?.preset] || '';
        if (tpl) { webhookTemplateIn.value = tpl; save({ reminder_webhook_payload_template: tpl }); }
      }
    }
    // Restore the previously-picked email account (if any), otherwise
    // default to the account flagged is_default in the integrations
    // list. Falls through to the first option if neither exists.
    if (emailAcctSel) {
      const savedId = s.reminder_email_account_id;
      populateReminderEmailAccounts(savedId || '');
      if (emailAcctSel.value && emailAcctSel.value !== (savedId || '')) {
        save({ reminder_email_account_id: emailAcctSel.value || null });
      }
    }
    if (hint) hint.textContent = CHANNEL_HINTS[channelSel.value] || '';
    syncChannelRows();
  } catch (e) { console.warn('Failed to load reminder settings', e); }

  async function save(patch) {
    try {
      await _postSettings(patch);
    } catch (e) { console.warn('Failed to save reminder settings', e); }
  }

  channelSel.addEventListener('change', () => {
    if (hint) hint.textContent = CHANNEL_HINTS[channelSel.value] || '';
    syncChannelRows();
    save({ reminder_channel: channelSel.value });
    // Email reminder bell visibility tracks this — broadcast so the
    // email library can re-evaluate without waiting for a re-open.
    try { window.dispatchEvent(new CustomEvent('odysseus-reminder-channel-changed', { detail: { channel: channelSel.value } })); } catch (_) {}
  });
  if (emailToIn) {
    let emailDebounce;
    emailToIn.addEventListener('input', () => {
      clearTimeout(emailDebounce);
      emailDebounce = setTimeout(() => save({ reminder_email_to: emailToIn.value.trim() }), 600);
    });
  }
  if (emailAcctSel) {
    emailAcctSel.addEventListener('change', () => {
      save({ reminder_email_account_id: emailAcctSel.value || null });
    });
  }
  if (ntfyTopicIn) {
    let topicDebounce;
    ntfyTopicIn.addEventListener('input', () => {
      clearTimeout(topicDebounce);
      topicDebounce = setTimeout(() => save({ reminder_ntfy_topic: ntfyTopicIn.value.trim() || 'reminders' }), 600);
    });
  }
  if (webhookIntgSel) {
    webhookIntgSel.addEventListener('change', () => {
      save({ reminder_webhook_integration_id: webhookIntgSel.value || '' });
      // If the template is empty and we recognise the integration's preset,
      // pre-fill with a sensible default so users can test immediately.
      if (webhookTemplateIn && !webhookTemplateIn.value.trim()) {
        const intg = allIntegrations.find(i => i.id === webhookIntgSel.value);
        const tpl = WEBHOOK_PRESET_TEMPLATES[intg?.preset] || '';
        if (tpl) {
          webhookTemplateIn.value = tpl;
          save({ reminder_webhook_payload_template: tpl });
        }
      }
    });
  }
  if (webhookTemplateIn) {
    let templateDebounce;
    webhookTemplateIn.addEventListener('input', () => {
      clearTimeout(templateDebounce);
      templateDebounce = setTimeout(() => save({ reminder_webhook_payload_template: webhookTemplateIn.value.trim() }), 600);
    });
  }
  // Dim the whole AI Synthesis card when off (matches Vision/Utility/etc.).
  function syncSynthesisDim() {
    const card = llmToggle.closest('.admin-card');
    if (card) card.style.opacity = llmToggle.checked ? '' : '0.45';
  }
  syncSynthesisDim();
  llmToggle.addEventListener('change', () => {
    syncSynthesisDim();
    save({ reminder_llm_synthesis: llmToggle.checked });
  });

  // Test button
  const testBtn = el('set-reminder-test-btn');
  const testMsg = el('set-reminder-test-msg');
  if (testBtn) {
    testBtn.addEventListener('click', async () => {
      testBtn.disabled = true;
      if (testMsg) { testMsg.textContent = 'Sending'; testMsg.style.color = 'var(--fg)'; }
      // Whirlpool loader right next to the "Sending" text while it sends.
      let _testSpin = null;
      try {
        const _sp = (await import('./spinner.js')).default;
        _testSpin = _sp.createWhirlpool(14);
        _testSpin.element.style.cssText = 'width:14px;height:14px;margin:0 0 0 7px;display:inline-block;vertical-align:middle;';
        (testMsg || testBtn).insertAdjacentElement('afterend', _testSpin.element);
      } catch (_) {}
      const _stopTestSpin = () => { try { _testSpin && _testSpin.stop(); _testSpin && _testSpin.element.remove(); } catch (_) {} };
      try {
        // Persona picker is in a different scope (Reminders init), look it up
        // by id so we can pass whatever is currently selected on screen.
        const personaSel = el('set-reminder-llm-persona');
        const res = await fetch('/api/notes/fire-reminder', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            note_id: 'test-' + Date.now(),
            title: 'Test Reminder',
            body: 'This is a test reminder to verify your settings are working.',
            channel: channelSel.value,
            // Mirror the in-UI AI Synthesis toggle + persona so the test never
            // races a pending save and lets the user preview changes before
            // hitting Save.
            llm_synthesis: !!(llmToggle && llmToggle.checked),
            llm_persona: (personaSel && personaSel.value) || '',
            ...(channelSel.value === 'webhook' ? {
              webhook_integration_id: webhookIntgSel?.value || '',
              webhook_payload_template: webhookTemplateIn?.value.trim() || '',
            } : {}),
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || 'Server error');
        if (channelSel.value === 'email' && !data.email_sent) {
          throw new Error(data.email_error || 'Email reminder was not sent');
        }
        if (channelSel.value === 'ntfy' && !data.ntfy_sent) {
          throw new Error(data.ntfy_error || 'ntfy reminder was not sent');
        }
        if (channelSel.value === 'webhook' && !data.webhook_sent) {
          const activeChannel = data.channel ? ` (server used channel: "${data.channel}")` : '';
          throw new Error((data.webhook_error || 'Webhook reminder was not sent') + activeChannel);
        }
        let status = 'Delivered via ' + channelSel.value;
        if (data.synthesis) status += ' (AI: "' + data.synthesis.slice(0, 60) + '...")';
        if (data.email_sent) status += ' — email sent';
        if (data.ntfy_sent) status += ' — ntfy sent';
        if (data.webhook_sent) status += ' — webhook sent';
        if (testMsg) { testMsg.textContent = status; testMsg.style.color = 'var(--green, #50fa7b)'; }
        // Also fire a browser notification so user can see it
        if ('Notification' in window && Notification.permission === 'granted') {
          try {
            new Notification('Test Reminder', {
              body: data.synthesis || 'This is a test reminder.',
              tag: 'reminder-test',
              icon: '/static/favicon.ico',
            });
          } catch {}
        }
      } catch (e) {
        if (testMsg) { testMsg.textContent = 'Failed: ' + e.message; testMsg.style.color = 'var(--red)'; }
      } finally {
        _stopTestSpin();
        testBtn.disabled = false;
      }
    });
  }
}

async function initEmailAccountsSettings() {
  const root = el('settings-modal');
  if (!root || !root.querySelector('[data-settings-panel="email"]')) return;

  const emailPreferences = el('settings-email-preferences');
  if (emailPreferences && emailPreferences.dataset.emailSettingsBound !== '1') {
    emailPreferences.dataset.emailSettingsBound = '1';
    try {
      const mod = await import('./emailLibrary.js?v=20260915trashmove2');
      if (typeof mod.mountEmailSettings === 'function') {
        await mod.mountEmailSettings(emailPreferences);
      }
    } catch (e) {
      console.warn('Failed to mount Email settings', e);
    }
  }
  const manageBtn = el('set-email-open-integrations');
  if (manageBtn && manageBtn.dataset.bound !== '1') {
    manageBtn.dataset.bound = '1';
    manageBtn.addEventListener('click', () => open('integrations'));
  }
  const tasksBtn = el('set-email-open-tasks');
  if (tasksBtn && tasksBtn.dataset.bound !== '1') {
    tasksBtn.dataset.bound = '1';
    tasksBtn.addEventListener('click', async () => {
      try {
        const mod = await import('./tasks.js?v=20260914taskmodel1');
        const openTasks = mod.openTasks || (mod.default && mod.default.openTasks);
        if (typeof openTasks === 'function') openTasks(null, { filter: 'Email' });
        else document.getElementById('tool-tasks-btn')?.click();
      } catch (_) {
        document.getElementById('tool-tasks-btn')?.click();
      }
    });
  }
  const listEl = el('set-email-accounts-list');
  const msgEl = el('set-email-accounts-msg');
  const formEl = el('set-email-accounts-form');
  const addBtn = el('set-email-accounts-add-btn');
  if (!listEl || !addBtn || !formEl) return;

  const esc = s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  async function fetchAccounts() {
    const r = await fetch('/api/email/accounts', { credentials: 'same-origin' });
    const d = await r.json();
    return d.accounts || [];
  }

  function renderRow(a) {
    const imap = a.imap_host ? `${a.imap_host}:${a.imap_port}` : '<no IMAP>';
    const badge = a.is_default
      ? '<span style="font-size:9px;text-transform:uppercase;letter-spacing:0.5px;padding:1px 6px;border-radius:3px;background:color-mix(in srgb, var(--accent,#50fa7b) 15%, transparent);color:var(--accent,#50fa7b)">Default</span>'
      : (a.enabled ? '' : '<span style="font-size:9px;text-transform:uppercase;letter-spacing:0.5px;padding:1px 6px;border-radius:3px;opacity:0.4">Disabled</span>');
    return `<div class="email-account-row" data-acc-id="${esc(a.id)}" style="display:flex;align-items:center;gap:10px;padding:8px 10px;border:1px solid var(--border);border-radius:6px">
      <div style="flex:1;min-width:0">
        <div style="font-size:12px;font-weight:600;display:flex;align-items:center;gap:6px">${esc(a.name)} ${badge}</div>
        <div style="font-size:11px;opacity:0.6;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(a.imap_user || a.from_address || '')} — ${esc(imap)}</div>
      </div>
      ${a.is_default ? '' : `<button class="admin-btn-sm email-acc-default-btn" style="font-size:10px">Make Default</button>`}
      <button class="admin-btn-sm email-acc-edit-btn" style="font-size:10px">Edit</button>
      <button class="admin-btn-sm email-acc-del-btn" style="font-size:10px;opacity:0.6">Delete</button>
    </div>`;
  }

  async function renderList() {
    const accs = await fetchAccounts();
    if (!accs.length) {
      listEl.innerHTML = '<div style="padding:12px;opacity:0.5;font-size:12px;text-align:center">No email accounts configured</div>';
      return;
    }
    listEl.innerHTML = accs.map(renderRow).join('');
    listEl.querySelectorAll('.email-account-row').forEach(row => {
      const id = row.dataset.accId;
      row.querySelector('.email-acc-default-btn')?.addEventListener('click', async (e) => {
        e.stopPropagation();
        await fetch(`/api/email/accounts/${id}/set-default`, { method: 'POST', credentials: 'same-origin' });
        renderList();
      });
      row.querySelector('.email-acc-edit-btn')?.addEventListener('click', (e) => {
        e.stopPropagation();
        showForm(accs.find(a => a.id === id));
      });
      row.querySelector('.email-acc-del-btn')?.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!await window.styledConfirm(`Delete account "${accs.find(a => a.id === id)?.name}"?`, { confirmText: 'Delete', danger: true })) return;
        await fetch(`/api/email/accounts/${id}`, { method: 'DELETE', credentials: 'same-origin' });
        renderList();
      });
    });
  }

  function showForm(existing) {
    const a = existing || {};
    const isEdit = !!existing;
    formEl.style.display = '';
    // Small `?` indicator next to each label. Hover/focus to read the
    // hint via the native `title` tooltip. tabindex makes it
    // keyboard-focusable too.
    const _hint = (tip) =>
      `<span class="eaf-hint" title="${esc(tip)}" aria-label="${esc(tip)}" tabindex="0" `
      + `style="display:inline-block;width:13px;height:13px;border-radius:50%;`
      + `border:1px solid currentColor;font-size:9px;line-height:11px;text-align:center;`
      + `opacity:0.45;margin-left:5px;cursor:help;vertical-align:1px;font-weight:600;">?</span>`;
    // Provider presets — picking one fills host/port/STARTTLS for both
    // IMAP and SMTP. Dovecot is IMAP-only here; the host is intentionally
    // blank because it may live on another machine (DNS, LAN, Tailscale).
    const PROVIDERS = {
      gmail:             { label: 'Gmail',                       imap: { host: 'imap.gmail.com',        port: 993, starttls: false }, smtp: { host: 'smtp.gmail.com',        port: 465 } },
      google_workspace:  { label: 'Google Workspace / .edu',   imap: { host: 'imap.gmail.com',        port: 993, starttls: false }, smtp: { host: 'smtp.gmail.com',        port: 587 }, oauth: 'google' },
      migadu:            { label: 'Migadu',                     imap: { host: 'imap.migadu.com',       port: 993, starttls: false }, smtp: { host: 'smtp.migadu.com',       port: 465 } },
      icloud:            { label: 'iCloud',                     imap: { host: 'imap.mail.me.com',      port: 993, starttls: false }, smtp: { host: 'smtp.mail.me.com',      port: 587 } },
      outlook:           { label: 'Outlook / Office 365',       imap: { host: 'outlook.office365.com', port: 993, starttls: false }, smtp: { host: 'smtp.office365.com',    port: 587 } },
      fastmail:          { label: 'Fastmail',                   imap: { host: 'imap.fastmail.com',     port: 993, starttls: false }, smtp: { host: 'smtp.fastmail.com',     port: 465 } },
      yahoo:             { label: 'Yahoo',                      imap: { host: 'imap.mail.yahoo.com',   port: 993, starttls: false }, smtp: { host: 'smtp.mail.yahoo.com',   port: 465 } },
      dovecot:           { label: 'Dovecot IMAP (no SMTP)',     imap: { host: '',                      port: 31143, starttls: false }, smtp: { host: '',                     port: 465 } },
    };
    const _providerOptions = Object.entries(PROVIDERS)
      .map(([k, v]) => `<option value="${k}">${esc(v.label)}</option>`)
      .join('');
    const _smtpSecurity = (acct) => acct?.smtp_security || ((parseInt(acct?.smtp_port || 465) === 587) ? 'starttls' : 'ssl');
    formEl.innerHTML = `
      <h3 style="font-size:12px;margin:0 0 8px">${isEdit ? 'Edit Account' : 'New Account'}</h3>
      <div class="settings-col">
        <div class="settings-row"><label class="settings-label">Provider${_hint('Pick a known provider to auto-fill the IMAP and SMTP host/port. Choose Custom to type your own.')}</label><select id="eaf-provider" class="settings-select"><option value="">Custom…</option>${_providerOptions}</select></div>
        <div id="eaf-provider-note" style="display:none;font-size:11px;line-height:1.5;padding:8px 10px;margin:2px 0 4px;border:1px solid color-mix(in srgb, var(--fg) 15%, transparent);border-left:3px solid var(--accent, var(--red));border-radius:4px;background:color-mix(in srgb, var(--fg) 4%, transparent);"></div>
        <div class="settings-row"><label class="settings-label">Name${_hint('Optional label for this account (e.g. “Work” or “Personal”). Leave blank to use the email address.')}</label><input id="eaf-name" class="settings-input" placeholder="(optional — leave blank to use email)" value="${esc(a.name || '')}"></div>
        <div class="settings-row"><label class="settings-label">Email${_hint('Your email address. Used as the From: header on outgoing mail and as the display label when Name is blank.')}</label><input id="eaf-from" class="settings-input" placeholder="you@example.com" value="${esc(a.from_address || '')}"></div>
        <div class="settings-row"><label class="settings-label">Display Name${_hint('Your name as it appears in the From: field of emails you send, e.g. Jane Smith. Auto-filled from Google during OAuth.')}</label><input id="eaf-display-name" class="settings-input" placeholder="Your Name" value="${esc(a.display_name || '')}"></div>
        <div id="eaf-oauth-section" style="display:none;margin:8px 0;padding:10px;border:1px solid var(--border);border-radius:6px;background:color-mix(in srgb,var(--accent,#50fa7b) 6%,transparent)">
          <div style="font-size:11px;font-weight:600;margin-bottom:6px">Google OAuth2 — required for Workspace / .edu accounts</div>
          <p class="integration-help">The deployment may already have a Google OAuth client. Only if Connect with Google cannot start, ask the Odysseus deployment administrator to configure it—users do not need to edit environment files.</p>
          <ol class="integration-help"><li><a href="https://console.cloud.google.com/apis/library/gmail.googleapis.com" target="_blank" rel="noopener noreferrer">Enable the Gmail API</a> in the Google Cloud project.</li><li>Configure the <a href="https://console.cloud.google.com/auth/overview" target="_blank" rel="noopener noreferrer">OAuth consent screen</a>, including audience and any required test users.</li><li>Create a Web application OAuth client in <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noopener noreferrer">Credentials</a>; register the exact redirect URI supplied by this Odysseus deployment. Ask its administrator for that URI—do not guess.</li><li>The administrator configures the client credentials, then you can use Connect with Google and complete consent yourself.</li></ol>
          <div id="eaf-oauth-status" style="font-size:11px;opacity:0.7;margin-bottom:6px">${a.oauth_provider === 'google' ? '✓ Connected via Google OAuth' : 'Not connected — click below to authorize'}</div>
          <button type="button" id="eaf-oauth-btn" class="admin-btn-add" style="font-size:11px">${a.oauth_provider === 'google' ? 'Reconnect with Google' : 'Connect with Google'}</button>
        </div>
        <div style="font-size:11px;font-weight:600;opacity:0.6;margin:6px 0 2px">IMAP (Receiving)</div>
        <div class="settings-row"><label class="settings-label">Host${_hint('Your IMAP server, e.g. imap.gmail.com, imap.migadu.com, a LAN host, or a Tailscale IP for Dovecot.')}</label><input id="eaf-imap-host" class="settings-input" value="${esc(a.imap_host || '')}"></div>
        <div class="settings-row"><label class="settings-label">Port${_hint('993 for IMAPS (most providers), 143 for plain or STARTTLS. Local servers often use a custom port like 31143.')}</label><input id="eaf-imap-port" class="settings-input" type="number" value="${esc(a.imap_port || 993)}" style="max-width:100px"></div>
        <div class="settings-row"><label class="settings-label">Username${_hint('Usually your full email address.')}</label><input id="eaf-imap-user" class="settings-input" value="${esc(a.imap_user || '')}"></div>
        <div class="eaf-password-section"><div class="settings-row"><label class="settings-label">Password${_hint('Your IMAP login password. Use an app-specific password if your provider requires 2FA. Outlook / Office 365 generally requires OAuth and will not work with a normal password here.')}</label><input id="eaf-imap-pass" class="settings-input" type="password" placeholder="${isEdit && a.has_imap_password ? '(unchanged)' : ''}"></div></div>
        <div class="settings-row"><label class="settings-label">STARTTLS${_hint('Turn ON for port 143/587 to upgrade plain to TLS. Turn OFF for port 993 (IMAPS — already encrypted) or a local server with no TLS configured.')}</label><label class="admin-switch"><input type="checkbox" id="eaf-imap-starttls" ${a.imap_starttls !== false ? 'checked' : ''}><span class="admin-slider"></span></label></div>
        <div style="font-size:11px;font-weight:600;opacity:0.6;margin:8px 0 2px">SMTP (Sending) <span style="font-weight:normal;opacity:0.7">— optional, leave blank for read-only</span></div>
        <div class="settings-row"><label class="settings-label">Host${_hint('Your outgoing-mail server, e.g. smtp.gmail.com, smtp.migadu.com. Leave blank to make this account read-only.')}</label><input id="eaf-smtp-host" class="settings-input" value="${esc(a.smtp_host || '')}"></div>
        <div class="settings-row"><label class="settings-label">Port${_hint('465 for SSL/SMTPS, 587 for STARTTLS. 25 is usually blocked by ISPs.')}</label><input id="eaf-smtp-port" class="settings-input" type="number" value="${esc(a.smtp_port || 465)}" style="max-width:100px"></div>
        <div class="settings-row"><label class="settings-label">Security${_hint('SSL for port 465, STARTTLS for port 587, or None for local SMTP bridges such as Proton Mail Bridge.')}</label><select id="eaf-smtp-security" class="settings-select"><option value="ssl">SSL</option><option value="starttls">STARTTLS</option><option value="none">None</option></select></div>
        <div class="settings-row"><label class="settings-label">Same as IMAP${_hint('Use the IMAP username and password for SMTP too (this is right for almost every provider). Turn off to enter separate SMTP credentials.')}</label><label class="admin-switch"><input type="checkbox" id="eaf-smtp-same" ${(!isEdit || (a.smtp_user && a.imap_user && a.smtp_user === a.imap_user)) ? 'checked' : ''}><span class="admin-slider"></span></label></div>
        <div class="settings-row eaf-smtp-creds"><label class="settings-label">Username${_hint('Usually the same as your IMAP username (your email address).')}</label><input id="eaf-smtp-user" class="settings-input" value="${esc(a.smtp_user || '')}"></div>
        <div class="settings-row eaf-smtp-creds"><label class="settings-label">Password${_hint('Your SMTP password — often the same as your IMAP password. Outlook / Office 365 generally requires OAuth and will not work with a normal password here.')}</label><input id="eaf-smtp-pass" class="settings-input" type="password" placeholder="${isEdit && a.has_smtp_password ? '(unchanged)' : ''}"></div>
        <div class="settings-row" style="margin-top:10px;align-items:center;">
          <button class="admin-btn-add" id="eaf-save" style="background:var(--red);border-color:var(--red);color:#fff;display:inline-flex;align-items:center;gap:5px;font-weight:600;">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>
            ${isEdit ? 'Save' : 'Create'}
          </button>
          <span id="eaf-msg" style="font-size:11px;flex:1;margin-left:8px;"></span>
          <button class="admin-btn-add" id="eaf-cancel" style="opacity:0.7;display:inline-flex;align-items:center;gap:5px;position:relative;top:1px;margin-left:auto;">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            Cancel
          </button>
        </div>
      </div>
    `;

    // Show/hide OAuth section and password fields based on provider selection.
    function _syncOauthUI(providerKey) {
      const p = PROVIDERS[providerKey];
      const isOauth = !!(p && p.oauth);
      el('eaf-oauth-section').style.display = isOauth ? '' : 'none';
      formEl.querySelectorAll('.eaf-password-section').forEach(r => {
        r.style.display = isOauth ? 'none' : '';
      });
    }

    const eafProviderNotes = {
      outlook: {
        title: 'Outlook / Office 365 needs OAuth',
        body: 'Microsoft disables normal password login for IMAP/SMTP in most Outlook and Microsoft 365 accounts. Odysseus does not support Microsoft OAuth/Graph mail yet, so this preset is only a placeholder for future support.',
      },
    };
    const eafNoteEl = el('eaf-provider-note');
    const _renderEafProviderNote = (key) => {
      const n = eafProviderNotes[key];
      if (!eafNoteEl || !n) {
        if (eafNoteEl) {
          eafNoteEl.style.display = 'none';
          eafNoteEl.innerHTML = '';
        }
        return;
      }
      eafNoteEl.style.display = '';
      eafNoteEl.innerHTML = `<div style="font-weight:600;margin-bottom:3px;">${esc(n.title)}</div><div style="opacity:0.8;">${esc(n.body)}</div>`;
    };

    // Provider preset → autofill host/port/STARTTLS for both halves.
    el('eaf-provider').addEventListener('change', (e) => {
      _renderEafProviderNote(e.target.value);
      const p = PROVIDERS[e.target.value];
      if (!p) { _syncOauthUI(''); return; }
      el('eaf-imap-host').value = p.imap.host;
      el('eaf-imap-port').value = p.imap.port;
      el('eaf-imap-starttls').checked = !!p.imap.starttls;
      el('eaf-smtp-host').value = p.smtp.host;
      el('eaf-smtp-port').value = p.smtp.port;
      el('eaf-smtp-security').value = p.smtp.security || ((parseInt(p.smtp.port || 465) === 587) ? 'starttls' : 'ssl');
      _syncOauthUI(e.target.value);
    });

    // Init OAuth UI for accounts already connected via OAuth.
    if (a.oauth_provider === 'google') _syncOauthUI('google_workspace');

    // "Connect with Google" button — save the account first, then redirect to OAuth.
    el('eaf-oauth-btn').addEventListener('click', async () => {
      // Must save the account first to get an account_id to pass to the OAuth flow.
      const body = {
        name: el('eaf-name').value.trim() || el('eaf-from').value.trim(),
        from_address: el('eaf-from').value.trim(),
        display_name: el('eaf-display-name').value.trim(),
        imap_host: el('eaf-imap-host').value.trim(),
        imap_port: parseInt(el('eaf-imap-port').value) || 993,
        imap_user: el('eaf-imap-user').value.trim(),
        imap_starttls: el('eaf-imap-starttls').checked,
        smtp_host: el('eaf-smtp-host').value.trim(),
        smtp_port: parseInt(el('eaf-smtp-port').value) || 587,
        smtp_security: el('eaf-smtp-security').value,
        smtp_user: el('eaf-imap-user').value.trim(),
      };
      if (!body.name) { el('eaf-msg').textContent = 'Enter a Name or Email first'; el('eaf-msg').style.color = 'var(--red)'; return; }
      const url = isEdit ? `/api/email/accounts/${a.id}` : '/api/email/accounts';
      const method = isEdit ? 'PUT' : 'POST';
      const r = await fetch(url, { method, credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const d = await r.json();
      if (!d.ok) { el('eaf-msg').textContent = d.error || 'Save failed'; el('eaf-msg').style.color = 'var(--red)'; return; }
      const accId = isEdit ? a.id : d.id;
      window.location.href = `/api/email/oauth/google/authorize?account_id=${encodeURIComponent(accId)}`;
    });
    el('eaf-smtp-security').value = _smtpSecurity(a);

    // "Same as IMAP" toggle — hide the SMTP creds rows when on. The save
    // handler copies the IMAP user/password into SMTP at submit time.
    const _syncSmtpSame = () => {
      const same = el('eaf-smtp-same').checked;
      formEl.querySelectorAll('.eaf-smtp-creds').forEach(r => {
        r.style.display = same ? 'none' : '';
      });
    };
    el('eaf-smtp-same').addEventListener('change', _syncSmtpSame);
    _syncSmtpSame();

    el('eaf-cancel').addEventListener('click', () => { formEl.style.display = 'none'; });
    el('eaf-save').addEventListener('click', async () => {
      const body = {
        name: el('eaf-name').value.trim(),
        from_address: el('eaf-from').value.trim(),
        display_name: el('eaf-display-name').value.trim(),
        imap_host: el('eaf-imap-host').value.trim(),
        imap_port: parseInt(el('eaf-imap-port').value) || 993,
        imap_user: el('eaf-imap-user').value.trim(),
        imap_starttls: el('eaf-imap-starttls').checked,
        smtp_host: el('eaf-smtp-host').value.trim(),
        smtp_port: parseInt(el('eaf-smtp-port').value) || 465,
        smtp_security: el('eaf-smtp-security').value,
        smtp_user: el('eaf-smtp-user').value.trim(),
      };
      if (el('eaf-imap-pass').value) body.imap_password = el('eaf-imap-pass').value;
      if (el('eaf-smtp-pass').value) body.smtp_password = el('eaf-smtp-pass').value;
      // "Same as IMAP" toggle — copy IMAP username/password into SMTP at
      // save time, so the hidden SMTP-creds rows don't matter. We only
      // mirror the password if the user actually typed an IMAP one
      // (otherwise SMTP keeps whatever it already had on the server).
      if (el('eaf-smtp-same').checked) {
        body.smtp_user = body.imap_user;
        if (body.imap_password) body.smtp_password = body.imap_password;
      }
      // Name is optional — fall back to the From address so the list view
      // still has a label to render. Only refuse if both are blank.
      if (!body.name) body.name = body.from_address;
      if (!body.name) { el('eaf-msg').textContent = 'Need at least a Name or Email'; el('eaf-msg').style.color = 'var(--red)'; return; }

      try {
        const url = isEdit ? `/api/email/accounts/${a.id}` : '/api/email/accounts';
        const method = isEdit ? 'PUT' : 'POST';
        const r = await fetch(url, {
          method, credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const d = await r.json();
        if (d.ok || d.id) {
          el('eaf-msg').textContent = 'Saved';
          el('eaf-msg').style.color = 'var(--green,#50fa7b)';
          setTimeout(() => { formEl.style.display = 'none'; renderList(); }, 400);
        } else {
          el('eaf-msg').textContent = d.error || 'Save failed';
          el('eaf-msg').style.color = 'var(--red)';
        }
      } catch (e) {
        el('eaf-msg').textContent = 'Error: ' + e.message;
        el('eaf-msg').style.color = 'var(--red)';
      }
    });
  }

  addBtn.addEventListener('click', () => showForm(null));
  await renderList();
}

async function initEmailSettings() {
  const root = el('settings-modal');
  if (!root || !root.querySelector('[data-settings-panel="email"]')) return;

  const styleKey = () => {
    const account = String(window.__odysseusActiveEmailAccount || '').trim();
    return account ? `odysseus-email-writing-style:${account}` : 'odysseus-email-writing-style';
  };
  const styleEl = el('set-email-style');
  const emailAccountSuffix = () => {
    const account = String(window.__odysseusActiveEmailAccount || '').trim();
    return account ? `?account_id=${encodeURIComponent(account)}` : '';
  };

  // The account/CardDAV config endpoints can be slow when remote mail servers
  // are cold. Populate the Writing Style box independently so saved prose does
  // not appear seconds after the panel opens.
  try {
    const cachedStyle = localStorage.getItem(styleKey());
    if (styleEl && cachedStyle !== null && !styleEl.value) styleEl.value = cachedStyle;
  } catch (_) {}

  const loadWritingStyle = async () => {
    try {
      const res = await fetch(`/api/email/style${emailAccountSuffix()}`);
      const data = await res.json();
      const style = data.style || '';
      if (styleEl) styleEl.value = style;
      try { localStorage.setItem(styleKey(), style); } catch (_) {}
    } catch (_) {}
  };
  loadWritingStyle();

  // Load current email config
  try {
    const res = await fetch('/api/email/config');
    const cfg = await res.json();
    if (el('set-email-imap-host')) el('set-email-imap-host').value = cfg.imap_host || '';
    if (el('set-email-imap-port')) el('set-email-imap-port').value = cfg.imap_port || '';
    if (el('set-email-imap-user')) el('set-email-imap-user').value = cfg.imap_user || '';
    if (el('set-email-imap-pass')) el('set-email-imap-pass').value = ''; // never prefill
    if (el('set-email-smtp-host')) el('set-email-smtp-host').value = cfg.smtp_host || '';
    if (el('set-email-smtp-port')) el('set-email-smtp-port').value = cfg.smtp_port || '';
    if (el('set-email-smtp-user')) el('set-email-smtp-user').value = cfg.smtp_user || '';
    if (el('set-email-smtp-pass')) el('set-email-smtp-pass').value = '';
    if (el('set-email-from')) el('set-email-from').value = cfg.from_address || '';
  } catch (_) {}

  // Load contacts config
  try {
    const res = await fetch('/api/contacts/config');
    const cfg = await res.json();
    if (el('set-carddav-url')) el('set-carddav-url').value = cfg.url || '';
    if (el('set-carddav-user')) el('set-carddav-user').value = cfg.username || '';
    if (el('set-carddav-pass')) el('set-carddav-pass').value = '';
  } catch (_) {}

  // Save email config
  el('set-email-save')?.addEventListener('click', async () => {
    const msg = el('set-email-msg');
    if (msg) msg.textContent = 'Saving...';
    const data = {
      imap_host: el('set-email-imap-host').value,
      imap_port: parseInt(el('set-email-imap-port').value) || 0,
      imap_user: el('set-email-imap-user').value,
      smtp_host: el('set-email-smtp-host').value,
      smtp_port: parseInt(el('set-email-smtp-port').value) || 0,
      smtp_user: el('set-email-smtp-user').value,
      email_from: el('set-email-from').value,
    };
    const imapPass = el('set-email-imap-pass').value;
    const smtpPass = el('set-email-smtp-pass').value;
    if (imapPass) data.imap_password = imapPass;
    if (smtpPass) data.smtp_password = smtpPass;
    try {
      const res = await fetch('/api/email/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      const result = await res.json();
      if (msg) msg.textContent = result.success ? '✓ Saved' : (result.error || 'Failed');
      setTimeout(() => { if (msg) msg.textContent = ''; }, 3000);
    } catch (e) {
      if (msg) msg.textContent = 'Failed';
    }
  });

  // Save CardDAV config
  el('set-carddav-save')?.addEventListener('click', async () => {
    const msg = el('set-carddav-msg');
    if (msg) msg.textContent = 'Saving...';
    const data = {
      carddav_url: el('set-carddav-url').value,
      carddav_username: el('set-carddav-user').value,
    };
    const pass = el('set-carddav-pass').value;
    if (pass) data.carddav_password = pass;
    try {
      const res = await fetch('/api/contacts/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      const result = await res.json();
      if (msg) msg.textContent = result.success ? '✓ Saved' : (result.error || 'Failed');
      setTimeout(() => { if (msg) msg.textContent = ''; }, 3000);
    } catch (e) {
      if (msg) msg.textContent = 'Failed';
    }
  });

  // Extract writing style
  el('set-email-style-extract')?.addEventListener('click', async () => {
    const btn = el('set-email-style-extract');
    const msg = el('set-email-style-msg');
    btn.disabled = true;
    // Render whirlpool + label inside the status area (same pattern as
    // the "Find" / network-discover button in Add Models).
    let wp = null;
    if (msg) {
      msg.className = '';
      msg.innerHTML = '';
      try {
        const sp = window.spinnerModule || (await import('./spinner.js')).default;
        wp = sp.createWhirlpool(16);
        wp.element.style.cssText = 'display:inline-block;vertical-align:middle;margin:0 8px 0 0;';
        const wrap = document.createElement('span');
        wrap.style.cssText = 'display:inline-flex;align-items:center;';
        wrap.appendChild(wp.element);
        const txt = document.createElement('span');
        txt.textContent = 'Analyzing your sent emails…';
        txt.style.cssText = 'font-size:12px;opacity:0.7;';
        wrap.appendChild(txt);
        msg.appendChild(wrap);
      } catch (_) {
        msg.textContent = 'Analyzing your sent emails…';
      }
    }
    try {
      const res = await fetch(`/api/email/extract-style${emailAccountSuffix()}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sample_count: 15 }),
      });
      const data = await res.json();
      if (data.success && data.style) {
        if (styleEl) styleEl.value = data.style;
        try { localStorage.setItem(styleKey(), data.style); } catch (_) {}
        if (msg) msg.textContent = '✓ Style extracted';
      } else {
        if (msg) msg.textContent = data.error || 'Failed';
      }
    } catch (e) {
      if (msg) msg.textContent = 'Failed to extract';
    } finally {
      if (wp && wp.destroy) { try { wp.destroy(); } catch (_) {} }
      btn.disabled = false;
      setTimeout(() => { if (msg) msg.textContent = ''; }, 5000);
    }
  });

  // Save writing style manually
  el('set-email-style-save')?.addEventListener('click', async () => {
    const msg = el('set-email-style-msg');
    if (msg) msg.textContent = 'Saving...';
    try {
      const style = styleEl ? styleEl.value : '';
      const res = await fetch(`/api/email/style${emailAccountSuffix()}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ style }),
      });
      const result = await res.json();
      if (result.success) {
        try { localStorage.setItem(styleKey(), style); } catch (_) {}
      }
      if (msg) msg.textContent = result.success ? '✓ Saved' : 'Failed';
      setTimeout(() => { if (msg) msg.textContent = ''; }, 3000);
    } catch (e) {
      if (msg) msg.textContent = 'Failed';
    }
  });
}

async function initIntegrations() {
  const listEl = el('integrations-list');
  const formCard = el('integration-form-card');
  const addBtn = el('intg-add-btn');
  if (!listEl || !formCard) return;

  const presetSel = el('intg-preset');
  const nameIn = el('intg-name');
  const urlIn = el('intg-url');
  const authTypeSel = el('intg-auth-type');
  const authHeaderRow = el('intg-auth-header-row');
  const authHeaderIn = el('intg-auth-header');
  const keyIn = el('intg-key');
  const descIn = el('intg-description');
  const saveBtn = el('intg-save-btn');
  const cancelBtn = el('intg-cancel-btn');
  const testBtn = el('intg-test-btn');
  const statusEl = el('intg-status');
  const formTitle = el('integration-form-title');

  let editingId = null;
  let presets = {};

  // Presets where the secret is embedded in the URL — no separate key or
  // auth header is used, so hiding those fields avoids confusion.
  const URL_AUTH_PRESETS = ['discord_webhook'];

  // Toggle auth header + key row visibility based on auth type and preset.
  function syncAuthRow() {
    const v = authTypeSel.value;
    authHeaderRow.style.display = (v === 'header' || v === 'query') ? 'flex' : 'none';
    if (v === 'query') authHeaderIn.placeholder = 'api_key';
    else authHeaderIn.placeholder = 'X-Auth-Token';
    const keyRow = keyIn?.closest('.settings-row');
    if (keyRow) keyRow.style.display = URL_AUTH_PRESETS.includes(presetSel?.value) ? 'none' : '';
  }
  authTypeSel.addEventListener('change', syncAuthRow);

  // Load presets
  try {
    const res = await fetch('/api/auth/integrations/presets', { credentials: 'same-origin' });
    if (res.ok) {
      const data = await res.json();
      presets = data.presets || {};
      for (const [key, preset] of Object.entries(presets)) {
        const opt = document.createElement('option');
        opt.value = key;
        opt.textContent = preset.name || key;
        presetSel.appendChild(opt);
      }
    }
  } catch (e) {}

  // Preset auto-fill
  presetSel.addEventListener('change', () => {
    const p = presets[presetSel.value];
    if (!p) return;
    nameIn.value = p.name || '';
    authTypeSel.value = p.auth_type || 'none';
    authHeaderIn.value = p.auth_header || '';
    descIn.value = p.description || '';
    syncAuthRow();
  });

  // Render list
  async function renderList() {
    try {
      const res = await fetch('/api/auth/integrations', { credentials: 'same-origin' });
      if (!res.ok) { listEl.innerHTML = '<div style="padding:12px;opacity:0.5;font-size:12px;">Admin access required</div>'; return; }
      const data = await res.json();
      const items = data.integrations || [];
      if (!items.length) {
        listEl.innerHTML = '<div style="padding:12px;opacity:0.5;font-size:12px;text-align:center;">No integrations configured</div>';
        return;
      }
      listEl.innerHTML = items.map(i => `
        <div class="admin-card" style="display:flex;align-items:center;gap:10px;margin-bottom:6px;">
          <div style="flex:1;min-width:0;">
            <div style="font-size:13px;font-weight:600;">${_esc(i.name || i.id)}</div>
            <div style="font-size:11px;opacity:0.5;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${_esc(i.base_url || '')}</div>
          </div>
          <div style="display:flex;gap:4px;flex-shrink:0;">
            <button class="admin-btn-sm intg-edit-btn" data-id="${i.id}" style="font-size:11px;">Edit</button>
            <button class="admin-btn-sm intg-del-btn" data-id="${i.id}" style="font-size:11px;opacity:0.6;">Del</button>
          </div>
        </div>
      `).join('');
      listEl.querySelectorAll('.intg-edit-btn').forEach(b => b.addEventListener('click', () => startEdit(b.dataset.id)));
      listEl.querySelectorAll('.intg-del-btn').forEach(b => b.addEventListener('click', () => doDelete(b.dataset.id)));
    } catch (e) { listEl.innerHTML = '<div style="padding:12px;color:var(--red);font-size:12px;">Failed to load</div>'; }
  }

  function _esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

  // Start editing
  async function startEdit(id) {
    editingId = id;
    formTitle.textContent = 'Edit Integration';
    // Fetch full data (with unmasked key from a dedicated edit fetch — we'll just load what we have)
    try {
      const res = await fetch('/api/auth/integrations', { credentials: 'same-origin' });
      const data = await res.json();
      const item = (data.integrations || []).find(i => i.id === id);
      if (!item) return;
      presetSel.value = item.preset || '';
      nameIn.value = item.name || '';
      urlIn.value = item.base_url || '';
      authTypeSel.value = item.auth_type || 'none';
      authHeaderIn.value = item.auth_header || '';
      keyIn.value = ''; // masked — user re-enters if changing
      keyIn.placeholder = item.api_key ? 'Leave blank to keep current' : 'API key or token';
      descIn.value = item.description || '';
      syncAuthRow();
      formCard.style.display = '';
    } catch (e) {}
  }

  // Show add form
  addBtn.addEventListener('click', () => {
    editingId = null;
    formTitle.textContent = 'Add Integration';
    presetSel.value = '';
    nameIn.value = '';
    urlIn.value = '';
    authTypeSel.value = 'header';
    authHeaderIn.value = '';
    keyIn.value = '';
    keyIn.placeholder = 'API key or token';
    descIn.value = '';
    statusEl.textContent = '';
    syncAuthRow();
    formCard.style.display = '';
  });

  cancelBtn.addEventListener('click', () => {
    formCard.style.display = 'none';
    statusEl.textContent = '';
  });

  // Save
  saveBtn.addEventListener('click', async () => {
    const payload = {
      name: nameIn.value.trim(),
      base_url: urlIn.value.trim().replace(/\/+$/, ''),
      auth_type: authTypeSel.value,
      auth_header: authHeaderIn.value.trim(),
      description: descIn.value.trim(),
    };
    if (presetSel.value) payload.preset = presetSel.value;
    if (keyIn.value.trim()) payload.api_key = keyIn.value.trim();
    if (!payload.name) { statusEl.textContent = 'Name required'; statusEl.style.color = 'var(--red)'; return; }
    if (!payload.base_url) { statusEl.textContent = 'URL required'; statusEl.style.color = 'var(--red)'; return; }

    try {
      const url = editingId ? `/api/auth/integrations/${editingId}` : '/api/auth/integrations';
      const method = editingId ? 'PUT' : 'POST';
      const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), credentials: 'same-origin' });
      if (res.ok) {
        statusEl.textContent = 'Saved';
        statusEl.style.color = 'var(--green, #98c379)';
        formCard.style.display = 'none';
        await renderList();
        notifyIntegrationsChanged();
      } else {
        const err = await res.json().catch(() => ({}));
        statusEl.textContent = err.detail || 'Save failed';
        statusEl.style.color = 'var(--red)';
      }
    } catch (e) {
      statusEl.textContent = 'Error saving';
      statusEl.style.color = 'var(--red)';
    }
  });

  // Test
  testBtn.addEventListener('click', async () => {
    if (!editingId) { statusEl.textContent = 'Save first, then test'; statusEl.style.color = 'var(--fg)'; return; }
    statusEl.textContent = 'Testing...';
    statusEl.style.color = 'var(--fg)';
    try {
      const res = await fetch(`/api/auth/integrations/${editingId}/test`, { method: 'POST', credentials: 'same-origin' });
      const data = await res.json();
      statusEl.textContent = data.message || (data.ok ? 'OK' : 'Failed');
      statusEl.style.color = data.ok ? 'var(--green, #98c379)' : 'var(--red)';
    } catch (e) {
      statusEl.textContent = 'Connection failed';
      statusEl.style.color = 'var(--red)';
    }
  });

  // Delete
  async function doDelete(id) {
    if (!await window.styledConfirm('Delete this integration?', { confirmText: 'Delete', danger: true })) return;
    try {
      await fetch(`/api/auth/integrations/${id}`, { method: 'DELETE', credentials: 'same-origin' });
      if (editingId === id) { formCard.style.display = 'none'; editingId = null; }
      await renderList();
      notifyIntegrationsChanged();
    } catch (e) {}
  }

  syncAuthRow();
  renderList();
}

/* ══ Unified Integrations ══ */

const INTG_TYPES = {
  api:     { label: 'API',     icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>' },
  caldav:  { label: 'CalDAV',  icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>' },
  contacts: { label: 'Contacts', icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>' },
  carddav: { label: 'CardDAV', icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>' },
  email:   { label: 'Email',   icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/></svg>' },
  mcp:     { label: 'MCP',     icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>' },
  codex:   { label: 'Codex',   icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 10.696.453a6.023 6.023 0 0 0-5.75 4.172 6.061 6.061 0 0 0-3.946 2.945 6.024 6.024 0 0 0 .742 7.099 5.98 5.98 0 0 0 .516 4.911 6.046 6.046 0 0 0 6.51 2.9A5.996 5.996 0 0 0 13.26 23.547a6.023 6.023 0 0 0 5.75-4.172 6.061 6.061 0 0 0 3.946-2.945 6.024 6.024 0 0 0-.674-6.609zM13.26 21.047a4.508 4.508 0 0 1-2.886-1.041l.143-.082 4.793-2.769a.777.777 0 0 0 .391-.676V10.34l2.026 1.17a.072.072 0 0 1 .039.061v5.596a4.532 4.532 0 0 1-4.506 4.48zM3.968 17.64a4.473 4.473 0 0 1-.537-3.018l.143.086 4.793 2.769a.79.79 0 0 0 .782 0l5.852-3.379v2.34a.072.072 0 0 1-.029.062l-4.845 2.796a4.532 4.532 0 0 1-6.159-1.656zM2.804 7.922a4.49 4.49 0 0 1 2.348-1.973V11.6a.778.778 0 0 0 .391.676l5.852 3.378-2.026 1.17a.072.072 0 0 1-.068 0L4.456 14.03a4.532 4.532 0 0 1-1.652-6.108zm16.423 3.823L13.375 8.367l2.026-1.17a.072.072 0 0 1 .068 0l4.845 2.796a4.525 4.525 0 0 1-.7 8.08V12.42a.778.778 0 0 0-.387-.676zm2.015-3.025l-.143-.086-4.793-2.769a.79.79 0 0 0-.782 0L9.672 9.243V6.903a.072.072 0 0 1 .029-.062l4.845-2.796a4.525 4.525 0 0 1 6.696 4.675zM8.598 12.66L6.57 11.49a.072.072 0 0 1-.039-.061V5.833a4.525 4.525 0 0 1 7.413-3.48l-.143.082-4.793 2.769a.777.777 0 0 0-.391.676l-.019 6.78zm1.1-2.379l2.607-1.505 2.607 1.505v3.01l-2.607 1.505-2.607-1.505z"/></svg>' },
  claude:  { label: 'Claude',  icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M17.3041 3.541h-3.6718l6.696 16.918H24Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456Z"/></svg>' },
  vault:   { label: 'Vault',   icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>' },
  moodle:      { label: 'ETH Moodle', icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10l9-7 9 7v10a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/></svg>' },
  browser:     { label: 'Browser Session', icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15 15 0 0 1 0 20"/><path d="M12 2a15 15 0 0 0 0 20"/></svg>' },
  whatsapp:    { label: 'WhatsApp', icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.4 8.4 0 0 1-12.4 7.4L3 20l1.1-5.2A8.4 8.4 0 1 1 21 11.5z"/><path d="M8.5 9.5c.4 2 2 3.6 4 4"/></svg>' },
  maps:        { label: 'Maps', icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10c0 5-8 12-8 12S4 15 4 10a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10" r="2.5"/></svg>' },
  gmail_index: { label: 'Gmail Retrieval', icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/></svg>' },
  shopping:    { label: 'Shopping Search', icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="10" r="7"/><path d="m21 21-6-6"/></svg>' },
};

// Config shared by the Codex Agent and Claude Agent forms. Both use the same
// scope-gated /api/codex/* backend; this just parameterizes the UI label,
// default token name, and the per-agent install commands.
const AGENT_CONFIGS = {
  codex: {
    label: 'Codex Agent',
    word: 'Codex',
    namePrefix: 'codex agent',
    defaultName: 'Codex Agent',
    pluginPath: '/api/codex/plugin.zip',
    setupDescription: 'Downloads a plugin bundle and registers it.',
    buildSetup: (origin, token) => `export ODYSSEUS_URL=${origin}
export ODYSSEUS_API_TOKEN='${token}'
mkdir -p ~/plugins
curl -fsSL -H "Authorization: Bearer $ODYSSEUS_API_TOKEN" "$ODYSSEUS_URL/api/codex/plugin.zip" -o /tmp/odysseus-codex-plugin.zip
python3 -m zipfile -e /tmp/odysseus-codex-plugin.zip ~/plugins
python3 - <<'PY'
import json
from pathlib import Path

p = Path.home() / ".agents" / "plugins" / "marketplace.json"
p.parent.mkdir(parents=True, exist_ok=True)
if p.exists():
    data = json.loads(p.read_text())
else:
    data = {"name": "personal", "interface": {"displayName": "Personal"}, "plugins": []}

data.setdefault("name", "personal")
data.setdefault("interface", {}).setdefault("displayName", "Personal")
plugins = data.setdefault("plugins", [])
entry = {
    "name": "odysseus",
    "source": {"source": "local", "path": "./plugins/odysseus"},
    "policy": {"installation": "AVAILABLE", "authentication": "ON_INSTALL"},
    "category": "Productivity",
}
data["plugins"] = [item for item in plugins if item.get("name") != "odysseus"] + [entry]
p.write_text(json.dumps(data, indent=2) + "\\n")
PY
codex plugin add odysseus@personal
python3 ~/plugins/odysseus/scripts/odysseus_api.py capabilities`,
  },
  claude: {
    label: 'Claude Agent',
    word: 'Claude',
    namePrefix: 'claude agent',
    defaultName: 'Claude Agent',
    pluginPath: '/api/claude/plugin.zip',
    setupDescription: 'Downloads a plugin bundle and registers it.',
    buildSetup: (origin, token) => `export ODYSSEUS_URL=${origin}
export ODYSSEUS_API_TOKEN='${token}'
mkdir -p ~/.claude
curl -fsSL -H "Authorization: Bearer $ODYSSEUS_API_TOKEN" "$ODYSSEUS_URL/api/claude/plugin.zip" -o /tmp/odysseus-claude-skill.zip
python3 -m zipfile -e /tmp/odysseus-claude-skill.zip ~/.claude/
python3 ~/.claude/skills/odysseus/scripts/odysseus_api.py capabilities`,
  },
};

async function initUnifiedIntegrations() {
  const listEl = el('unified-integrations-list');
  if (!listEl || listEl._unifiedIntegrationsInitialized) return;
  listEl._unifiedIntegrationsInitialized = true;
  el('integration-agent-access')?.addEventListener('click', async () => {
    const { openAssistantSettings } = await import('./assistant.js');
    await openAssistantSettings();
  });
  const formEl = el('unified-intg-form');
  const addBtn = el('unified-intg-add-btn');
  let integrationNotice = '';
  let connectorSetupMetadata = null;
  let connectorSetupMetadataError = '';
  let activeSetupPoll = null;
  let activeSetupRequest = null;
  let setupPollTimer = null;

  function cleanupSetupPolling() {
    if (setupPollTimer) clearTimeout(setupPollTimer);
    setupPollTimer = null;
    if (activeSetupPoll) activeSetupPoll.abort();
    activeSetupPoll = null;
    if (activeSetupRequest) activeSetupRequest.abort();
    activeSetupRequest = null;
    formEl?.querySelectorAll('input[type="password"]').forEach(input => { input.value = ''; });
  }

  const settingsModal = el('settings-modal');
  if (settingsModal && !settingsModal._connectorSetupCleanupObserver) {
    settingsModal._connectorSetupCleanupObserver = new MutationObserver(() => {
      if (settingsModal.classList.contains('hidden')) cleanupSetupPolling();
    });
    settingsModal._connectorSetupCleanupObserver.observe(settingsModal, { attributes: true, attributeFilter: ['class'] });
  }
  if (formEl && !formEl._connectorSetupCleanupObserver) {
    formEl._connectorSetupCleanupObserver = new MutationObserver(() => {
      if (formEl.style.display === 'none') cleanupSetupPolling();
    });
    formEl._connectorSetupCleanupObserver.observe(formEl, { attributes: true, attributeFilter: ['style'] });
  }
  // Hide the "+ Add Integration" button whenever the per-type create form
  // is open so it doesn't compete visually with the in-progress form.
  // Many call sites toggle formEl.style.display directly; observe instead
  // of patching every one of them.
  if (formEl && addBtn && addBtn.parentElement && !formEl._addBtnObserved) {
    formEl._addBtnObserved = true;
    const addBtnWrap = addBtn.parentElement;
    const _syncAddBtnWrap = () => {
      const formOpen = formEl.style.display && formEl.style.display !== 'none';
      addBtnWrap.style.display = formOpen ? 'none' : '';
    };
    new MutationObserver(_syncAddBtnWrap).observe(formEl, { attributes: true, attributeFilter: ['style'] });
    _syncAddBtnWrap();
  }

  function _openEmailSettings() {
    open('email');
  }

  async function fetchAll() {
    const [apiRes, calRes, cardRes, contactsRes, emailAccountsRes, mcpRes, vaultRes, tokenRes, calendarsRes, connectorRes, gmailIndexRes] = await Promise.all([
      fetch('/api/auth/integrations', { credentials: 'same-origin' }).then(r => r.ok ? r.json() : { integrations: [] }).catch(() => ({ integrations: [] })),
      fetch('/api/calendar/config/accounts', { credentials: 'same-origin' }).then(r => r.ok ? r.json() : { accounts: [] }).catch(() => ({ accounts: [] })),
      fetch('/api/contacts/config', { credentials: 'same-origin' }).then(r => r.ok ? r.json() : {}).catch(() => ({})),
      fetch('/api/contacts/list', { credentials: 'same-origin' }).then(r => r.ok ? r.json() : { contacts: [], count: 0 }).catch(() => ({ contacts: [], count: 0 })),
      fetch('/api/email/accounts', { credentials: 'same-origin' }).then(r => r.ok ? r.json() : { accounts: [] }).catch(() => ({ accounts: [] })),
      fetch('/api/mcp/servers', { credentials: 'same-origin' }).then(r => r.ok ? r.json() : []).catch(() => []),
      fetch('/api/vault/config', { credentials: 'same-origin' }).then(r => r.ok ? r.json() : {}).catch(() => ({})),
      fetch('/api/tokens', { credentials: 'same-origin' }).then(r => r.ok ? r.json() : []).catch(() => []),
      fetch('/api/calendar/calendars', { credentials: 'same-origin' }).then(r => r.ok ? r.json() : { calendars: [] }).catch(() => ({ calendars: [] })),
      fetch('/api/connectors/accounts', { credentials: 'same-origin' }).then(r => r.ok ? r.json() : { accounts: [] }).catch(() => ({ accounts: [] })),
      fetch('/api/connectors/email-accounts', { credentials: 'same-origin' }).then(r => r.ok ? r.json() : { accounts: [] }).catch(() => ({ accounts: [] })),
    ]);
    const items = [];
    // API integrations
    for (const intg of (apiRes.integrations || [])) {
      items.push({ type: 'api', id: intg.id, name: intg.name || 'Unnamed', detail: intg.base_url || '', enabled: intg.enabled !== false, data: intg });
    }
    // CalDAV — one card per account
    for (const acc of (calRes.accounts || [])) {
      items.push({ type: 'caldav', id: acc.id, name: acc.label || 'Calendar (CalDAV)', detail: acc.url, enabled: true, data: acc });
    }
    // Contacts import first, then the optional CardDAV sync account.
    const contactCount = Number(contactsRes.count || (contactsRes.contacts || []).length || 0);
    if (contactCount > 0) {
      items.push({
        type: 'contacts',
        id: '__contacts__',
        name: 'Contacts Import',
        detail: `${contactCount} contact${contactCount === 1 ? '' : 's'}`,
        enabled: true,
        data: contactsRes,
      });
    }
    if (cardRes.url) {
      items.push({
        type: 'carddav',
        id: '__carddav__',
        name: 'Contacts (CardDAV)',
        detail: cardRes.url,
        enabled: true,
        data: cardRes,
      });
    }
    // Gmail retrieval is separate from the existing OAuth/IMAP account and
    // remains opt-in, with semantic indexing disabled until explicitly chosen.
    for (const acc of (gmailIndexRes.accounts || [])) {
      items.push({
        type: 'gmail_index', id: acc.id, name: `${acc.name || acc.email} retrieval`,
        detail: `${acc.status || 'setup required'} · ${acc.semantic_index ? 'semantic indexing on' : 'keyword only'}${acc.last_error ? ` · ${acc.last_error}` : ''}`,
        enabled: acc.status === 'connected', data: acc,
      });
    }
    for (const acc of (connectorRes.accounts || [])) {
      const config = acc.config || {};
      const setupState = acc.setup_status || acc.status || 'setup_required';
      const detailParts = [];
      if (['moodle', 'whatsapp'].includes(acc.provider)) {
        detailParts.push(config.semantic_index ? (acc.index_status || 'Semantic indexing enabled') : 'Keyword retrieval only · semantic indexing off');
        if (config.auto_sync) detailParts.push(`Automatic pull every ${Number(config.sync_interval_minutes || 30)} min`);
      }
      if (acc.last_sync_at) detailParts.push(`Last sync ${new Date(acc.last_sync_at).toLocaleString()}`);
      if (acc.provider === 'whatsapp') detailParts.push(acc.write_enabled ? 'Outbound permission on' : 'Outbound permission off');
      if (acc.last_error) detailParts.push('Needs attention; open settings for details.');
      items.push({ type: acc.provider, id: acc.id, name: acc.name, detail: detailParts.join(' · '), enabled: setupState === 'connected', setupState, data: acc });
    }
    items.push({ type: 'shopping', id: 'shopping-search', name: 'Product discovery', detail: 'Public merchant listings · no checkout', enabled: true, data: {} });
    // MCP servers
    const mcpList = Array.isArray(mcpRes) ? mcpRes : (mcpRes.servers || []);
    for (const srv of mcpList) {
      const statusText = srv.needs_oauth ? 'needs auth' : srv.status === 'connected' ? `${srv.enabled_tool_count}/${srv.tool_count} tools` : srv.status === 'error' ? 'error' : 'disconnected';
      items.push({ type: 'mcp', id: srv.id || srv.name, name: srv.name || 'MCP Server', detail: statusText, enabled: srv.is_enabled !== false, data: srv });
    }
    for (const tok of (Array.isArray(tokenRes) ? tokenRes : [])) {
      const scopes = tok.scopes || [];
      const lowerName = (tok.name || '').toLowerCase();
      let agentType = null;
      if (lowerName.startsWith('claude agent')) agentType = 'claude';
      else if (lowerName.startsWith('codex agent')) agentType = 'codex';
      else if (scopes.some(s => String(s || '').startsWith('todos:') || String(s || '').startsWith('email:') || String(s || '').startsWith('documents:'))) {
        // Legacy / un-prefixed scoped tokens fall back to Codex for backwards compat.
        agentType = 'codex';
      }
      if (!agentType) continue;
      const detail = `${tok.token_prefix || 'token'}... - ${scopes.join(', ') || 'chat'}`;
      items.push({ type: agentType, id: tok.id, name: tok.name || (agentType === 'claude' ? 'Claude Agent' : 'Codex Agent'), detail, enabled: true, data: tok });
    }
    // Vaultwarden removed as an integration option.
    return items;
  }

  function renderCard(item) {
    const t = INTG_TYPES[item.type] || INTG_TYPES.api;
    const data = item.data || {};
    const setupState = item.setupState || data.setup_status || data.status;
    const statusLabel = item.type === 'browser' && setupState === 'connected'
      ? 'Browser profile active · site sign-in not verified'
      : ['moodle', 'whatsapp', 'maps', 'browser'].includes(item.type)
        ? connectorSetupStateLabel(setupState)
        : item.enabled ? 'Available' : 'Disabled';
    const statusDot = item.enabled
      ? '<span class="integration-status-dot" aria-hidden="true"></span>'
      : '<span class="integration-status-dot integration-status-dot-idle" aria-hidden="true"></span>';
    const canDelete = !['gmail_index', 'shopping'].includes(item.type);
    return `<div class="intg-card" data-intg-id="${esc(item.id)}" data-intg-type="${esc(item.type)}" role="group" style="display:flex;align-items:center;gap:10px;padding:8px 10px;border:1px solid var(--border);border-radius:8px;background:color-mix(in srgb, var(--fg) 3%, transparent);margin-bottom:6px;transition:all 0.15s;">
      <button type="button" class="integration-card-edit" aria-label="Edit ${esc(item.name)} ${esc(t.label)} settings. Status: ${esc(statusLabel)}." data-intg-id="${esc(item.id)}" data-intg-type="${esc(item.type)}">
        <span style="color:var(--accent, var(--red));flex-shrink:0">${t.icon}</span>
        <span style="flex:1;min-width:0">
          <span style="font-size:12px;font-weight:600;display:flex;align-items:center;gap:6px">${esc(item.name)} <span style="font-size:9px;text-transform:uppercase;letter-spacing:0.5px;padding:1px 5px;border:1px solid color-mix(in srgb, var(--accent, var(--red)) 50%, transparent);border-radius:3px;color:var(--accent, var(--red));background:color-mix(in srgb, var(--accent, var(--red)) 12%, transparent);">${esc(t.label)}</span></span>
          <span style="display:block;font-size:11px;opacity:.72">${statusDot} ${esc(statusLabel)}</span>
          <span style="display:block;font-size:11px;opacity:.5;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(item.detail || 'Open to manage permissions and setup.')}</span>
        </span>
      </button>
      ${canDelete ? `<button type="button" class="admin-btn-sm intg-del-btn" data-intg-id="${esc(item.id)}" data-intg-type="${esc(item.type)}" data-intg-name="${esc(item.name)}" aria-label="Remove ${esc(item.name)}" title="Remove" style="background:none;border:none;padding:4px;cursor:pointer;color:var(--red);opacity:0.75;display:inline-flex;align-items:center;justify-content:center;">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
      </button>` : ''}
    </div>`;
  }

  async function renderList() {
    const items = await fetchAll();
    const noticeHtml = integrationNotice ? `
      <div class="intg-followup-note" style="display:flex;align-items:center;gap:8px;padding:8px 10px;margin-bottom:8px;border:1px solid color-mix(in srgb, var(--accent, var(--red)) 35%, transparent);border-left:3px solid var(--accent, var(--red));border-radius:5px;background:color-mix(in srgb, var(--accent, var(--red)) 8%, transparent);font-size:11px;">
        <span style="flex:1;line-height:1.35">${esc(integrationNotice)}</span>
        <button type="button" class="admin-btn-sm intg-open-email-settings" style="white-space:nowrap;">Email settings</button>
      </div>` : '';
    listEl.innerHTML = noticeHtml + (items.length
      ? items.map(renderCard).join('')
      : '<div style="padding:12px;opacity:0.5;font-size:12px;text-align:center">No integrations configured</div>');
    listEl.querySelector('.intg-open-email-settings')?.addEventListener('click', (e) => {
      e.stopPropagation();
      _openEmailSettings();
    });
    listEl.querySelectorAll('.integration-card-edit').forEach(button => {
      button.addEventListener('click', () => {
        listEl.querySelectorAll('.intg-card.intg-card-active').forEach(card => card.classList.remove('intg-card-active'));
        button.closest('.intg-card')?.classList.add('intg-card-active');
        showForm(button.dataset.intgType, button.dataset.intgId);
      });
    });
    listEl.querySelectorAll('.intg-del-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const name = btn.dataset.intgName || 'this integration';
        if (!await window.styledConfirm(`Remove "${name}"?`, { confirmText: 'Remove', danger: true })) return;
        const type = btn.dataset.intgType;
        const id = btn.dataset.intgId;
        try {
          if (type === 'api') await fetch(`/api/auth/integrations/${id}`, { method: 'DELETE', credentials: 'same-origin' });
          else if (type === 'caldav') await fetch(`/api/calendar/config/accounts/${id}`, { method: 'DELETE', credentials: 'same-origin' });
          else if (type === 'contacts') await fetch('/api/contacts/clear', { method: 'DELETE', credentials: 'same-origin' });
          else if (type === 'carddav') await fetch('/api/contacts/config', { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ carddav_url: '', carddav_username: '', carddav_password: '' }) });
          else if (type === 'email') await fetch(`/api/email/accounts/${id}`, { method: 'DELETE', credentials: 'same-origin' });
          else if (type === 'mcp') await fetch(`/api/mcp/servers/${id}`, { method: 'DELETE', credentials: 'same-origin' });
          else if (type === 'codex' || type === 'claude') await fetch(`/api/tokens/${id}`, { method: 'DELETE', credentials: 'same-origin' });
          else if (type === 'vault') await fetch('/api/vault/logout', { method: 'POST', credentials: 'same-origin' });
          else if (['moodle', 'whatsapp', 'maps', 'browser'].includes(type)) await fetch(`/api/connectors/accounts/${id}`, { method: 'DELETE', credentials: 'same-origin' });
        } catch (_) {}
        formEl.style.display = 'none';
        await renderList();
        notifyIntegrationsChanged();
      });
    });
  }

  function showForm(type, editId) {
    formEl.style.display = '';
    if (type === 'api') showApiForm(editId);
    else if (type === 'caldav') showCalDavForm(editId);
    else if (type === 'contacts' || type === 'carddav') showCardDavForm();
    else if (type === 'email') showEmailForm(editId);
    else if (type === 'mcp') showMcpForm(editId);
    else if (type === 'codex') showAgentForm('codex', editId);
    else if (type === 'claude') showAgentForm('claude', editId);
    else if (type === 'vault') showVaultForm();
    else if (type === 'gmail_index') showGmailIndexForm(editId);
    else if (['moodle', 'whatsapp', 'maps', 'browser'].includes(type)) showPersonalConnectorForm(type, editId);
    else if (type === 'shopping') showShoppingSearchForm();
  }


  async function connectorRequest(url, options = {}) {
    const response = await fetch(url, { credentials: 'same-origin', ...options });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.detail || `Request failed (${response.status})`);
    return result;
  }

  function providerSetupMetadata(provider) {
    const raw = connectorSetupMetadata?.providers || connectorSetupMetadata?.integrations || [];
    const providers = Array.isArray(raw) ? raw : Object.values(raw);
    return providers.find(item =>
      String(item?.id || item?.provider || item?.key || '') === provider
    ) || null;
  }

  function permissionText(value, fallback) {
    if (Array.isArray(value)) return value.map(item => String(item?.label || item?.name || item)).filter(Boolean).join(', ') || fallback;
    if (typeof value === 'string' && value.trim()) return value.trim();
    return fallback;
  }

  function connectorAccessSummary(provider, metadata) {
    const fallback = {
      moodle: { read: 'Enrolled courses, available course materials, and the Moodle calendar.', write: 'No Moodle content is changed.', index: 'Indexing is optional and off until selected.' },
      whatsapp: { read: 'WhatsApp history available to the connected device; provider history limits apply.', write: 'Outbound messages are off until explicitly enabled.', index: 'Indexing and automatic history pulls are optional and off by default.' },
      maps: { read: 'Geocoding and directions from OpenRouteService.', write: 'No account data is written.', index: 'No content indexing.' },
      browser: { read: 'Pages opened in this isolated browser profile.', write: 'Page controls may submit forms; purchase, cart, checkout, and payment actions are blocked.', index: 'No content indexing.' },
      shopping: { read: 'Public product listings from participating merchants.', write: 'Merchant links are a manual handoff; no cart or purchase actions.', index: 'No content indexing.' },
    }[provider] || { read: 'Provider-specific data.', write: 'Provider-specific actions.', index: 'Optional where supported.' };
    const permissions = metadata?.permissions || {};
    const reads = permissionText(permissions.read ?? metadata?.reads, fallback.read);
    const writes = permissionText(permissions.write ?? metadata?.writes, fallback.write);
    const indexing = permissionText(permissions.index ?? metadata?.indexing, fallback.index);
    return `<div class="integration-help"><strong>What this connection allows</strong><ul><li><b>Read:</b> ${esc(reads)}</li><li><b>Write:</b> ${esc(writes)}</li><li><b>Index / sync:</b> ${esc(indexing)}</li></ul></div>`;
  }

  function connectorPrerequisites(provider, metadata) {
    const prerequisites = metadata?.prerequisites ?? metadata?.dependencies;
    if (prerequisites && !Array.isArray(prerequisites) && typeof prerequisites === 'object') {
      const readiness = [];
      if (prerequisites.dependencies_installed === true || prerequisites.available === true) readiness.push('Required service dependencies are ready.');
      else if (prerequisites.dependencies_installed === false || prerequisites.available === false) readiness.push('Required service dependencies are unavailable.');
      if (prerequisites.message) readiness.push(String(prerequisites.message));
      if (readiness.length) return `<p>${readiness.map(esc).join(' ')}</p>`;
    }
    const list = Array.isArray(prerequisites) ? prerequisites : [];
    const items = list.map(item => {
      if (typeof item === 'string') return `<li>${esc(item)}</li>`;
      const label = item?.label || item?.name || item?.id;
      if (!label) return '';
      const state = item?.status || item?.state || (item?.available === false ? 'unavailable' : item?.available === true ? 'ready' : '');
      const explanation = item?.message || item?.detail || '';
      return `<li>${esc(label)}${state ? ` — ${esc(state)}` : ''}${explanation ? `: ${esc(explanation)}` : ''}</li>`;
    }).filter(Boolean).join('');
    if (items) return `<ul>${items}</ul>`;
    if (connectorSetupMetadataError) return `<p>Service readiness could not be checked: ${esc(connectorSetupMetadataError)}. Retry setup status before continuing.</p>`;
    return `<p>${provider === 'whatsapp'
      ? 'Odysseus will prepare its managed WhatsApp service when setup starts; no API token or environment editing is needed.'
      : 'Odysseus will check and prepare supported service dependencies when setup starts.'}</p>`;
  }

  function connectorSetupStateLabel(state) {
    return ({
      starting: 'Preparing service…',
      awaiting_login: 'Waiting for you to finish sign-in',
      awaiting_qr: 'Waiting for WhatsApp device pairing',
      connected: 'Connected',
      setup_required: 'Setup needs attention',
      error: 'Setup could not finish',
      stopped: 'Setup stopped',
    })[state] || (state ? String(state).replace(/_/g, ' ') : 'Not started');
  }

  function setConnectorWizardStep(root, activeStep) {
    root?.querySelectorAll('[data-wizard-step]').forEach(step => {
      const current = Number(step.dataset.wizardStep) === activeStep;
      step.setAttribute('aria-current', current ? 'step' : 'false');
    });
  }

  function showConnectorOutput(target, value, error = false) {
    const node = typeof target === 'string' ? el(target) : target;
    if (!node) return;
    if (typeof value === 'string') node.textContent = value;
    else if (!value || typeof value !== 'object') node.textContent = 'Request completed.';
    else if (typeof value.message === 'string') node.textContent = value.message;
    else if (typeof value.summary === 'string') node.textContent = value.summary;
    else if (value.state || value.status) {
      const state = value.state || value.status;
      node.textContent = `${connectorSetupStateLabel(state)}${value.retryable ? ' · Retry is available.' : ''}`;
    } else if (Number.isFinite(value.records) || Number.isFinite(value.indexed)) {
      const records = Number.isFinite(value.records) ? value.records : value.indexed;
      node.textContent = `Sync completed: ${records} record${records === 1 ? '' : 's'} processed.${value.queued ? ` ${value.queued} queued for indexing.` : ''}`;
    } else if (Array.isArray(value.results) || Array.isArray(value.routes)) {
      const count = (value.results || value.routes).length;
      node.textContent = `Found ${count} result${count === 1 ? '' : 's'}.${value.attribution ? ` ${value.attribution}` : ''}`;
    } else {
      node.textContent = 'Request completed. Refresh status to see the latest setup and sync state.';
    }
    node.style.color = error ? 'var(--red)' : '';
  }

  async function showGmailIndexForm(emailAccountId) {
    let account;
    try {
      const data = await connectorRequest('/api/connectors/email-accounts');
      account = (data.accounts || []).find(item => item.id === emailAccountId);
    } catch (err) {
      formEl.innerHTML = `<div class="admin-card" style="margin-top:8px">${esc(err.message)}</div>`;
      return;
    }
    if (!account) {
      formEl.innerHTML = '<div class="admin-card" style="margin-top:8px">Connect an email account in Email settings before enabling retrieval.</div>';
      return;
    }
    formEl.innerHTML = `
      <div class="admin-card" style="margin-top:8px">
        <h2 style="font-size:13px">Gmail retrieval · ${esc(account.name || account.email)}</h2>
        <p style="font-size:11px;opacity:.7">Indexes mail from your existing owner-scoped email account. Semantic indexing is optional; keyword retrieval remains available without embeddings.</p>
        <label class="settings-row"><span class="settings-label">Semantic indexing</span><input id="uf-gmail-semantic" type="checkbox" ${account.semantic_index ? 'checked' : ''}></label>
        <label class="settings-row"><span class="settings-label">Automatic sync</span><input id="uf-gmail-auto" type="checkbox" ${account.auto_sync ? 'checked' : ''}></label>
        <label class="settings-row"><span class="settings-label">Sync interval (minutes)</span><input id="uf-gmail-interval" class="settings-input" type="number" min="5" max="1440" value="${Number(account.sync_interval_minutes || 30)}"></label>
        <div id="uf-gmail-output" style="white-space:pre-wrap;font:11px monospace;max-height:180px;overflow:auto"></div>
        <div style="display:flex;justify-content:flex-end;gap:6px;margin-top:8px">
          <button type="button" class="admin-btn-add" id="uf-gmail-sync">Sync now</button>
          <button type="button" class="admin-btn-add" id="uf-gmail-save">Save</button>
        </div>
      </div>`;
    el('uf-gmail-save').addEventListener('click', async () => {
      try {
        const interval = Number(el('uf-gmail-interval').value);
        await connectorRequest(`/api/connectors/email-accounts/${encodeURIComponent(emailAccountId)}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            semantic_index: el('uf-gmail-semantic').checked,
            auto_sync: el('uf-gmail-auto').checked,
            sync_interval_minutes: interval,
          }),
        });
        showConnectorOutput('uf-gmail-output', 'Settings saved.');
        await renderList();
      } catch (err) { showConnectorOutput('uf-gmail-output', err.message, true); }
    });
    el('uf-gmail-sync').addEventListener('click', async () => {
      try {
        showConnectorOutput('uf-gmail-output', await connectorRequest(`/api/connectors/email-accounts/${encodeURIComponent(emailAccountId)}/sync`, { method: 'POST' }));
        await renderList();
      } catch (err) { showConnectorOutput('uf-gmail-output', err.message, true); }
    });
  }

  function safeHttpsUrl(raw) {
    try {
      const parsed = new URL(String(raw || ''), window.location.origin);
      return parsed.protocol === 'https:' ? parsed.href : '';
    } catch (_) { return ''; }
  }

  function safeMoodleLaunchUrl(raw) {
    const safeUrl = safeHttpsUrl(raw);
    if (!safeUrl) return '';
    try {
      return new URL(safeUrl).hostname === 'moodle-app2.let.ethz.ch' ? safeUrl : '';
    } catch (_) { return ''; }
  }

  function isVerifiedEthPasswordControl(viewUrl, control) {
    if (!safeHttpsUrl(viewUrl)) return false;
    try {
      const origin = new URL(`https://${String(control?.origin || '')}`).hostname.toLowerCase();
      return origin === 'moodle-app2.let.ethz.ch' || origin === 'aai-logon.ethz.ch';
    } catch (_) { return false; }
  }

  function createRemoteField(control) {
    const tag = String(control.tag || '').toLowerCase();
    const type = String(control.type || '').toLowerCase();
    let input;
    if (tag === 'select' && Array.isArray(control.options)) {
      input = document.createElement('select');
      for (const option of control.options) {
        const item = new Option(String(option.label || option.value || ''), String(option.value ?? ''));
        item.selected = Boolean(option.selected);
        input.add(item);
      }
    } else if (tag === 'textarea') {
      input = document.createElement('textarea');
    } else {
      input = document.createElement('input');
      input.type = ['password', 'email', 'number', 'tel', 'url', 'search', 'checkbox', 'radio'].includes(type) ? type : 'text';
      if (input.type === 'checkbox' || input.type === 'radio') input.checked = Boolean(control.checked);
      input.autocomplete = input.type === 'password' ? 'current-password' : 'off';
      input.placeholder = String(control.placeholder || '');
      input.maxLength = 10000;
    }
    input.className = 'settings-input';
    input.required = Boolean(control.required);
    input.setAttribute('aria-label', String(control.label || 'Remote field'));
    return input;
  }

  function remoteFieldValue(input) {
    return input.type === 'checkbox' || input.type === 'radio' ? String(input.checked) : input.value;
  }

  async function showGuidedConnectorForm(type, editId, requestedMethod, autoStart = false) {
    cleanupSetupPolling();
    const isMoodle = type === 'moodle';
    const title = isMoodle ? 'ETH Moodle' : 'WhatsApp';
    let account = null;
    if (editId) {
      try {
        const data = await connectorRequest('/api/connectors/accounts');
        account = (data.accounts || []).find(item => item.id === editId) || null;
      } catch (err) {
        formEl.innerHTML = `<div class="admin-card" role="alert">${esc(err.message)}</div>`;
        return;
      }
      if (!account) {
        formEl.innerHTML = '<div class="admin-card" role="alert">Connector account not found.</div>';
        return;
      }
    }

    const metadata = providerSetupMetadata(type);
    let config = account?.config || {};
    const methodDefault = isMoodle
      ? (requestedMethod || (config.auth_mode === 'token' ? 'token' : config.auth_mode === 'normal_browser' ? 'normal_browser' : 'remote'))
      : (config.mode === 'external' ? 'external' : 'managed');
    const methods = metadata?.methods || metadata?.connection_methods || [];
    const supportsExternal = Array.isArray(methods)
      ? methods.some(item => (typeof item === 'string' ? item : item?.id || item?.value) === 'external')
      : methods?.external === true;
    const defaultWriteEnabled = !!(account?.write_enabled ?? config.write_enabled ?? config.allow_outbound);
    const status = account ? connectorSetupStateLabel(account.setup_status || account.status) : 'Not started';
    const accessSummary = connectorAccessSummary(type, metadata);
    const providerDescription = metadata?.description || (isMoodle
      ? 'Connect your ETH courses and calendar. Odysseus uses the ETH sign-in flow; web-service tokens are optional and advanced.'
      : 'Odysseus provisions and starts a private WhatsApp service for this account. Pair your phone with a temporary QR code.');
    const methodMarkup = isMoodle
      ? `<label class="settings-row"><span class="settings-label">Connection method</span><select id="uf-connector-method" class="settings-input" aria-describedby="uf-connector-method-help"><option value="remote"${methodDefault === 'remote' ? ' selected' : ''}>Sign in with ETH in Odysseus (recommended)</option><option value="normal_browser"${methodDefault === 'normal_browser' ? ' selected' : ''}>Normal browser sign-in (1Password-friendly)</option><option value="token"${methodDefault === 'token' ? ' selected' : ''}>Moodle web-service token (advanced)</option></select></label>
        <div id="uf-connector-method-help" class="integration-help">ETH Shibboleth and MFA remain under your control. Odysseus never asks you to inspect a page or enter CSS selectors.</div>
        <div id="uf-moodle-api-guide" class="integration-help" hidden><strong>Advanced: authorized Moodle web-service token</strong><ol><li>Open <a href="https://moodle-app2.let.ethz.ch/user/managetoken.php" target="_blank" rel="noopener noreferrer">Moodle → Manage tokens</a> and sign in.</li><li>Create a token only for an ETH-approved service. If that option is unavailable, use ETH sign-in instead or ask ETH Moodle support whether access is enabled.</li><li>Paste the token below. Odysseus stores it encrypted for this account, never redisplays it, and verifies access before showing Connected.</li></ol><a href="https://docs.moodle.org/en/REST_API_tokens" target="_blank" rel="noopener noreferrer">Moodle token documentation</a></div>
        <label id="uf-moodle-token-row" class="settings-row" hidden><span class="settings-label">Authorized web-service token</span><input id="uf-connector-secret" class="settings-input" type="password" autocomplete="new-password" spellcheck="false" placeholder="Paste token; hidden after saving"></label>`
      : `<label class="settings-row"><span class="settings-label">Service</span><select id="uf-connector-method" class="settings-input" aria-describedby="uf-connector-method-help"><option value="managed"${methodDefault === 'managed' ? ' selected' : ''}>Managed by Odysseus (recommended)</option>${supportsExternal || methodDefault === 'external' ? `<option value="external"${methodDefault === 'external' ? ' selected' : ''}>Use an existing external bridge (advanced)</option>` : ''}</select></label>
        <div id="uf-connector-method-help" class="integration-help">Managed mode prepares the service for you—no API token, environment edit, or separate bridge launch. The external option appears only when this deployment reports that bridge mode is available.</div>`;
    const indexChecked = !!config.semantic_index;
    const autoSyncChecked = !!config.auto_sync;
    const writeAck = account?.write_enabled_acknowledged === true || config.write_enabled_acknowledged === true;

    formEl.style.display = '';
    formEl.innerHTML = `
      <div class="admin-card integration-wizard" style="margin-top:8px" data-connector="${esc(type)}">
        <h2 style="font-size:13px">${editId ? `Manage ${title}` : `Add ${title}`}</h2>
        <p style="font-size:12px;line-height:1.5;opacity:.78">${esc(providerDescription)}</p>
        ${accessSummary}
        <div class="integration-wizard-steps" aria-label="Setup steps">
          <span class="integration-wizard-step" data-wizard-step="1" aria-current="step">1 · Choose</span>
          <span class="integration-wizard-step" data-wizard-step="2" aria-current="false">2 · Prepare</span>
          <span class="integration-wizard-step" data-wizard-step="3" aria-current="false">3 · Sign in / pair</span>
          <span class="integration-wizard-step" data-wizard-step="4" aria-current="false">4 · Ready</span>
        </div>
        <label class="settings-row"><span class="settings-label">Account name</span><input id="uf-connector-name" class="settings-input" maxlength="120" value="${esc(account?.name || title)}" autocomplete="off"></label>
        ${methodMarkup}
        <div id="uf-connector-dependencies" class="integration-help"><strong>Service preparation</strong>${connectorPrerequisites(type, metadata)}</div>
        ${isMoodle ? `
          <div id="uf-moodle-browser-login" class="integration-help" ${methodDefault === 'token' ? 'hidden' : ''}>
            <strong>ETH sign-in and password managers</strong>
            <p>For 1Password, choose normal-browser sign-in, then open the secure ETH handoff link below. Your extension works on ETH itself. After MFA, cancel any app-opening prompt and copy Moodle's “Open app” link address back here. If ETH does not offer that link, use the Odysseus sign-in window instead. Odysseus cannot read your normal browser's cookies; its separate remote profile does not have your local password-manager extension.</p>
            <a href="https://moodle-app2.let.ethz.ch/auth/shibboleth/login.php" target="_blank" rel="noopener noreferrer">Open ETH Moodle sign-in</a>
          </div>
          <div id="uf-moodle-callback-area" class="integration-help" hidden>
            <strong>Finish the normal-browser handoff</strong>
            <p id="uf-moodle-handoff-message" role="status" aria-live="polite" hidden></p>
            <p>After ETH sign-in, copy the Moodle callback link shown by the login handoff and paste it here. Do not open a Moodle mobile-app link. This one-time callback is sent to Odysseus over HTTPS for account-bound verification; it expires and is not saved in this browser.</p>
            <label class="settings-row"><span class="settings-label">One-time callback link</span><input id="uf-moodle-callback" class="settings-input" type="password" autocomplete="off" spellcheck="false" placeholder="Paste callback link"></label>
            <button type="button" class="admin-btn-add" id="uf-moodle-finish-handoff">Finish sign-in</button>
          </div>
          <div id="uf-moodle-remote-view" aria-label="ETH sign-in window"></div>
        ` : ''}
        ${!isMoodle ? `
          <div id="uf-whatsapp-pairing" class="integration-help" hidden>
            <strong>Pair a device</strong>
            <p>On your phone open WhatsApp → <b>Settings</b> → <b>Linked devices</b> → <b>Link a device</b>, then scan the QR shown here. Keep WhatsApp open while it pairs. The QR refreshes while setup is active and expires; if it does, retry pairing.</p>
            <div id="uf-whatsapp-qr" aria-live="polite"></div>
          </div>
          <label class="settings-row"><span class="settings-label">Semantic indexing (optional)</span><input id="uf-connector-semantic" type="checkbox"${indexChecked ? ' checked' : ''}></label>
          <label class="settings-row"><span class="settings-label">Automatic history pull</span><input id="uf-connector-auto" type="checkbox"${autoSyncChecked ? ' checked' : ''}></label>
          <label class="settings-row"><span class="settings-label">Pull interval (minutes)</span><input id="uf-connector-interval" class="settings-input" type="number" min="5" max="1440" value="${Number(config.sync_interval_minutes || 30)}"></label>
          <p class="integration-help">History availability depends on WhatsApp and the linked device. Sync is incremental and bounded; it cannot guarantee every old or new message is available. Retrieved records keep source details where WhatsApp provides them.</p>
          <label class="settings-row"><span class="settings-label">Allow outbound messages</span><input id="uf-connector-write" type="checkbox"${defaultWriteEnabled ? ' checked' : ''}></label>
          <p class="integration-help">Off by default. When enabled, an explicit send can send a message and scheduled send tasks may send on every run. Each scheduled send requires its own confirmation; no messages are sent during setup.</p>
          <label class="settings-row"><span class="settings-label">Confirm outbound permission</span><input id="uf-connector-write-ack" type="checkbox"${writeAck ? ' checked' : ''} ${defaultWriteEnabled ? '' : 'disabled'}></label>
        ` : ''}
        ${isMoodle ? `
          <label class="settings-row"><span class="settings-label">Semantic indexing (optional)</span><input id="uf-connector-semantic" type="checkbox"${indexChecked ? ' checked' : ''}></label>
          <label class="settings-row"><span class="settings-label">Automatic course sync</span><input id="uf-connector-auto" type="checkbox"${autoSyncChecked ? ' checked' : ''}></label>
          <label class="settings-row"><span class="settings-label">Sync interval (minutes)</span><input id="uf-connector-interval" class="settings-input" type="number" min="5" max="1440" value="${Number(config.sync_interval_minutes || 30)}"></label>
          <p class="integration-help">Indexing and automatic sync are optional. Course material availability follows your ETH enrollment and Moodle access; retrieval includes source details when available, not a guarantee that every course item is indexed. ${account ? `Index status: ${esc(account.index_status || (indexChecked ? 'Semantic indexing enabled; status updates after sync.' : 'Indexing off; keyword retrieval remains available.'))}${account.last_sync_at ? ` · Last sync ${esc(new Date(account.last_sync_at).toLocaleString())}` : ''}` : 'Choose these options now or later; nothing is indexed until enabled and synced.'}</p>
        ` : ''}
        <div id="uf-connector-setup-status" class="integration-setup-status" role="status" aria-live="polite">${esc(status)}</div>
        <div id="uf-connector-actions" class="integration-setup-actions"></div>
        <div id="uf-connector-output" class="integration-setup-status" role="status" aria-live="polite"></div>
        <div class="integration-setup-actions">
          <button type="button" class="admin-btn-add" id="uf-connector-save">${editId ? 'Save settings' : 'Add and continue'}</button>
          ${editId ? `<button type="button" class="admin-btn-sm" id="uf-connector-start" aria-describedby="uf-connector-setup-status">${isMoodle ? 'Start ETH sign-in' : 'Prepare service and pair'}</button>` : ''}
          <button type="button" class="admin-btn-sm" id="uf-connector-cancel">Cancel setup</button>
        </div>
      </div>`;

    const output = el('uf-connector-output');
    const statusEl = el('uf-connector-setup-status');
    const methodSelect = el('uf-connector-method');
    if (!isMoodle && account) methodSelect.disabled = true;
    let currentSetupState = account?.setup_status || account?.status || 'setup_required';
    const setStatus = (message, error = false) => {
      statusEl.textContent = message || '';
      statusEl.style.color = error ? 'var(--red)' : '';
    };
    const modeSections = () => {
      const method = methodSelect?.value;
      if (isMoodle) {
        el('uf-moodle-api-guide').hidden = method !== 'token';
        el('uf-moodle-token-row').hidden = method !== 'token';
        el('uf-moodle-browser-login').hidden = method === 'token';
        const callbackArea = el('uf-moodle-callback-area');
        if (callbackArea) callbackArea.hidden = method !== 'normal_browser' || !account;
        el('uf-moodle-remote-view').hidden = method !== 'remote';
        const start = el('uf-connector-start');
        if (start) start.hidden = method === 'token';
      }
      const write = el('uf-connector-write');
      const acknowledgement = el('uf-connector-write-ack');
      if (write && acknowledgement) {
        acknowledgement.disabled = !write.checked;
        if (!write.checked) acknowledgement.checked = false;
      }
    };
    methodSelect?.addEventListener('change', modeSections);
    el('uf-connector-write')?.addEventListener('change', modeSections);
    modeSections();

    const renderMoodleView = async view => {
      const host = el('uf-moodle-remote-view');
      if (!host) return;
      host.replaceChildren();
      const viewUrl = safeHttpsUrl(view?.url);
      const header = document.createElement('p');
      header.className = 'integration-help';
      header.textContent = `${view?.title || 'ETH sign-in'}${viewUrl ? ` · ${viewUrl}` : ''}`;
      host.appendChild(header);
      const screenshot = safeRasterDataUrl(view?.screenshot_data_url);
      if (screenshot) {
        const image = document.createElement('img');
        image.className = 'integration-remote-screenshot';
        image.src = screenshot;
        image.alt = `Current ETH Moodle sign-in page${view?.title ? `: ${view.title}` : ''}`;
        host.appendChild(image);
      }
      if (view?.message) {
        const message = document.createElement('p');
        message.className = 'integration-help';
        message.textContent = view.message;
        host.appendChild(message);
      }
      const controls = Array.isArray(view?.controls) ? view.controls : [];
      const allowedActions = new Set(Array.isArray(view?.actions) ? view.actions : []);
      const actionRequest = async (action, controlId, input, control) => {
        if (!allowedActions.has(action)) return;
        const sensitive = input?.type === 'password';
        const value = input ? remoteFieldValue(input) : '';
        const controller = new AbortController();
        activeSetupRequest = controller;
        const buttons = [...host.querySelectorAll('button')];
        try {
          if (sensitive && !isVerifiedEthPasswordControl(view?.url, control)) {
            setStatus(`Password fill is blocked for this unverified origin (${control?.origin || 'unknown'}). Check the displayed HTTPS address; use the normal-browser sign-in link if needed.`, true);
            return;
          }
          if (sensitive && !input._credentialConsent?.checked) {
            setStatus('Confirm the one-time HTTPS credential disclosure before filling a password.', true);
            input._credentialConsent?.focus();
            return;
          }
          buttons.forEach(button => { button.disabled = true; });
          setStatus(sensitive
            ? 'Sending this password only for the current HTTPS field fill…'
            : 'Updating ETH sign-in…');
          const result = await connectorRequest(`/api/connectors/accounts/${encodeURIComponent(account.id)}/setup/action`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action, control_id: controlId, value }),
            signal: controller.signal,
          });
          setStatus(result.message || 'ETH sign-in page updated. Continue sign-in or MFA yourself.');
          if (result.controls || result.screenshot_data_url || result.url) await renderMoodleView(result.view || result);
          else await refreshMoodleView();
        } catch (error) {
          if (!controller.signal.aborted) setStatus(error.message || 'Could not update the sign-in page.', true);
        } finally {
          if (sensitive) {
            input.value = '';
            if (input._credentialConsent) input._credentialConsent.checked = false;
          }
          if (activeSetupRequest === controller) activeSetupRequest = null;
          buttons.forEach(button => { if (button.isConnected) button.disabled = false; });
        }
      };
      for (const control of controls) {
        if (!control || control.disabled || !control.id || !control.label) continue;
        const tag = String(control.tag || '').toLowerCase();
        const typeValue = String(control.type || '').toLowerCase();
        if (tag === 'button' || typeValue === 'button' || typeValue === 'submit' || tag === 'a') {
          if (!allowedActions.has('click')) continue;
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'admin-btn-sm';
          button.textContent = control.label;
          button.addEventListener('click', () => actionRequest('click', String(control.id), null, control));
          host.appendChild(button);
          continue;
        }
        if (!allowedActions.has('fill')) continue;
        const fieldLabel = document.createElement('label');
        fieldLabel.className = 'settings-row';
        const labelText = document.createElement('span');
        labelText.className = 'settings-label';
        labelText.textContent = control.label;
        const input = createRemoteField(control);
        fieldLabel.append(labelText, input);
        host.appendChild(fieldLabel);
        if (input.type === 'password') {
          const disclosure = document.createElement('p');
          disclosure.className = 'integration-help';
          const verifiedOrigin = isVerifiedEthPasswordControl(view?.url, control);
          disclosure.textContent = `If you choose to fill this password from ${control.origin || 'an unverified origin'}, it is sent over HTTPS to Odysseus server memory for this single action and cleared immediately after the request. It is not saved as a connector credential. ${verifiedOrigin ? 'Complete MFA yourself.' : 'Password filling is blocked for this origin; use the normal-browser sign-in link or inspect the address before continuing.'}`;
          const consentLabel = document.createElement('label');
          consentLabel.className = 'settings-row';
          const consent = document.createElement('input');
          consent.type = 'checkbox';
          consent.disabled = !verifiedOrigin;
          consentLabel.append(consent, document.createTextNode('I understand this password is sent for one HTTPS field-fill request.'));
          input._credentialConsent = consent;
          host.append(disclosure, consentLabel);
        }
        const fillButton = document.createElement('button');
        fillButton.type = 'button';
        fillButton.className = 'admin-btn-sm';
        fillButton.textContent = (input.type === 'checkbox' || input.type === 'radio' ? 'Apply ' : 'Fill ') + control.label;
        fillButton.addEventListener('click', () => actionRequest('fill', String(control.id), input, control));
        host.appendChild(fillButton);
      }
      const navActions = [
        ['refresh', 'Refresh ETH page'],
        ['back', 'Back'],
        ['close', 'Close sign-in window'],
      ];
      for (const [action, label] of navActions) {
        if (!allowedActions.has(action)) continue;
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'admin-btn-sm';
        button.textContent = label;
        button.addEventListener('click', async () => {
          try {
            const result = await connectorRequest(`/api/connectors/accounts/${encodeURIComponent(account.id)}/setup/action`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ action }),
            });
            await renderMoodleView(result.view || result);
          } catch (error) { setStatus(error.message || 'Could not update the ETH sign-in page.', true); }
        });
        host.appendChild(button);
      }
    };

    async function refreshMoodleView() {
      if (!account || !isMoodle) return;
      try {
        const view = await connectorRequest(`/api/connectors/accounts/${encodeURIComponent(account.id)}/setup/view`);
        await renderMoodleView(view);
      } catch (error) {
        setStatus(error.message || 'ETH sign-in window is not ready. Start sign-in to try again.', true);
      }
    }

    const renderWhatsappQr = async () => {
      const pairing = el('uf-whatsapp-pairing');
      const qrHost = el('uf-whatsapp-qr');
      if (!account || !pairing || !qrHost) return;
      pairing.hidden = false;
      try {
        const result = await connectorRequest(`/api/connectors/accounts/${encodeURIComponent(account.id)}/whatsapp/pairing`);
        qrHost.replaceChildren();
        const qrData = safeRasterDataUrl(result.qr_data_url);
        if (qrData) {
          const image = document.createElement('img');
          image.className = 'integration-qr';
          image.src = qrData;
          image.alt = 'Temporary WhatsApp device-pairing QR code';
          qrHost.appendChild(image);
          const expiry = document.createElement('p');
          expiry.className = 'integration-help';
          const expiresAt = result.expiresAt;
          const expiryDate = expiresAt ? new Date(expiresAt) : null;
          expiry.textContent = expiryDate && !Number.isNaN(expiryDate.getTime())
            ? `QR code expires ${expiryDate.toLocaleTimeString()}. If it expires, retry pairing.`
            : 'This QR code is temporary. If it expires, retry pairing.';
          qrHost.appendChild(expiry);
        } else {
          qrHost.textContent = result.message || 'Waiting for a fresh pairing QR code…';
        }
      } catch (error) {
        qrHost.textContent = error.message || 'The pairing code is not available yet. Retry setup.';
      }
    };

    const renderSetupStatus = async data => {
      const state = String(data?.state || data?.status || account?.status || 'setup_required');
      const message = typeof data?.message === 'string' ? data.message : typeof data?.error?.message === 'string' ? data.error.message : typeof data?.error === 'string' ? data.error : '';
      const errorCode = String(data?.error?.code || data?.code || '').toLowerCase();
      const expired = isMoodle && (errorCode.includes('expired') || /session expired/i.test(message));
      currentSetupState = state;
      setConnectorWizardStep(formEl, state === 'connected' ? 4 : state === 'awaiting_login' || state === 'awaiting_qr' ? 3 : 2);
      setStatus(expired ? 'Your Moodle sign-in session expired. Choose Reconnect ETH sign-in to start a fresh session.' : `${connectorSetupStateLabel(state)}${message ? ` · ${message}` : ''}`, state === 'error' || state === 'setup_required');
      const startButton = el('uf-connector-start');
      if (startButton) {
        startButton.dataset.retryable = data?.retryable ? '1' : '';
        startButton.disabled = ['starting', 'awaiting_login', 'awaiting_qr'].includes(state);
        startButton.textContent = expired
          ? 'Reconnect ETH sign-in'
          : state === 'connected'
            ? (isMoodle ? 'Reconnect Moodle' : 'Pair another device')
            : data?.retryable ? 'Retry setup' : isMoodle ? 'Start ETH sign-in' : 'Prepare service and pair';
      }
      if (!isMoodle && state === 'awaiting_qr') await renderWhatsappQr();
      if (!isMoodle && state !== 'awaiting_qr') {
        el('uf-whatsapp-pairing').hidden = true;
        el('uf-whatsapp-qr').replaceChildren();
      }
      if (state === 'connected' && data?.account) {
        const info = data.account;
        const detail = [info.display_name, info.phone_number, info.phone, info.label].filter(Boolean).join(' · ');
        if (detail) setStatus(`Connected${detail ? ` · ${detail}` : ''}`);
        const qr = el('uf-whatsapp-pairing');
        if (qr) qr.hidden = true;
      }
      if (state === 'connected') setConnectorWizardStep(formEl, 4);
      return state;
    };

    const pollSetupStatus = async initial => {
      cleanupSetupPolling();
      const controller = new AbortController();
      activeSetupPoll = controller;
      const startedAt = Date.now();
      let attempts = 0;
      const poll = async () => {
        if (controller.signal.aborted || !formEl.isConnected || formEl.style.display === 'none') return;
        attempts += 1;
        try {
          const data = initial && attempts === 1
            ? initial
            : await connectorRequest(`/api/connectors/accounts/${encodeURIComponent(account.id)}/setup/status`, { signal: controller.signal });
          const state = await renderSetupStatus(data);
          if (controller.signal.aborted) return;
          if (['connected', 'error', 'setup_required', 'stopped'].includes(state)) {
            cleanupSetupPolling();
            await renderList();
            return;
          }
          if (attempts >= 36 || Date.now() - startedAt >= 240000) {
            setStatus('Setup is still running. Automatic checks paused; use “Refresh status” to check again.');
            cleanupSetupPolling();
            return;
          }
          setupPollTimer = setTimeout(poll, Math.min(8000, 700 * (2 ** Math.min(attempts - 1, 4))));
        } catch (error) {
          if (controller.signal.aborted) return;
          if (attempts >= 36 || Date.now() - startedAt >= 240000) {
            setStatus(`${error.message || 'Could not check setup status.'} Automatic checks paused; retry when ready.`, true);
            cleanupSetupPolling();
            return;
          }
          setupPollTimer = setTimeout(poll, Math.min(8000, 700 * (2 ** Math.min(attempts - 1, 4))));
        }
      };
      await poll();
    };

    const startSetup = async () => {
      if (!account?.id) return;
      if (isMoodle && methodSelect.value === 'token') return;
      cleanupSetupPolling();
      currentSetupState = 'starting';
      setConnectorWizardStep(formEl, 2);
      setStatus(isMoodle ? 'Preparing ETH sign-in…' : 'Preparing the WhatsApp service…');
      const startButton = el('uf-connector-start');
      if (startButton) startButton.disabled = true;
      const requestController = new AbortController();
      activeSetupRequest = requestController;
      try {
        const method = methodSelect?.value;
        const retry = startButton?.dataset.retryable === '1';
        const endpoint = retry ? 'retry' : 'start';
        const data = await connectorRequest(`/api/connectors/accounts/${encodeURIComponent(account.id)}/setup/${endpoint}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(isMoodle ? { method } : {}),
          signal: requestController.signal,
        });
        const handoff = data.handoff;
        if (isMoodle && method === 'normal_browser') {
          const callbackArea = el('uf-moodle-callback-area');
          if (callbackArea) callbackArea.hidden = false;
          const url = safeMoodleLaunchUrl(handoff?.launch_url);
          if (url) {
            const host = el('uf-moodle-browser-login');
            let openLink = host.querySelector('[data-moodle-handoff-link]');
            if (!openLink) {
              openLink = document.createElement('a');
              openLink.dataset.moodleHandoffLink = '1';
              openLink.target = '_blank';
              openLink.rel = 'noopener noreferrer';
              openLink.textContent = 'Open the secure ETH sign-in handoff';
              host.appendChild(openLink);
            }
            openLink.href = url;
          }
          const handoffMessage = typeof handoff?.message === 'string' && handoff.message.trim()
            ? handoff.message.trim()
            : 'Secure handoff ready. Finish ETH sign-in, then paste the one-time callback link here.';
          const expiryMessage = Number(handoff?.expires_in) > 0
            ? `This handoff expires in ${Number(handoff.expires_in)} seconds.`
            : '';
          const handoffMessageEl = el('uf-moodle-handoff-message');
          if (handoffMessageEl) {
            handoffMessageEl.textContent = [handoffMessage, expiryMessage].filter(Boolean).join(' ');
            handoffMessageEl.hidden = false;
          }
          setStatus(handoffMessage);
        }
        if (isMoodle && method === 'remote') await refreshMoodleView();
        await pollSetupStatus(data);
      } catch (error) {
        if (!requestController.signal.aborted) {
          currentSetupState = 'error';
          setStatus(error.message || 'Could not start setup.', true);
        }
      } finally {
        if (activeSetupRequest === requestController) activeSetupRequest = null;
        if (startButton?.isConnected) startButton.disabled = ['starting', 'awaiting_login', 'awaiting_qr'].includes(currentSetupState);
      }
    };

    el('uf-connector-start')?.addEventListener('click', startSetup);
    el('uf-moodle-finish-handoff')?.addEventListener('click', async () => {
      const input = el('uf-moodle-callback');
      const callback = input.value.trim();
      if (!callback) return setStatus('Paste the one-time Moodle callback link to finish sign-in.', true);
      try {
        setStatus('Verifying the one-time Moodle handoff…');
        const result = await connectorRequest(`/api/connectors/accounts/${encodeURIComponent(account.id)}/setup/callback`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ callback }),
        });
        await renderSetupStatus(result);
        await pollSetupStatus(result);
      } catch (error) {
        setStatus(error.message || 'Could not verify the Moodle callback. Start a fresh sign-in if it expired.', true);
      } finally {
        input.value = '';
      }
    });
    el('uf-connector-cancel')?.addEventListener('click', async event => {
      const cancelButton = event.currentTarget;
      cancelButton.disabled = true;
      const state = currentSetupState;
      cleanupSetupPolling();
      if (account?.id && ['starting', 'awaiting_login', 'awaiting_qr'].includes(state)) {
        try {
          await connectorRequest(`/api/connectors/accounts/${encodeURIComponent(account.id)}/setup/stop`, { method: 'POST' });
        } catch (error) {
          setStatus(`Could not stop setup cleanly: ${error.message || 'retry from this account.'}`, true);
          cancelButton.disabled = false;
          return;
        }
      }
      cleanupSetupPolling();
      formEl.style.display = 'none';
      formEl.replaceChildren();
    });

    el('uf-connector-save').addEventListener('click', async event => {
      const button = event.currentTarget;
      button.disabled = true;
      const secretInput = el('uf-connector-secret');
      try {
        const name = el('uf-connector-name').value.trim();
        if (!name) throw new Error('Enter a name for this account.');
        const method = methodSelect?.value || methodDefault;
        const secret = secretInput && !secretInput.closest('[hidden]') ? secretInput.value.trim() : '';
        if (isMoodle && method === 'token' && !secret && (!account?.has_credentials || config.auth_mode !== 'token')) throw new Error('Paste an authorized Moodle web-service token or choose Sign in with ETH.');
        if (!isMoodle && method === 'external' && !supportsExternal) {
          throw new Error('This deployment has not reported external bridge support. Choose Managed by Odysseus or refresh setup information.');
        }
        const semanticIndex = !!el('uf-connector-semantic')?.checked;
        const autoSync = !!el('uf-connector-auto')?.checked;
        const interval = Number(el('uf-connector-interval')?.value || 30);
        const outboundToggle = el('uf-connector-write');
        const outboundAcknowledgement = el('uf-connector-write-ack');
        if (!isMoodle && outboundToggle?.checked && !outboundAcknowledgement?.checked) {
          throw new Error('Confirm outbound permission before saving. Scheduled sends still require their own acknowledgement each run.');
        }
        const writeEnabled = !isMoodle && !!outboundToggle?.checked && !!outboundAcknowledgement?.checked;
        const nextConfig = {
          ...(config || {}),
          ...(isMoodle ? { auth_mode: method === 'token' ? 'token' : method === 'normal_browser' ? 'normal_browser' : 'browser' } : { mode: method }),
          semantic_index: semanticIndex,
          auto_sync: autoSync,
          sync_interval_minutes: interval,
        };
        const credentials = secret ? { [isMoodle ? 'moodle_token' : 'api_key']: secret } : {};
        const body = {
          name,
          config: nextConfig,
          semantic_index: semanticIndex,
          auto_sync: autoSync,
          sync_interval_minutes: interval,
          ...(!isMoodle && method === 'managed' ? { write_enabled: writeEnabled } : {}),
        };
        let result;
        if (editId) {
          if (secret || (isMoodle && method !== 'token' && config.auth_mode === 'token')) body.credentials = credentials;
          result = await connectorRequest(`/api/connectors/accounts/${encodeURIComponent(editId)}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });
          account = result.account || account;
          config = account.config || config;
          const sendButton = el('uf-connector-actions')?.querySelector('[data-write-enabled]');
          if (sendButton) {
            const canSend = account.write_enabled === true;
            sendButton.dataset.writeEnabled = canSend ? 'true' : 'false';
            sendButton.disabled = !canSend;
            sendButton.title = canSend ? 'Send one message after confirmation' : 'Enable outbound messages above and save to send';
          }
          showConnectorOutput(output, 'Settings saved.');
          setConnectorWizardStep(formEl, account?.status === 'connected' ? 4 : 2);
          if (isMoodle && method === 'token') {
            setStatus('Token saved securely. Verifying Moodle access…');
            await pollSetupStatus(await connectorRequest(`/api/connectors/accounts/${encodeURIComponent(account.id)}/setup/status`));
          }
          await renderList();
          notifyIntegrationsChanged();
        } else {
          result = await connectorRequest('/api/connectors/accounts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ provider: type, ...body, credentials }),
          });
          const newId = result.account?.id || result.id;
          if (!newId) throw new Error('The account was created, but the server did not return its account ID. Refresh the account list to continue.');
          await renderList();
          await showGuidedConnectorForm(type, newId, method, true);
        }
      } catch (error) {
        showConnectorOutput(output, error.message || 'Could not save account settings.', true);
      } finally {
        if (secretInput) secretInput.value = '';
        button.disabled = false;
      }
    });

    if (account) {
      await renderConnectorActions(type, account);
      const startButton = el('uf-connector-start');
      const syncButton = document.createElement('button');
      syncButton.type = 'button';
      syncButton.className = 'admin-btn-sm';
      syncButton.textContent = isMoodle ? 'Sync courses and files' : 'Sync available history now';
      syncButton.addEventListener('click', async () => {
        syncButton.disabled = true;
        try {
          const result = await connectorRequest(`/api/connectors/accounts/${encodeURIComponent(account.id)}/sync${isMoodle ? '' : '?max_pages=200'}`, { method: 'POST' });
          const summary = result.message || result.summary || (typeof result.records === 'number' ? `Sync complete: ${result.records} records processed.` : 'Sync request completed. Check account status for indexing progress.');
          showConnectorOutput(output, summary);
          await renderList();
        } catch (error) { showConnectorOutput(output, error.message || 'Sync failed.', true); }
        finally { syncButton.disabled = false; }
      });
      el('uf-connector-actions')?.appendChild(syncButton);
      const refreshButton = document.createElement('button');
      refreshButton.type = 'button';
      refreshButton.className = 'admin-btn-sm';
      refreshButton.textContent = 'Refresh status';
      refreshButton.addEventListener('click', async () => {
        try {
          const data = await connectorRequest(`/api/connectors/accounts/${encodeURIComponent(account.id)}/setup/status`);
          await renderSetupStatus(data);
          if (!['connected', 'error', 'setup_required', 'stopped'].includes(data.state || data.status)) await pollSetupStatus(data);
        } catch (error) { setStatus(error.message || 'Could not refresh status.', true); }
      });
      el('uf-connector-actions')?.appendChild(refreshButton);
      const stopButton = document.createElement('button');
      stopButton.type = 'button';
      stopButton.className = 'admin-btn-sm';
      stopButton.textContent = 'Stop setup';
      stopButton.addEventListener('click', async () => {
        cleanupSetupPolling();
        stopButton.disabled = true;
        try {
          const result = await connectorRequest(`/api/connectors/accounts/${encodeURIComponent(account.id)}/setup/stop`, { method: 'POST' });
          currentSetupState = 'stopped';
          setStatus(result.message || connectorSetupStateLabel(result.state || result.status || 'stopped'));
          if (!isMoodle) el('uf-whatsapp-pairing').hidden = true;
        } catch (error) { setStatus(error.message || 'Could not stop setup.', true); }
        finally { stopButton.disabled = false; }
      });
      el('uf-connector-actions')?.appendChild(stopButton);
      if (isMoodle && methodDefault === 'remote') {
        const state = account.setup_status || account.status;
        if (state === 'awaiting_login') await refreshMoodleView();
      }
      if (!isMoodle && (account.setup_status || account.status) === 'awaiting_qr') await renderWhatsappQr();
      setConnectorWizardStep(formEl, account.status === 'connected' ? 4 : 2);
      if (autoStart) {
        if (isMoodle && methodDefault === 'token') {
          setStatus('Token saved securely. Verifying Moodle access…');
          await pollSetupStatus(await connectorRequest(`/api/connectors/accounts/${encodeURIComponent(account.id)}/setup/status`));
        } else {
          await startSetup();
        }
      } else if (['starting', 'awaiting_login', 'awaiting_qr'].includes(currentSetupState)) {
        await pollSetupStatus();
      }
    }
  }
  async function showPersonalConnectorForm(type, editId) {
    if (type === 'moodle' || type === 'whatsapp') return showGuidedConnectorForm(type, editId);
    const labels = {
      maps: { title: 'Maps', key: 'api_key', label: 'OpenRouteService API key' },
      browser: { title: 'Browser Session', key: '', label: '' },
    };
    const spec = labels[type];
    let account = null;
    if (editId) {
      try {
        const data = await connectorRequest('/api/connectors/accounts');
        account = (data.accounts || []).find(item => item.id === editId) || null;
      } catch (err) {
        formEl.innerHTML = `<div class="admin-card" role="alert" style="margin-top:8px">${esc(err.message)}</div>`;
        return;
      }
    }
    if (editId && !account) {
      formEl.innerHTML = '<div class="admin-card" role="alert" style="margin-top:8px">Connector account not found.</div>';
      return;
    }
    const browser = type === 'browser';
    const credentialLabel = spec.label;
    formEl.innerHTML = `
      <div class="admin-card" style="margin-top:8px">
        <h2 style="font-size:13px">${editId ? `Edit ${spec.title}` : `Add ${spec.title}`}</h2>
        ${browser ? '<p class="integration-help">Creates an owner-isolated browser profile. Use the visible, service-provided page labels and buttons below to sign in yourself—no CSS selectors. Passwords are sent transiently for a single HTTPS field fill and cleared immediately; they are never saved as connector credentials. Your local password-manager extension may not be available inside this isolated profile. Session cookies are encrypted for your account. Private-network targets and purchase/cart/checkout/payment actions are blocked.</p>' : `<div class="integration-help"><strong>Maps setup · OpenRouteService</strong><p>Maps provides geocoding and directions. It needs an OpenRouteService API key; the key is stored encrypted and never redisplayed.</p><ol><li><a href="https://openrouteservice.org/dev/#/signup" target="_blank" rel="noopener noreferrer">Create an OpenRouteService account</a> and verify your email.</li><li>Open the dashboard’s API keys page and create or copy an API key with geocoding and directions access.</li><li>Paste it below, save, then test with a place name using “Find place”. A successful API response changes status to Connected.</li></ol><a href="https://openrouteservice.org/dev/#/home" target="_blank" rel="noopener noreferrer">OpenRouteService developer dashboard</a>${account ? `<p>Setup status: ${esc(account.setup_status || account.status || 'not verified')}.</p>` : ''}</div>`}
        <label class="settings-row"><span class="settings-label">Name</span><input id="uf-connector-name" class="settings-input" maxlength="120" value="${esc(account?.name || spec.title)}" autocomplete="off"></label>
        ${credentialLabel ? `<label class="settings-row"><span class="settings-label">${esc(credentialLabel)}</span><input id="uf-connector-secret" class="settings-input" type="password" autocomplete="new-password" spellcheck="false" placeholder="${editId ? 'Leave blank to keep the saved key' : 'Paste API key; hidden after saving'}"></label>` : ''}
        ${account ? '<div id="uf-connector-actions" class="integration-setup-actions"></div>' : ''}
        <div id="uf-connector-output" class="integration-setup-status" role="status" aria-live="polite"></div>
        <div class="integration-setup-actions">
          <button type="button" class="admin-btn-add" id="uf-connector-save">${editId ? 'Save' : 'Add and continue'}</button>
        </div>
      </div>`;
    const output = el('uf-connector-output');
    el('uf-connector-save').addEventListener('click', async event => {
      const button = event.currentTarget;
      const secretInput = el('uf-connector-secret');
      button.disabled = true;
      try {
        const name = el('uf-connector-name').value.trim();
        if (!name) throw new Error('Enter a name for this account.');
        const secret = credentialLabel ? secretInput.value.trim() : '';
        if (!editId && type === 'maps' && !secret) throw new Error('Paste your OpenRouteService API key, or close this form and choose Browser Session instead.');
        const credentials = secret ? { [spec.key]: secret } : {};
        const options = { headers: { 'Content-Type': 'application/json' } };
        let result;
        if (editId) {
          result = await connectorRequest(`/api/connectors/accounts/${encodeURIComponent(editId)}`, {
            ...options,
            method: 'PATCH',
            body: JSON.stringify({ name, ...(secret ? { credentials } : {}) }),
          });
          showConnectorOutput(output, type === 'maps' ? 'Maps settings saved. Use “Find place” to verify the key.' : 'Browser Session settings saved.');
        } else {
          result = await connectorRequest('/api/connectors/accounts', {
            ...options,
            method: 'POST',
            body: JSON.stringify({ provider: type, name, credentials }),
          });
          const newId = result.account?.id || result.id;
          if (!newId) throw new Error('The account was created, but no account ID was returned. Refresh the account list to continue.');
          await renderList();
          await showPersonalConnectorForm(type, newId);
          return;
        }
        await renderList();
      } catch (err) { showConnectorOutput(output, err.message || 'Could not save account.', true); }
      finally {
        if (secretInput) secretInput.value = '';
        if (button.isConnected) button.disabled = false;
      }
    });
    if (account) await renderConnectorActions(type, account);
  }

  async function renderConnectorActions(type, account) {
    const actions = el('uf-connector-actions');
    const output = el('uf-connector-output');
    if (!actions || !output) return;
    const id = encodeURIComponent(account.id);
    const actionButton = (label, callback) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'admin-btn-add';
      button.textContent = label;
      button.addEventListener('click', async () => {
        button.disabled = true;
        try { await callback(); } catch (err) { showConnectorOutput(output, err.message, true); }
        finally { button.disabled = false; }
      });
      actions.appendChild(button);
    };
    const get = url => connectorRequest(url);
    const browserAction = body => connectorRequest(`/api/connectors/accounts/${id}/browser/action`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    if (type === 'browser') {
      const addressLabel = document.createElement('label');
      addressLabel.className = 'settings-row';
      const addressLabelText = document.createElement('span');
      addressLabelText.className = 'settings-label';
      addressLabelText.textContent = 'Public website';
      const address = document.createElement('input');
      address.type = 'url';
      address.className = 'settings-input';
      address.placeholder = 'https://example.com';
      address.autocomplete = 'url';
      addressLabel.append(addressLabelText, address);
      const viewHost = document.createElement('div');
      viewHost.className = 'integration-help';
      viewHost.setAttribute('aria-label', 'Browser page and sign-in controls');
      const stateNode = document.createElement('p');
      stateNode.className = 'integration-setup-status';
      stateNode.setAttribute('role', 'status');
      stateNode.setAttribute('aria-live', 'polite');
      stateNode.textContent = account.status === 'connected' ? 'Browser profile active; this does not mean you are signed in to a merchant.' : 'Start the browser profile, then navigate to a public HTTPS page.';
      const publicUrl = raw => {
        try {
          const parsed = new URL(String(raw || ''));
          return ['http:', 'https:'].includes(parsed.protocol) ? parsed.href : '';
        } catch (_) { return ''; }
      };
      const renderBrowserView = async view => {
        viewHost.replaceChildren();
        const pageUrl = publicUrl(view.url);
        const title = document.createElement('p');
        title.textContent = `${view.title || 'Current browser page'}${pageUrl ? ` · ${pageUrl}` : ''}`;
        viewHost.appendChild(title);
        if (view.message) {
          const message = document.createElement('p');
          message.className = 'integration-help';
          message.textContent = view.message;
          viewHost.appendChild(message);
        }
        const screenshot = safeRasterDataUrl(view.screenshot_data_url);
        if (screenshot) {
          const image = document.createElement('img');
          image.className = 'integration-remote-screenshot';
          image.src = screenshot;
          image.alt = `Current browser page${view.title ? `: ${view.title}` : ''}`;
          viewHost.appendChild(image);
        }
        const controls = Array.isArray(view.controls) ? view.controls : [];
        const allowedActions = new Set(Array.isArray(view.actions) ? view.actions : []);
        const perform = async (action, controlId, input) => {
          if (!allowedActions.has(action)) return;
          const sensitive = input?.type === 'password';
          const value = input ? remoteFieldValue(input) : '';
          const controller = new AbortController();
          activeSetupRequest = controller;
          try {
            if (action === 'fill' && (!pageUrl || !pageUrl.startsWith('https://'))) {
              showConnectorOutput(stateNode, 'Form fields can only be filled on a verified HTTPS page.', true);
              return;
            }
            if (action === 'fill' && sensitive && !input._credentialConsent?.checked) {
              showConnectorOutput(stateNode, 'Confirm the one-time HTTPS credential disclosure before filling a password.', true);
              input._credentialConsent?.focus();
              return;
            }
            stateNode.textContent = sensitive
              ? 'Sending this password only for the current HTTPS field fill…'
              : 'Updating the browser page…';
            const result = await connectorRequest(`/api/connectors/accounts/${id}/setup/action`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ action, control_id: controlId, value }),
              signal: controller.signal,
            });
            showConnectorOutput(stateNode, result.message || 'Page updated. Continue sign-in or MFA yourself.');
            if (result.view || result.controls || result.screenshot_data_url) await renderBrowserView(result.view || result);
            else await refreshBrowserView();
          } catch (error) {
            if (!controller.signal.aborted) showConnectorOutput(stateNode, error.message || 'Could not update the browser page.', true);
          } finally {
            if (sensitive) {
              input.value = '';
              if (input._credentialConsent) input._credentialConsent.checked = false;
            }
            if (activeSetupRequest === controller) activeSetupRequest = null;
          }
        };
        for (const control of controls) {
          if (!control || control.disabled || !control.id || !control.label) continue;
          const tag = String(control.tag || '').toLowerCase();
          const typeValue = String(control.type || '').toLowerCase();
          const label = `${control.label}${control.origin ? ` · ${control.origin}` : ''}`;
          if (tag === 'button' || tag === 'a' || ['button', 'submit'].includes(typeValue)) {
            if (!allowedActions.has('click')) continue;
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'admin-btn-sm';
            button.textContent = label;
            button.addEventListener('click', () => perform('click', String(control.id)));
            viewHost.appendChild(button);
            continue;
          }
          if (!allowedActions.has('fill')) continue;
          const field = document.createElement('label');
          field.className = 'settings-row';
          const caption = document.createElement('span');
          caption.className = 'settings-label';
          caption.textContent = label;
          const input = createRemoteField(control);
          field.append(caption, input);
          viewHost.appendChild(field);
          if (input.type === 'password') {
            const disclosure = document.createElement('p');
            disclosure.className = 'integration-help';
            disclosure.textContent = `If you choose to fill this password from ${control.origin || 'this page'}, it is sent over HTTPS to Odysseus server memory for this single action and cleared immediately after the request. It is not saved as a connector credential. Complete MFA yourself.`;
            const consentLabel = document.createElement('label');
            consentLabel.className = 'settings-row';
            const consent = document.createElement('input');
            consent.type = 'checkbox';
            consentLabel.append(consent, document.createTextNode('I understand this password is sent for one HTTPS field-fill request.'));
            input._credentialConsent = consent;
            viewHost.append(disclosure, consentLabel);
          }
          const fill = document.createElement('button');
          fill.type = 'button';
          fill.className = 'admin-btn-sm';
          fill.textContent = (input.type === 'checkbox' || input.type === 'radio' ? 'Apply ' : 'Fill ') + label;
          fill.addEventListener('click', () => perform('fill', String(control.id), input));
          viewHost.appendChild(fill);
        }
        for (const [action, label] of [['refresh', 'Refresh page'], ['back', 'Back'], ['close', 'Close page']]) {
          if (!allowedActions.has(action)) continue;
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'admin-btn-sm';
          button.textContent = label;
          button.addEventListener('click', async () => {
            try {
              const result = await connectorRequest(`/api/connectors/accounts/${id}/setup/action`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action }),
              });
              renderBrowserView(result.view || result);
            } catch (error) { showConnectorOutput(stateNode, error.message || 'Could not update the browser page.', true); }
          });
          viewHost.appendChild(button);
        }
      };
      const refreshBrowserView = async () => {
        const view = await connectorRequest(`/api/connectors/accounts/${id}/setup/view`);
        await renderBrowserView(view);
      };
      actions.append(addressLabel);
      const navigate = document.createElement('button');
      navigate.type = 'button';
      navigate.className = 'admin-btn-add';
      navigate.textContent = 'Open site';
      navigate.addEventListener('click', async () => {
        const target = publicUrl(address.value.trim());
        if (!target) return showConnectorOutput(stateNode, 'Enter a public HTTP or HTTPS website address.', true);
        navigate.disabled = true;
        try {
          await browserAction({ action: 'navigate', url: target });
          await refreshBrowserView();
          stateNode.textContent = 'Page opened. Sign in yourself; purchase, checkout, and payment actions are blocked.';
        } catch (error) { showConnectorOutput(stateNode, error.message || 'Could not open the website.', true); }
        finally { navigate.disabled = false; }
      });
      actionButton('Start browser session', async () => {
        const result = await connectorRequest(`/api/connectors/accounts/${id}/setup/start`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
        showConnectorOutput(stateNode, 'Browser profile is active; this does not mean you are signed in to a merchant.');
        await refreshBrowserView();
        await renderList();
      });
      actionButton('Session status', async () => {
        const result = await connectorRequest(`/api/connectors/accounts/${id}/setup/status`);
        const state = result.state || result.status || 'setup_required';
        stateNode.textContent = state === 'connected'
          ? 'Browser profile active; this does not mean you are signed in to a merchant.'
          : `${connectorSetupStateLabel(state)}${result.message ? ` · ${result.message}` : ''}`;
      });
      actionButton('Read page controls', async () => refreshBrowserView());
      actionButton('Close browser session', async () => {
        await connectorRequest(`/api/connectors/accounts/${id}/setup/stop`, { method: 'POST' });
        stateNode.textContent = 'Browser session closed.';
        viewHost.replaceChildren();
      });
      actions.append(navigate, stateNode, viewHost);
    } else if (type === 'whatsapp') {
      actionButton('Sync history', async () => {
        const result = await connectorRequest(`/api/connectors/accounts/${id}/sync?max_pages=200`, { method: 'POST' });
        showConnectorOutput(output, result);
        await renderList();
      });
      actionButton('History progress', async () => showConnectorOutput(output, await get(`/api/connectors/accounts/${id}/whatsapp/history`)));
      actionButton('List chats', async () => showConnectorOutput(output, await get(`/api/connectors/accounts/${id}/whatsapp/chats?limit=100`)));
      const chat = document.createElement('input');
      chat.className = 'settings-input';
      chat.placeholder = 'WhatsApp chat ID';
      chat.setAttribute('aria-label', 'WhatsApp chat ID');
      chat.style.marginTop = '8px';
      const read = document.createElement('button');
      read.type = 'button'; read.className = 'admin-btn-add'; read.textContent = 'Read messages';
      read.addEventListener('click', async () => {
        try {
          if (!chat.value.trim()) throw new Error('Enter a chat ID.');
          const url = `/api/connectors/accounts/${id}/whatsapp/messages?chat_id=${encodeURIComponent(chat.value.trim())}&limit=100`;
          showConnectorOutput(output, await get(url));
        } catch (err) { showConnectorOutput(output, err.message, true); }
      });
      const text = document.createElement('textarea');
      text.className = 'settings-input';
      text.placeholder = 'Message text';
      text.setAttribute('aria-label', 'WhatsApp message text');
      text.rows = 3;
      text.style.marginTop = '8px';
      const send = document.createElement('button');
      send.type = 'button'; send.className = 'admin-btn-add'; send.textContent = 'Send message';
      send.dataset.writeEnabled = account.write_enabled === true ? 'true' : 'false';
      send.disabled = send.dataset.writeEnabled !== 'true';
      send.title = send.disabled ? 'Enable outbound messages above and save to send' : 'Send one message after confirmation';
      let pendingSend = null;
      send.addEventListener('click', async () => {
        const chatId = chat.value.trim();
        const message = text.value.trim();
        try {
          if (send.dataset.writeEnabled !== 'true') throw new Error('Outbound messaging is off. Enable it and save the account first.');
          if (!chatId || !message) throw new Error('Enter a chat ID and message.');
          const intent = `${account.id}\0${chatId}\0${message}`;
          if (!pendingSend || pendingSend.intent !== intent) {
            const key = window.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
            pendingSend = { intent, key };
          }
          if (!await window.styledConfirm(`Send this message to ${chatId}?`, { confirmText: 'Send', danger: true })) return;
          send.disabled = true;
          const result = await connectorRequest(`/api/connectors/accounts/${id}/whatsapp/send`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text: message, idempotency_key: pendingSend.key }),
          });
          const delivery = result?.status || result?.result?.status;
          if (delivery !== 'unknown') {
            text.value = '';
            pendingSend = null;
          }
          showConnectorOutput(output, delivery === 'unknown'
            ? { ...result, retry: 'Delivery is unknown. Retry the unchanged message to reuse the same idempotency key.' }
            : result);
        } catch (err) { showConnectorOutput(output, err.message, true); }
        finally { send.disabled = send.dataset.writeEnabled !== 'true'; }
      });
      const search = document.createElement('input');
      search.className = 'settings-input';
      search.placeholder = 'Search WhatsApp history';
      search.setAttribute('aria-label', 'Search WhatsApp history');
      const searchButton = document.createElement('button');
      searchButton.type = 'button'; searchButton.className = 'admin-btn-add'; searchButton.textContent = 'Search';
      searchButton.addEventListener('click', async () => {
        try {
          const query = search.value.trim();
          if (!query) throw new Error('Enter a search term.');
          const params = new URLSearchParams({ query, limit: '100' });
          if (chat.value.trim()) params.set('chat_id', chat.value.trim());
          showConnectorOutput(output, await get(`/api/connectors/accounts/${id}/whatsapp/search?${params}`));
        } catch (err) { showConnectorOutput(output, err.message, true); }
      });
      const backfill = document.createElement('button');
      backfill.type = 'button'; backfill.className = 'admin-btn-add'; backfill.textContent = 'Backfill this chat';
      backfill.addEventListener('click', async () => {
        try {
          const chatId = chat.value.trim();
          if (!chatId) throw new Error('Enter a chat ID.');
          const result = await connectorRequest(`/api/connectors/accounts/${id}/whatsapp/history/backfill`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, count: 100, max_pages: 20, max_messages: 2000, timeout_ms: 60000 }),
          });
          showConnectorOutput(output, result);
        } catch (err) { showConnectorOutput(output, err.message, true); }
      });
      actions.append(chat, read, search, searchButton, backfill, text, send);
      actionButton('Sync archived records', async () => {
        const result = await connectorRequest(`/api/connectors/accounts/${id}/sync?max_pages=200&batch_size=200`, { method: 'POST' });
        showConnectorOutput(output, result);
        await renderList();
      });
    } else if (type === 'maps') {
      const query = document.createElement('input');
      query.className = 'settings-input';
      query.placeholder = 'Place to find';
      query.setAttribute('aria-label', 'Place or address to find');
      const geocode = document.createElement('button');
      geocode.type = 'button'; geocode.className = 'admin-btn-add'; geocode.textContent = 'Find place';
      geocode.addEventListener('click', async () => {
        if (!query.value.trim()) return showConnectorOutput(output, 'Enter a place or address.', true);
        geocode.disabled = true;
        showConnectorOutput(output, 'Checking OpenRouteService access…');
        try {
          const result = await connectorRequest('/api/connectors/maps/geocode', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query: query.value.trim(), account_id: account.id, limit: 1 }),
          });
          showConnectorOutput(output, result);
          await renderList();
        } catch (err) { showConnectorOutput(output, err.message || 'Maps test failed. Check the API key and retry.', true); }
        finally { geocode.disabled = false; }
      });
      const from = document.createElement('input');
      from.className = 'settings-input'; from.placeholder = 'Route origin'; from.setAttribute('aria-label', 'Route origin');
      const to = document.createElement('input');
      to.className = 'settings-input'; to.placeholder = 'Route destination'; to.setAttribute('aria-label', 'Route destination');
      const directions = document.createElement('button');
      directions.type = 'button'; directions.className = 'admin-btn-add'; directions.textContent = 'Directions';
      directions.addEventListener('click', async () => {
        if (!from.value.trim() || !to.value.trim()) return showConnectorOutput(output, 'Enter both route locations.', true);
        directions.disabled = true;
        try {
          const result = await connectorRequest('/api/connectors/maps/directions', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ origin: from.value.trim(), destination: to.value.trim(), account_id: account.id }),
          });
          showConnectorOutput(output, result);
          await renderList();
        } catch (err) { showConnectorOutput(output, err.message || 'Directions request failed. Check the API key and retry.', true); }
        finally { directions.disabled = false; }
      });
      actions.append(query, geocode, from, to, directions);
    }
  }

  function showShoppingSearchForm() {
    formEl.innerHTML = `
      <div class="admin-card" style="margin-top:8px">
        <h2 style="font-size:13px">Shopping search</h2>
        <p class="integration-help">Searches public product listings only. Sign in yourself through the isolated Browser Session when a merchant requires it; the browser does not buy items, enter carts, or submit checkout/payment actions. Prices may be stale—verify them on the merchant page.</p>
        <p><button type="button" class="admin-btn-sm" id="uf-shopping-browser-settings">Set up Browser Session for merchant sign-in</button></p>
        <div style="display:flex;gap:6px"><input id="uf-shopping-query" class="settings-input" aria-label="Product search" placeholder="What are you looking for?"><button type="button" class="admin-btn-add" id="uf-shopping-search">Search</button></div>
        <div id="uf-shopping-output" role="status" aria-live="polite" style="max-height:360px;overflow:auto;margin-top:8px"></div>
      </div>`;
    const output = el('uf-shopping-output');
    el('uf-shopping-browser-settings').addEventListener('click', async () => {
      try {
        const accounts = await connectorRequest('/api/connectors/accounts');
        const browserAccount = (accounts.accounts || []).find(item => item.provider === 'browser');
        showForm('browser', browserAccount?.id || null);
      } catch (error) { showConnectorOutput(output, error.message || 'Could not load Browser Session setup.', true); }
    });
    const safeHttpUrl = raw => {
      try {
        const parsed = new URL(String(raw || ''));
        return ['http:', 'https:'].includes(parsed.protocol) ? parsed.href : '';
      } catch (_) { return ''; }
    };
    const searchButton = el('uf-shopping-search');
    searchButton.addEventListener('click', async () => {
      const query = el('uf-shopping-query').value.trim();
      if (!query) return showConnectorOutput(output, 'Enter a product or query.', true);
      searchButton.disabled = true;
      output.textContent = 'Searching public merchant listings…';
      try {
        const result = await connectorRequest(`/api/connectors/shopping/search?query=${encodeURIComponent(query)}`);
        output.replaceChildren();
        const note = document.createElement('p');
        note.style.cssText = 'font-size:11px;opacity:.7';
        note.textContent = result.price_note || 'Prices may be stale; verify on the merchant page.';
        output.appendChild(note);
        const products = Array.isArray(result.products) ? result.products : [];
        if (!products.length) {
          const empty = document.createElement('p');
          empty.textContent = 'No verifiable product pages were returned.';
          output.appendChild(empty);
        }
        products.forEach(product => {
          const card = document.createElement('div');
          card.style.cssText = 'padding:9px;margin:6px 0;border:1px solid var(--border);border-radius:7px';
          const title = document.createElement('div');
          title.style.fontWeight = '600';
          title.textContent = String(product.title || 'Product');
          card.appendChild(title);
          const offer = product.offer || {};
          const details = [offer.price && `${offer.price} ${offer.currency || ''}`.trim(), offer.seller, offer.availability]
            .filter(Boolean).join(' · ');
          if (details) {
            const meta = document.createElement('div');
            meta.style.cssText = 'font-size:11px;opacity:.7;margin-top:3px';
            meta.textContent = details;
            card.appendChild(meta);
          }
          if (product.description) {
            const description = document.createElement('div');
            description.style.cssText = 'font-size:11px;margin-top:4px';
            description.textContent = String(product.description);
            card.appendChild(description);
          }
          const merchantUrl = safeHttpUrl(product.merchant_url);
          if (merchantUrl) {
            const link = document.createElement('a');
            link.href = merchantUrl;
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            link.textContent = 'Open merchant page';
            link.style.cssText = 'display:inline-block;margin:7px 10px 0 0;font-size:11px';
            card.appendChild(link);
            const handoff = document.createElement('button');
            handoff.type = 'button';
            handoff.className = 'admin-btn-add';
            handoff.textContent = 'Continue in Browser Session (sign in yourself)';
            handoff.addEventListener('click', async () => {
              handoff.disabled = true;
              try {
                const accounts = await connectorRequest('/api/connectors/accounts');
                const browser = (accounts.accounts || []).find(account => account.provider === 'browser');
                if (!browser) throw new Error('Set up a Browser Session first; then return here to hand off the merchant page.');
                const browserId = encodeURIComponent(browser.id);
                const status = await connectorRequest(`/api/connectors/accounts/${browserId}/setup/status`);
                if ((status.state || status.status) !== 'connected') {
                  await connectorRequest(`/api/connectors/accounts/${browserId}/setup/start`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({}),
                  });
                }
                await connectorRequest(`/api/connectors/accounts/${browserId}/browser/action`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ action: 'navigate', url: merchantUrl }),
                });
                showForm('browser', browser.id);
              } catch (err) { showConnectorOutput(output, err.message || 'Could not open the merchant page in Browser Session.', true); }
              finally { handoff.disabled = false; }
            });
            card.appendChild(handoff);
          }
          output.appendChild(card);
        });
      } catch (err) { showConnectorOutput(output, err.message || 'Shopping search failed. Retry when ready.', true); }
      finally { searchButton.disabled = false; }
    });
  }

  // ── API form ──
  async function showApiForm(editId) {
    let presets = {};
    try {
      const r = await fetch('/api/auth/integrations/presets', { credentials: 'same-origin' });
      if (r.ok) { const d = await r.json(); presets = d.presets || {}; }
    } catch (_) {}
    const presetEntries = Object.entries(presets);
    // Same `?` hint helper as the email form. Native title tooltip,
    // tabbable for keyboard users. Inline-styled so it doesn't need
    // a CSS dependency.
    const _apiHint = (tip) =>
      `<span class="uf-hint" title="${esc(tip.replace(/<[^>]+>/g, ''))}" aria-label="${esc(tip.replace(/<[^>]+>/g, ''))}" tabindex="0" `
      + `style="display:inline-block;width:13px;height:13px;border-radius:50%;`
      + `border:1px solid currentColor;font-size:9px;line-height:11px;text-align:center;`
      + `opacity:0.45;margin-left:5px;cursor:help;vertical-align:1px;font-weight:600;">?</span>`;
    // Real <select> instead of <datalist>: datalists are silently
    // suppressed in Firefox when autocomplete="off" is on the input,
    // and they're patchy on mobile browsers. A native select renders
    // the same everywhere and makes the available options visible
    // without needing the user to type.
    const sortedPresets = presetEntries.sort((a, b) => (a[1].name || a[0]).localeCompare(b[1].name || b[0]));
    const selectOpts = sortedPresets
      .map(([k, p]) => `<option value="${k}">${esc(p.name || k)}</option>`)
      .join('');
    // Letter-in-brand-color logo for each API preset; outline plug icon for
    // "Custom (no preset)". Matches the email-provider dropdown pattern.
    const _apiLetter = (letter, bg) => `<svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" style="flex-shrink:0"><circle cx="12" cy="12" r="11" fill="${bg}"/><text x="12" y="16.5" font-size="13" font-weight="700" text-anchor="middle" fill="#fff" font-family="system-ui,sans-serif">${letter}</text></svg>`;
    const _apiCustomIco = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="flex-shrink:0;opacity:0.7"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>';
    const API_PRESET_LOGO = {
      miniflux:        _apiLetter('M', '#214c87'),
      gitea:           _apiLetter('G', '#609926'),
      linkding:        _apiLetter('L', '#1f2937'),
      home_assistant:  _apiLetter('H', '#41bdf5'),
      ntfy:            _apiLetter('n', '#317f43'),
      vaultwarden:     _apiLetter('V', '#175ddc'),
      freshrss:        _apiLetter('R', '#ef6c00'),
    };
    const _apiIconFor = (k) => {
      if (!k) return _apiCustomIco;
      if (API_PRESET_LOGO[k]) return API_PRESET_LOGO[k];
      const first = (presets[k]?.name || k).trim().charAt(0).toUpperCase() || '?';
      return _apiLetter(first, '#6b7280');
    };
    const _apiRows = [['', 'Custom (no preset)'], ...sortedPresets.map(([k, p]) => [k, p.name || k])]
      .map(([k, label]) => `<button type="button" class="ufapi-option" data-value="${esc(k)}" style="display:flex;align-items:center;gap:10px;width:100%;padding:8px 10px;background:transparent;border:0;color:var(--fg);font:inherit;cursor:pointer;text-align:left;">${_apiIconFor(k)}<span>${esc(label)}</span></button>`).join('');
    formEl.innerHTML = `
      <div class="admin-card" style="margin-top:8px">
        <h2 style="font-size:13px;display:flex;align-items:center;gap:6px;"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:var(--accent, var(--red));flex-shrink:0;"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>API Integration</h2>
        <div class="settings-col">
          <div class="settings-row"><label class="settings-label">Preset</label>
            <div style="position:relative;flex:1;min-width:0;">
              <select id="uf-api-preset" tabindex="-1" aria-hidden="true" style="position:absolute;width:1px;height:1px;opacity:0;pointer-events:none;"><option value="">Custom (no preset)</option>${selectOpts}</select>
              <button type="button" id="uf-api-preset-trigger" class="settings-select" style="display:flex;align-items:center;gap:10px;cursor:pointer;text-align:left;width:100%;padding-right:24px;position:relative;">
                <span class="ufapi-icon" style="display:inline-flex;align-items:center;">${_apiCustomIco}</span>
                <span class="ufapi-label" style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">Custom (no preset)</span>
                <span aria-hidden="true" style="position:absolute;right:8px;top:50%;transform:translateY(-50%);opacity:0.5;font-size:10px;pointer-events:none;">▾</span>
              </button>
              <div id="uf-api-preset-menu" style="display:none;position:absolute;top:calc(100% + 2px);left:0;right:0;z-index:1000;background:var(--panel);border:1px solid var(--border);border-radius:6px;max-height:340px;overflow-y:auto;box-shadow:0 6px 18px rgba(0,0,0,0.25);">${_apiRows}</div>
            </div>
          </div>
          <div class="settings-row"><label class="settings-label">Name</label><input id="uf-api-name" class="settings-input" placeholder="My Service"></div>
          <div class="settings-row"><label class="settings-label">Base URL</label><input id="uf-api-url" class="settings-input" placeholder="http://localhost:8080"></div>
          <div id="uf-api-ntfy-hint" style="display:none;font-size:11px;line-height:1.35;opacity:0.68;margin:-2px 0 2px 106px;"></div>
          <div class="settings-row"><label class="settings-label">Auth${_apiHint('How this service expects the credential to be sent. <b>Bearer</b> = sends "Authorization: Bearer YOUR_KEY" (most modern APIs, ntfy, OpenAI-style). <b>Header</b> = sends YOUR_KEY verbatim under a header name you choose (Miniflux uses X-Auth-Token). <b>Basic</b> = HTTP basic auth (user:pass). <b>None</b> = the API is open / no auth.')}</label><select id="uf-api-auth" class="settings-input"><option value="bearer">Bearer (most common)</option><option value="header">Header</option><option value="basic">Basic</option><option value="none">None</option></select></div>
          <div class="settings-row" id="uf-api-header-row"><label class="settings-label">Header${_apiHint('The HTTP header name the key goes under (Miniflux: X-Auth-Token; most others: Authorization). Only used when Auth = Header.')}</label><input id="uf-api-header" class="settings-input" placeholder="X-Auth-Token"></div>
          <div class="settings-row"><label class="settings-label">API Key${_apiHint('The secret token the service issued you (generated in its admin panel / settings). Used to prove your identity on each request. Required for any Auth mode except None.')}</label><input id="uf-api-key" class="settings-input" type="password" placeholder="Token/key"></div>
          <div class="settings-row" style="margin-top:10px;align-items:center;justify-content:flex-end;gap:6px;">
            <span id="uf-api-msg" style="font-size:11px;flex:1;margin-right:8px"></span>
            <button class="admin-btn-add" id="uf-api-test" style="display:inline-flex;align-items:center;gap:5px;background:transparent;color:var(--accent, var(--red));border-color:color-mix(in srgb, var(--accent, var(--red)) 45%, var(--border));">Test</button>
            <button class="admin-btn-add" id="uf-api-save" style="display:inline-flex;align-items:center;gap:5px;background:transparent;color:var(--accent, var(--red));border-color:color-mix(in srgb, var(--accent, var(--red)) 45%, var(--border));font-weight:600;">Save</button>
            <button class="admin-btn-add" id="uf-api-cancel" style="display:inline-flex;align-items:center;gap:5px;background:transparent;color:var(--accent, var(--red));border-color:color-mix(in srgb, var(--accent, var(--red)) 45%, var(--border));">Cancel</button>
          </div>
        </div>
      </div>`;
    // Custom preset dropdown wire-up (hidden select stays as data source).
    (() => {
      const trig = el('uf-api-preset-trigger');
      const menu = el('uf-api-preset-menu');
      const sel = el('uf-api-preset');
      if (!trig || !menu || !sel) return;
      const lbl = trig.querySelector('.ufapi-label');
      const ico = trig.querySelector('.ufapi-icon');
      const _setFromKey = (k) => {
        const row = menu.querySelector(`.ufapi-option[data-value="${k}"]`);
        const text = row?.querySelector('span')?.textContent || 'Custom (no preset)';
        if (lbl) lbl.textContent = text;
        if (ico) ico.innerHTML = _apiIconFor(k);
      };
      // Menu is reused (hidden, not recreated). close() hides it and tears down
      // its outside-click listener + Escape-stack entry; bindMenuDismiss is
      // re-registered fresh on each open (see _open).
      let _close = () => { menu.style.display = 'none'; };
      const _open = () => {
        menu.style.display = 'block';
        const tRect = trig.getBoundingClientRect();
        const mRect = menu.getBoundingClientRect();
        const below = window.innerHeight - tRect.bottom;
        const above = tRect.top;
        if (mRect.height > below && above > below) { menu.style.top = 'auto'; menu.style.bottom = 'calc(100% + 2px)'; }
        else { menu.style.top = 'calc(100% + 2px)'; menu.style.bottom = 'auto'; }
        _close = bindMenuDismiss(menu, () => { menu.style.display = 'none'; }, (ev) => !menu.contains(ev.target) && ev.target !== trig);
      };
      trig.addEventListener('click', (e) => { e.stopPropagation(); menu.style.display === 'block' ? _close() : _open(); });
      menu.querySelectorAll('.ufapi-option').forEach(btn => {
        btn.addEventListener('mouseenter', () => { btn.style.background = 'color-mix(in srgb, var(--fg) 8%, transparent)'; });
        btn.addEventListener('mouseleave', () => { btn.style.background = 'transparent'; });
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const k = btn.dataset.value || '';
          sel.value = k;
          _setFromKey(k);
          _close();
          sel.dispatchEvent(new Event('change', { bubbles: true }));
        });
      });
      _setFromKey(sel.value || '');
    })();

    const preset = el('uf-api-preset'), name = el('uf-api-name'), url = el('uf-api-url'), auth = el('uf-api-auth'), header = el('uf-api-header'), key = el('uf-api-key'), ntfyHint = el('uf-api-ntfy-hint');
    let _editId = editId && editId !== 'new' ? editId : null;
    // Load existing
    if (_editId) {
      try {
        const r = await fetch('/api/auth/integrations', { credentials: 'same-origin' });
        const d = await r.json();
        const item = (d.integrations || []).find(i => i.id === _editId);
        if (item) { name.value = item.name || ''; url.value = item.base_url || ''; auth.value = item.auth_type || 'none'; header.value = item.auth_header || ''; }
      } catch (_) {}
    }
    // Native <select>: the option `value` is the preset key directly, so
    // no typed-name → key lookup is needed (datalist-era leftover).
    const _applyPreset = () => {
      const p = presets[preset.value];
      const isNtfy = preset.value === 'ntfy' || (p && (p.name || '').toLowerCase() === 'ntfy');
      const isUrlAuth = preset.value === 'discord_webhook'; // secret embedded in URL — no key/auth fields needed
      if (ntfyHint) {
        ntfyHint.style.display = isNtfy ? 'block' : 'none';
        if (isNtfy) {
          ntfyHint.innerHTML = 'Enter the ntfy server URL Odysseus can reach. Examples: <code>http://127.0.0.1:8091</code>, <code>http://100.x.y.z:8091</code>, or <code>https://ntfy.example.com</code>.';
        }
      }
      if (url) {
        url.placeholder = isNtfy ? 'http://127.0.0.1:8091' : isUrlAuth ? 'https://discord.com/api/webhooks/...' : 'http://localhost:8080';
      }
      // For presets that embed the secret in the URL, hide auth/key/header rows
      // so users aren't confused into thinking they need to fill them in.
      const keyRow = key?.closest('.settings-row');
      const authRow = auth?.closest('.settings-row');
      const headerRow = el('uf-api-header-row');
      if (keyRow) keyRow.style.display = isUrlAuth ? 'none' : '';
      if (authRow) authRow.style.display = isUrlAuth ? 'none' : '';
      if (headerRow) headerRow.style.display = isUrlAuth ? 'none' : '';
      if (!p) return;
      name.value = p.name || '';
      auth.value = p.auth_type || 'none';
      header.value = p.auth_header || '';
    };
    preset.addEventListener('change', _applyPreset);
    _applyPreset();
    el('uf-api-cancel').addEventListener('click', () => { formEl.style.display = 'none'; });
    el('uf-api-save').addEventListener('click', async () => {
      const presetKey = preset.value || undefined;
      const nameValue = name.value.trim();
      const urlValue = url.value.trim();
      if (!nameValue) { el('uf-api-msg').textContent = 'Name required'; el('uf-api-msg').style.color = 'var(--red)'; return; }
      if (!urlValue) { el('uf-api-msg').textContent = 'Base URL required'; el('uf-api-msg').style.color = 'var(--red)'; return; }
      const body = { name: nameValue, base_url: urlValue, auth_type: auth.value, auth_header: header.value, preset: presetKey };
      if (key.value) body.api_key = key.value;
      try {
        const u = _editId ? `/api/auth/integrations/${_editId}` : '/api/auth/integrations';
        const m = _editId ? 'PUT' : 'POST';
        const r = await fetch(u, { method: m, credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        if (!r.ok) throw new Error();
        const saved = await r.json().catch(() => null);
        // If this was a create, capture the new ID so Test works
        // immediately without needing a form reopen. The POST response
        // shape is {ok, integration: {id, ...}} — saved.id at the top
        // level would silently miss, leaving Test perpetually stuck on
        // "Save first" until the form was reopened.
        if (!_editId && saved) _editId = saved.integration?.id || saved.id;
        el('uf-api-msg').textContent = 'Saved'; el('uf-api-msg').style.color = 'var(--green,#50fa7b)';
        await renderList();
        notifyIntegrationsChanged();
      } catch (_) { el('uf-api-msg').textContent = 'Failed'; el('uf-api-msg').style.color = 'var(--red)'; }
    });
    el('uf-api-test').addEventListener('click', async () => {
      if (!_editId) { el('uf-api-msg').textContent = 'Save first'; return; }
      try {
        const r = await fetch(`/api/auth/integrations/${_editId}/test`, { method: 'POST', credentials: 'same-origin' });
        const d = await r.json();
        // Backend returns {ok: bool, message: str}
        if (d.ok) {
          el('uf-api-msg').textContent = d.message || 'Connected';
          el('uf-api-msg').style.color = 'var(--green,#50fa7b)';
        } else {
          el('uf-api-msg').textContent = (d.message || d.error || d.detail || `HTTP ${r.status}`).slice(0, 360);
          el('uf-api-msg').style.color = 'var(--red)';
        }
      } catch (e) { el('uf-api-msg').textContent = 'Error: ' + e.message; el('uf-api-msg').style.color = 'var(--red)'; }
    });
  }

  // ── CalDAV form (supports add + edit per account) ──
  async function showCalDavForm(editId) {
    const isNew = !editId || editId === 'new';
    formEl.innerHTML = `
      <div class="admin-card" style="margin-top:8px">
        <h2 style="font-size:13px;display:flex;align-items:center;gap:6px;"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:var(--accent, var(--red));flex-shrink:0;"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>${isNew ? 'Add CalDAV Calendar' : 'Edit CalDAV Calendar'}</h2>
        <div class="settings-col">
          <div class="settings-row"><label class="settings-label">Label</label><input id="uf-caldav-label" class="settings-input" placeholder="e.g. Work, Personal"></div>
          <div class="settings-row"><label class="settings-label">Server URL</label><input id="uf-caldav-url" class="settings-input" placeholder="https://www.google.com/calendar/dav/you@gmail.com/user/"></div>
          <div class="settings-row"><label class="settings-label">Username</label><input id="uf-caldav-user" class="settings-input" placeholder="you@example.com"></div>
          <div class="settings-row"><label class="settings-label">Password</label><input id="uf-caldav-pass" class="settings-input" type="password" placeholder="${isNew ? '' : 'Leave blank to keep existing'}"></div>
          <div class="settings-row" style="margin-top:10px;align-items:center;justify-content:flex-end;gap:6px;">
            <span id="uf-caldav-msg" style="font-size:11px;flex:1;margin-right:8px"></span>
            <button class="admin-btn-add" id="uf-caldav-test" style="display:inline-flex;align-items:center;gap:5px;background:transparent;color:var(--accent, var(--red));border-color:color-mix(in srgb, var(--accent, var(--red)) 45%, var(--border));">Test</button>
            <button class="admin-btn-add" id="uf-caldav-save" style="display:inline-flex;align-items:center;gap:5px;background:transparent;color:var(--accent, var(--red));border-color:color-mix(in srgb, var(--accent, var(--red)) 45%, var(--border));font-weight:600;">Save</button>
            <button class="admin-btn-add" id="uf-caldav-cancel" style="display:inline-flex;align-items:center;gap:5px;background:transparent;color:var(--accent, var(--red));border-color:color-mix(in srgb, var(--accent, var(--red)) 45%, var(--border));">Cancel</button>
          </div>
        </div>
      </div>`;

    if (!isNew) {
      try {
        const r = await fetch('/api/calendar/config/accounts', { credentials: 'same-origin' });
        const d = await r.json();
        const acc = (d.accounts || []).find(a => a.id === editId);
        if (acc) {
          el('uf-caldav-label').value = acc.label || '';
          el('uf-caldav-url').value = acc.url || '';
          el('uf-caldav-user').value = acc.username || '';
        }
      } catch (_) {}
    }

    el('uf-caldav-cancel').addEventListener('click', () => { formEl.style.display = 'none'; });

    const _runCalDavTest = async () => {
      const body = {
        url: el('uf-caldav-url').value.trim(),
        username: el('uf-caldav-user').value.trim(),
        password: el('uf-caldav-pass').value,
      };
      if (!isNew && !body.password) body.account_id = editId;
      try {
        const r = await fetch('/api/calendar/test', {
          method: 'POST', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        return await r.json();
      } catch (e) {
        return { ok: false, error: 'Network error: ' + e.message };
      }
    };

    const _setCalDavMsg = (text, ok) => {
      const msg = el('uf-caldav-msg');
      msg.textContent = text;
      msg.style.color = ok ? 'var(--green, #50fa7b)' : 'var(--red)';
    };

    el('uf-caldav-save').addEventListener('click', async () => {
      _setCalDavMsg('Testing…', true);
      el('uf-caldav-msg').style.color = '';
      const d = await _runCalDavTest();
      if (!d.ok) {
        _setCalDavMsg(d.error || 'Connection failed — not saved', false);
        return;
      }
      try {
        const payload = {
          label: el('uf-caldav-label').value.trim(),
          url: el('uf-caldav-url').value.trim(),
          username: el('uf-caldav-user').value.trim(),
          password: el('uf-caldav-pass').value,
        };
        let resp;
        if (isNew) {
          resp = await fetch('/api/calendar/config/accounts', {
            method: 'POST', credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          });
        } else {
          resp = await fetch(`/api/calendar/config/accounts/${editId}`, {
            method: 'PUT', credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          });
        }
        if (!resp.ok) {
          const err = await resp.json().catch(() => ({}));
          _setCalDavMsg(err.detail || 'Save failed', false);
          return;
        }
        _setCalDavMsg('Saved', true);
        formEl.style.display = 'none';
        await renderList();
        notifyIntegrationsChanged();
      } catch (_) {
        _setCalDavMsg('Save failed', false);
      }
    });

    el('uf-caldav-test').addEventListener('click', async () => {
      _setCalDavMsg('Testing…', true);
      el('uf-caldav-msg').style.color = '';
      const d = await _runCalDavTest();
      _setCalDavMsg(d.ok ? 'Connected' : (d.error || 'Failed'), d.ok);
    });
  }

  // ── CardDAV form + contacts manager ──
  async function showCardDavForm() {
    formEl.innerHTML = `
      <div class="admin-card" style="margin-top:8px">
        <h2 style="font-size:13px;display:flex;align-items:center;gap:6px;"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:var(--accent, var(--red));flex-shrink:0;"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>Contacts (CardDAV)</h2>
        <div class="settings-col">
          <div class="settings-row"><label class="settings-label">URL</label><input id="uf-carddav-url" class="settings-input" placeholder="http://localhost:5232/user/contacts/"></div>
          <div class="settings-row"><label class="settings-label">Username</label><input id="uf-carddav-user" class="settings-input"></div>
          <div class="settings-row"><label class="settings-label">Password</label><input id="uf-carddav-pass" class="settings-input" type="password"></div>
          <div class="settings-row" style="margin-top:10px;align-items:center;justify-content:flex-end;gap:6px;">
            <span id="uf-carddav-msg" style="font-size:11px;flex:1;margin-right:8px"></span>
            <button class="admin-btn-add" id="uf-carddav-save" style="display:inline-flex;align-items:center;gap:5px;background:transparent;color:var(--accent, var(--red));border-color:color-mix(in srgb, var(--accent, var(--red)) 45%, var(--border));font-weight:600;">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>
              Save
            </button>
            <button class="admin-btn-add" id="uf-carddav-cancel" style="display:inline-flex;align-items:center;gap:5px;background:transparent;color:var(--accent, var(--red));border-color:color-mix(in srgb, var(--accent, var(--red)) 45%, var(--border));">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              Cancel
            </button>
          </div>
        </div>
      </div>
      <div class="admin-card contacts-manager" style="margin-top:8px">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
          <h2 style="font-size:13px;margin:0;display:flex;align-items:center;gap:6px;"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:var(--accent, var(--red));flex-shrink:0;"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>Contacts Import <span id="cm-count" style="opacity:0.5;font-weight:normal;font-size:11px;"></span></h2>
          <button class="admin-btn-sm" id="cm-import-btn" style="margin-left:auto;">Import</button>
          <button class="admin-btn-sm" id="cm-export-vcf-btn">Export .vcf</button>
          <button class="admin-btn-sm" id="cm-export-csv-btn">Export .csv</button>
          <button class="admin-btn-sm" id="cm-add-toggle">+ Add</button>
          <input type="file" id="cm-import-file" accept=".vcf,.csv,text/vcard,text/csv" multiple style="display:none">
        </div>
        <div id="cm-add-row" class="contacts-add-row" style="display:none;flex-direction:column;gap:4px;">
          <input id="cm-add-name" class="settings-input" placeholder="Name">
          <input id="cm-add-email" class="settings-input" placeholder="email@example.com">
          <input id="cm-add-phone" class="settings-input" placeholder="Phone (optional)">
          <input id="cm-add-address" class="settings-input" placeholder="Address (optional)">
          <div style="display:flex;gap:6px;justify-content:flex-end;"><button class="admin-btn-sm" id="cm-add-save">Save</button></div>
        </div>
        <input type="text" id="cm-search" class="settings-input" placeholder="Search contacts (name, email, phone, address)" style="margin-top:6px;">
        <div id="cm-list" class="contacts-list"><div style="opacity:0.4;font-size:11px;padding:8px 2px;">Loading…</div></div>
      </div>`;
    try {
      const r = await fetch('/api/contacts/config', { credentials: 'same-origin' }); const d = await r.json();
      el('uf-carddav-url').value = d.url || ''; el('uf-carddav-user').value = d.username || '';
      // Server masks the password as '***' when one is saved (or '' when
      // none). Surface that state via the input's placeholder so users
      // can tell their password is already on file without us echoing it.
      const passInput = el('uf-carddav-pass');
      if (passInput && d.password) passInput.placeholder = '(unchanged)';
    } catch (_) {}
    el('uf-carddav-cancel').addEventListener('click', () => { formEl.style.display = 'none'; });
    el('uf-carddav-save').addEventListener('click', async () => {
      const body = { carddav_url: el('uf-carddav-url').value, carddav_username: el('uf-carddav-user').value };
      if (el('uf-carddav-pass').value) body.carddav_password = el('uf-carddav-pass').value;
      try {
        await fetch('/api/contacts/config', { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        el('uf-carddav-msg').textContent = 'Saved';
        el('uf-carddav-msg').style.color = 'var(--green, #50fa7b)';
        // Refresh both the sub-panel (contacts manager) AND the
        // outer integrations list so the CardDAV row appears
        // immediately instead of waiting for a page reload.
        await _renderContactsManager();
        await renderList();
        notifyIntegrationsChanged();
      } catch (_) {
        el('uf-carddav-msg').textContent = 'Failed';
        el('uf-carddav-msg').style.color = 'var(--red)';
      }
    });
    // Add-row toggle + save
    el('cm-add-toggle')?.addEventListener('click', () => {
      const row = el('cm-add-row');
      const open = row.style.display !== 'none';
      row.style.display = open ? 'none' : 'flex';
      if (!open) el('cm-add-name')?.focus();
    });
    el('cm-add-save')?.addEventListener('click', async () => {
      const name = el('cm-add-name').value.trim();
      const email = el('cm-add-email').value.trim();
      const phone = el('cm-add-phone')?.value.trim() || '';
      const address = el('cm-add-address')?.value.trim() || '';
      // Need at least a name or email; address-only entries without a
      // name aren't useful as a contact.
      if (!name && !email) { (name ? el('cm-add-email') : el('cm-add-name')).focus(); return; }
      try {
        await fetch('/api/contacts/add', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, email, phone, address }) });
      } catch (_) {}
      el('cm-add-name').value = '';
      el('cm-add-email').value = '';
      if (el('cm-add-phone')) el('cm-add-phone').value = '';
      if (el('cm-add-address')) el('cm-add-address').value = '';
      el('cm-add-row').style.display = 'none';
      await _renderContactsManager();
    });
    const _downloadContacts = async (format) => {
      const btn = el(format === 'csv' ? 'cm-export-csv-btn' : 'cm-export-vcf-btn');
      const orig = btn ? btn.textContent : '';
      if (btn) { btn.textContent = 'Exporting...'; btn.disabled = true; }
      try {
        const res = await fetch(`/api/contacts/export?format=${encodeURIComponent(format)}`, { credentials: 'same-origin' });
        if (!res.ok) throw new Error('Export failed');
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = format === 'csv' ? 'odysseus-contacts.csv' : 'odysseus-contacts.vcf';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      } catch (_) {
        uiModule.showError ? uiModule.showError('Export failed') : alert('Export failed');
      } finally {
        if (btn) { btn.textContent = orig; btn.disabled = false; }
      }
    };
    el('cm-export-vcf-btn')?.addEventListener('click', () => _downloadContacts('vcf'));
    el('cm-export-csv-btn')?.addEventListener('click', () => _downloadContacts('csv'));

    // Import .vcf/.csv — read each selected file as text, concatenate by type,
    // then POST. Imported CardDAV contacts immediately feed email autocomplete
    // because compose searches /api/contacts/search.
    el('cm-import-btn')?.addEventListener('click', () => el('cm-import-file')?.click());
    el('cm-import-file')?.addEventListener('change', async (e) => {
      const files = Array.from(e.target.files || []);
      if (!files.length) return;
      const btn = el('cm-import-btn');
      const orig = btn ? btn.textContent : '';
      if (btn) { btn.textContent = 'Importing…'; btn.disabled = true; }
      try {
        const texts = await Promise.all(files.map(f => f.text()));
        const vcfParts = [];
        const csvParts = [];
        texts.forEach((text, idx) => {
          const name = (files[idx]?.name || '').toLowerCase();
          if (name.endsWith('.csv') || !String(text || '').toUpperCase().includes('BEGIN:VCARD')) csvParts.push(text);
          else vcfParts.push(text);
        });
        let imported = 0, total = 0, failed = 0;
        const _postImport = async (body) => {
          const r = await fetch('/api/contacts/import', {
            method: 'POST', credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });
          const d = await r.json();
          if (d.error) throw new Error(d.error);
          imported += Number(d.imported || 0);
          total += Number(d.total || 0);
          failed += Number(d.failed || 0);
        };
        if (vcfParts.length) await _postImport({ vcf: vcfParts.join('\n') });
        if (csvParts.length) await _postImport({ csv: csvParts.join('\n') });
        if (!vcfParts.length && !csvParts.length) throw new Error('No contact data found');
        const msg = `Imported ${imported}/${total}` + (failed ? ` (${failed} failed)` : '');
        uiModule.showToast ? uiModule.showToast(msg) : null;
      } catch (err) {
        uiModule.showError ? uiModule.showError(err?.message || 'Import failed') : alert(err?.message || 'Import failed');
      } finally {
        if (btn) { btn.textContent = orig; btn.disabled = false; }
        e.target.value = '';
        await _renderContactsManager();
      }
    });
    await _renderContactsManager();
  }

  // Render the contacts list inside the manager card with inline edit +
  // delete. Each row: name + emails; pencil flips to editable inputs.
  async function _renderContactsManager() {
    const list = el('cm-list');
    if (!list) return;
    let contacts = [];
    try {
      const r = await fetch('/api/contacts/list', { credentials: 'same-origin' });
      const d = await r.json();
      contacts = d.contacts || [];
    } catch (_) {
      list.innerHTML = '<div style="opacity:0.5;font-size:11px;padding:8px 2px;">Failed to load contacts (check CardDAV config above).</div>';
      return;
    }
    const cnt = el('cm-count');
    if (cnt) cnt.textContent = contacts.length ? `(${contacts.length})` : '';
    if (!contacts.length) {
      list.innerHTML = '<div style="opacity:0.4;font-size:11px;padding:8px 2px;">No contacts yet.</div>';
      return;
    }
    // Sort by name for a stable list.
    contacts.sort((a, b) => (a.name || '').localeCompare(b.name || ''));

    // Live filter — search across name/emails/phones/address.
    const searchInput = el('cm-search');
    const q = (searchInput?.value || '').trim().toLowerCase();
    const filtered = !q ? contacts : contacts.filter(c => {
      const hay = [
        c.name || '',
        (c.emails || []).join(' '),
        (c.phones || []).join(' '),
        c.address || '',
      ].join(' ').toLowerCase();
      return hay.includes(q);
    });
    if (cnt) cnt.textContent = contacts.length ? `(${filtered.length}/${contacts.length})` : '';

    if (!filtered.length) {
      list.innerHTML = `<div style="opacity:0.4;font-size:11px;padding:8px 2px;">${q ? 'No matches.' : 'No contacts yet.'}</div>`;
    } else {
      list.innerHTML = filtered.map(c => {
        const emails = (c.emails || []).join(', ');
        const phones = (c.phones || []).join(', ');
        const address = c.address || '';
        const sub = [emails, phones, address].filter(Boolean).join(' · ');
        return `<div class="contact-row" data-uid="${esc(c.uid)}">
          <div class="contact-row-view" style="display:flex;align-items:center;gap:8px;">
            <div style="flex:1;min-width:0;">
              <div class="contact-name" style="font-size:12px;font-weight:600;">${esc(c.name || '(no name)')}</div>
              <div class="contact-sub" style="font-size:10px;opacity:0.55;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(sub)}</div>
            </div>
            <button class="admin-btn-sm contact-edit" title="Edit" style="display:inline-flex;align-items:center;gap:4px;color:var(--accent, var(--red));border-color:color-mix(in srgb, var(--accent, var(--red)) 35%, var(--border));">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
              Edit
            </button>
            <button class="admin-btn-sm contact-del" title="Delete" style="opacity:0.85;display:inline-flex;align-items:center;gap:4px;">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
              Delete
            </button>
          </div>
          <div class="contact-row-edit" style="display:none;flex-direction:column;gap:4px;">
            <input class="settings-input contact-edit-name" value="${esc(c.name || '')}" placeholder="Name">
            <input class="settings-input contact-edit-emails" value="${esc(emails)}" placeholder="email1, email2">
            <input class="settings-input contact-edit-phones" value="${esc(phones)}" placeholder="phone1, phone2">
            <input class="settings-input contact-edit-address" value="${esc(address)}" placeholder="Address">
            <div style="display:flex;gap:6px;"><button class="admin-btn-sm contact-save">Save</button><button class="admin-btn-sm contact-cancel" style="opacity:0.7;">Cancel</button></div>
          </div>
        </div>`;
      }).join('');
    }

    // Wire the search input — debounced so we don't refetch on every key.
    if (searchInput && !searchInput._wired) {
      searchInput._wired = true;
      let _t;
      searchInput.addEventListener('input', () => {
        clearTimeout(_t);
        _t = setTimeout(() => _renderContactsManager(), 80);
      });
    }
    // Stash latest contacts so the search input doesn't have to refetch.
    list._lastContacts = contacts;
    // Wire each row's edit / delete / save / cancel.
    list.querySelectorAll('.contact-row').forEach(row => {
      const uid = row.dataset.uid;
      const view = row.querySelector('.contact-row-view');
      const editForm = row.querySelector('.contact-row-edit');
      row.querySelector('.contact-edit')?.addEventListener('click', () => {
        view.style.display = 'none';
        editForm.style.display = 'flex';
      });
      row.querySelector('.contact-cancel')?.addEventListener('click', () => {
        editForm.style.display = 'none';
        view.style.display = 'flex';
      });
      row.querySelector('.contact-save')?.addEventListener('click', async () => {
        const body = {
          name: row.querySelector('.contact-edit-name').value.trim(),
          emails: row.querySelector('.contact-edit-emails').value.split(',').map(s => s.trim()).filter(Boolean),
          phones: row.querySelector('.contact-edit-phones').value.split(',').map(s => s.trim()).filter(Boolean),
          address: row.querySelector('.contact-edit-address')?.value.trim() || '',
        };
        try {
          await fetch('/api/contacts/' + encodeURIComponent(uid), { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        } catch (_) {}
        await _renderContactsManager();
      });
      row.querySelector('.contact-del')?.addEventListener('click', async () => {
        const ok = uiModule.styledConfirm
          ? await uiModule.styledConfirm('Delete this contact?', { confirmText: 'Delete', danger: true })
          : window.confirm('Delete this contact?');
        if (!ok) return;
        try {
          await fetch('/api/contacts/' + encodeURIComponent(uid), { method: 'DELETE', credentials: 'same-origin' });
        } catch (_) {}
        await _renderContactsManager();
      });
    });
  }

  // ── Email form (multi-account) ──
  // When editId is a real account id, edit that row. When editId is falsy or 'new',
  // create a fresh account. Posts to /api/email/accounts, never to the legacy
  // /api/email/config which would overwrite the default.
  async function showEmailForm(editId) {
    const isEdit = editId && editId !== 'new' && editId !== '__email__';
    let existing = null;
    if (isEdit) {
      try {
        const r = await fetch('/api/email/accounts', { credentials: 'same-origin' });
        const d = await r.json();
        existing = (d.accounts || []).find(a => a.id === editId) || null;
      } catch (_) {}
    }
    const placeholderPass = (isEdit && existing) ? '(leave blank to keep current)' : '';
    // Small `?` indicator next to each label (native title tooltip).
    const _hint = (tip) =>
      `<span class="uf-hint" title="${esc(tip)}" aria-label="${esc(tip)}" tabindex="0" `
      + `style="display:inline-block;width:13px;height:13px;border-radius:50%;`
      + `border:1px solid currentColor;font-size:9px;line-height:11px;text-align:center;`
      + `opacity:0.45;margin-left:5px;cursor:help;vertical-align:1px;font-weight:600;">?</span>`;
    // Provider presets — picking one auto-fills IMAP + SMTP host/port.
    // Dovecot is IMAP-only here; the host is intentionally blank because
    // it may be remote (DNS, LAN, Tailscale), not localhost.
    const PROVIDERS = {
      gmail:    { label: 'Gmail',                   emailEx: 'you@gmail.com',     imap: { host: 'imap.gmail.com',           port: 993, starttls: false }, smtp: { host: 'smtp.gmail.com',     port: 465 } },
      google_workspace: { label: 'Google Workspace / .edu', emailEx: 'you@yourschool.edu', imap: { host: 'imap.gmail.com', port: 993, starttls: false }, smtp: { host: 'smtp.gmail.com', port: 587 }, oauth: 'google' },
      migadu:   { label: 'Migadu',                  emailEx: 'you@yourdomain.com', imap: { host: 'imap.migadu.com',          port: 993, starttls: false }, smtp: { host: 'smtp.migadu.com',    port: 465 } },
      icloud:   { label: 'iCloud',                  emailEx: 'you@icloud.com',    imap: { host: 'imap.mail.me.com',         port: 993, starttls: false }, smtp: { host: 'smtp.mail.me.com',   port: 587 } },
      outlook:  { label: 'Outlook / Office 365',    emailEx: 'you@outlook.com',   imap: { host: 'outlook.office365.com',    port: 993, starttls: false }, smtp: { host: 'smtp.office365.com', port: 587 } },
      fastmail: { label: 'Fastmail',                emailEx: 'you@fastmail.com',  imap: { host: 'imap.fastmail.com',        port: 993, starttls: false }, smtp: { host: 'smtp.fastmail.com',  port: 465 } },
      yahoo:    { label: 'Yahoo',                   emailEx: 'you@yahoo.com',     imap: { host: 'imap.mail.yahoo.com',      port: 993, starttls: false }, smtp: { host: 'smtp.mail.yahoo.com', port: 465 } },
      dovecot:  { label: 'Dovecot IMAP (no SMTP)',  emailEx: 'you@example.com',   imap: { host: '',                         port: 31143, starttls: false }, smtp: { host: '',                   port: 465 } },
    };
    const _providerOptions = Object.entries(PROVIDERS)
      .map(([k, v]) => `<option value="${k}">${esc(v.label)}</option>`).join('');
    // Provider logos — small SVGs the custom dropdown renders next to each
    // option. Letter-in-brand-color circle for known providers; outline
    // envelope for "Custom…". Inline SVG (no external assets, no emoji).
    const _letterLogo = (letter, bg) => `<svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" style="flex-shrink:0"><circle cx="12" cy="12" r="11" fill="${bg}"/><text x="12" y="16.5" font-size="13" font-weight="700" text-anchor="middle" fill="#fff" font-family="system-ui,sans-serif">${letter}</text></svg>`;
    const _customLogo = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="flex-shrink:0;opacity:0.7"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/></svg>';
    const PROV_LOGO = {
      '':       _customLogo,
      gmail:    _letterLogo('G', '#ea4335'),
      google_workspace: _letterLogo('G', '#ea4335'),
      migadu:   _letterLogo('M', '#3aa39d'),
      icloud:   _letterLogo('i', '#3693f3'),
      outlook:  _letterLogo('O', '#0078d4'),
      fastmail: _letterLogo('F', '#4a5fbb'),
      yahoo:    _letterLogo('Y', '#6001d2'),
      dovecot:  _letterLogo('D', '#6b7280'),
    };
    const _provOptionRows = [['', 'Custom…'], ...Object.entries(PROVIDERS).map(([k, v]) => [k, v.label])]
      .map(([k, label]) => `<button type="button" class="ufp-option" data-value="${esc(k)}" style="display:flex;align-items:center;gap:8px;width:100%;padding:8px 10px;background:transparent;border:0;color:var(--fg);font:inherit;cursor:pointer;text-align:left;">${PROV_LOGO[k] || _customLogo}<span>${esc(label)}</span></button>`).join('');
    const _smtpSecurity = (acct) => acct?.smtp_security || ((parseInt(acct?.smtp_port || 465) === 587) ? 'starttls' : 'ssl');
    formEl.innerHTML = `
      <div class="admin-card" style="margin-top:8px">
        <h2 style="font-size:13px">${isEdit ? 'Edit' : 'Add'} Email Account</h2>
        <div class="settings-col">
          <div class="settings-row"><label class="settings-label">Provider${_hint('Pick a known provider to auto-fill the IMAP and SMTP host/port. Choose Custom to type your own.')}</label>
            <div class="ufp-wrap" style="position:relative;flex:1;min-width:0;">
              <select id="uf-email-provider" tabindex="-1" aria-hidden="true" style="position:absolute;width:1px;height:1px;opacity:0;pointer-events:none;"><option value="">Custom…</option>${_providerOptions}</select>
              <button type="button" id="uf-email-provider-trigger" class="settings-select" style="display:flex;align-items:center;gap:8px;cursor:pointer;text-align:left;width:100%;padding-right:24px;position:relative;">
                <span class="ufp-icon" style="display:inline-flex;align-items:center;">${PROV_LOGO['']}</span>
                <span class="ufp-label" style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">Custom…</span>
                <span aria-hidden="true" style="position:absolute;right:8px;top:50%;transform:translateY(-50%);opacity:0.5;font-size:10px;pointer-events:none;">▾</span>
              </button>
              <div id="uf-email-provider-menu" style="display:none;position:absolute;top:calc(100% + 2px);left:0;right:0;z-index:1000;background:var(--panel);border:1px solid var(--border);border-radius:6px;max-height:280px;overflow-y:auto;box-shadow:0 6px 18px rgba(0,0,0,0.25);">${_provOptionRows}</div>
            </div>
          </div>
          <div id="uf-email-provider-note" style="display:none;font-size:11px;line-height:1.5;padding:8px 10px;margin:2px 0 4px;border:1px solid color-mix(in srgb, var(--fg) 15%, transparent);border-left:3px solid var(--accent, var(--red));border-radius:4px;background:color-mix(in srgb, var(--fg) 4%, transparent);"></div>
          <div class="settings-row"><label class="settings-label">Name${_hint('Optional label for this account (e.g. “Work” or “Personal”). Leave blank to use the email address.')}</label><input id="uf-email-name" class="settings-input" placeholder="(optional — leave blank to use email)"></div>
          <div class="settings-row"><label class="settings-label">Email${_hint('Your email address. Used as the From: header on outgoing mail and as the display label when Name is blank.')}</label><input id="uf-email-from" class="settings-input" placeholder="you@example.com"></div>
          <div class="settings-row"><label class="settings-label">Display Name${_hint('Your name as it appears in the From: field of emails you send, e.g. Jane Smith. Auto-filled from Google during OAuth.')}</label><input id="uf-display-name" class="settings-input" placeholder="Your Name"></div>
          <div id="uf-oauth-section" style="display:none;margin:8px 0;padding:10px;border:1px solid var(--border);border-radius:6px;background:color-mix(in srgb,var(--accent,#50fa7b) 6%,transparent)">
            <div style="font-size:11px;font-weight:600;margin-bottom:6px">Google OAuth2 — required for Workspace / .edu accounts</div>
            <p class="integration-help">The deployment may already have a Google OAuth client. Only if Connect with Google cannot start, ask the Odysseus deployment administrator to configure it—users do not need to edit environment files.</p>
            <ol class="integration-help"><li><a href="https://console.cloud.google.com/apis/library/gmail.googleapis.com" target="_blank" rel="noopener noreferrer">Enable the Gmail API</a> in the Google Cloud project.</li><li>Configure the <a href="https://console.cloud.google.com/auth/overview" target="_blank" rel="noopener noreferrer">OAuth consent screen</a>, including audience and any required test users.</li><li>Create a Web application OAuth client in <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noopener noreferrer">Credentials</a>; register the exact redirect URI supplied by this Odysseus deployment. Ask its administrator for that URI—do not guess.</li><li>The administrator configures the client credentials, then you can use Connect with Google and complete consent yourself.</li></ol>
            <div id="uf-oauth-status" style="font-size:11px;opacity:0.7;margin-bottom:6px">${existing && existing.oauth_provider === 'google' ? '✓ Connected via Google OAuth' : 'Not connected — click below to authorize'}</div>
            <button type="button" id="uf-oauth-btn" class="admin-btn-add" style="font-size:11px">${existing && existing.oauth_provider === 'google' ? 'Reconnect with Google' : 'Connect with Google'}</button>
          </div>
          <div style="font-size:11px;font-weight:600;opacity:0.6;margin:4px 0 2px;display:flex;align-items:center;gap:5px;"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:var(--accent, var(--red));flex-shrink:0;" aria-hidden="true"><polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></svg>IMAP (Receiving)</div>
          <div class="settings-row"><label class="settings-label">Host${_hint('Your IMAP server, e.g. imap.gmail.com, imap.migadu.com, a LAN host, or a Tailscale IP for Dovecot.')}</label><input id="uf-imap-host" class="settings-input" placeholder="imap.example.com"></div>
          <div class="settings-row"><label class="settings-label">Port${_hint('993 for IMAPS (most providers), 143 for plain or STARTTLS. Local servers often use a custom port like 31143.')}</label><input id="uf-imap-port" class="settings-input" type="number" placeholder="993" style="max-width:100px"></div>
          <div class="settings-row"><label class="settings-label">Username${_hint('Yes — your full email address goes here too (e.g. you@gmail.com). Same as the Email field above for almost every provider.')}</label><input id="uf-imap-user" class="settings-input" placeholder="you@example.com"></div>
          <div class="uf-password-section"><div class="settings-row"><label class="settings-label">Password${_hint('For Gmail, iCloud, and Yahoo: paste your App Password (NOT your normal account password). For Migadu and Fastmail, your mailbox password usually works. Outlook / Office 365 generally requires OAuth and will not work with this password form.')}</label><input id="uf-imap-pass" class="settings-input" type="password" placeholder="${placeholderPass}"></div></div>
          <div class="settings-row"><label class="settings-label">STARTTLS${_hint('Turn ON for port 143/587 to upgrade plain to TLS. Turn OFF for port 993 (IMAPS — already encrypted) or a local server with no TLS configured.')}</label><label class="admin-switch" style="margin-left:0"><input type="checkbox" id="uf-imap-starttls" checked><span class="admin-slider"></span></label></div>
          <div style="font-size:11px;font-weight:600;opacity:0.6;margin:8px 0 2px;display:flex;align-items:center;gap:5px;"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:var(--accent, var(--red));flex-shrink:0;" aria-hidden="true"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>SMTP (Sending) <span style="font-weight:normal;opacity:0.7">— optional, leave blank for read-only</span></div>
          <div class="settings-row"><label class="settings-label">Host${_hint('Your outgoing-mail server, e.g. smtp.gmail.com. Leave blank to make this account read-only.')}</label><input id="uf-smtp-host" class="settings-input" placeholder="smtp.example.com"></div>
          <div class="settings-row"><label class="settings-label">Port${_hint('465 for SSL/SMTPS, 587 for STARTTLS. 25 is usually blocked by ISPs.')}</label><input id="uf-smtp-port" class="settings-input" type="number" placeholder="465" style="max-width:100px"></div>
          <div class="settings-row"><label class="settings-label">Security${_hint('SSL for port 465, STARTTLS for port 587, or None for local SMTP bridges such as Proton Mail Bridge.')}</label><select id="uf-smtp-security" class="settings-select"><option value="ssl">SSL</option><option value="starttls">STARTTLS</option><option value="none">None</option></select></div>
          <div class="settings-row"><label class="settings-label">Same as IMAP${_hint('Use the IMAP username and password for SMTP too (right for almost every provider). Turn off to enter separate SMTP credentials.')}</label><label class="admin-switch" style="margin-left:0"><input type="checkbox" id="uf-smtp-same" checked><span class="admin-slider"></span></label></div>
          <div class="settings-row uf-smtp-creds"><label class="settings-label">Username${_hint('Usually the same as your IMAP username (your email address).')}</label><input id="uf-smtp-user" class="settings-input"></div>
          <div class="settings-row uf-smtp-creds"><label class="settings-label">Password${_hint('Your SMTP password — often the same as your IMAP password. Outlook / Office 365 generally requires OAuth and will not work with this password form.')}</label><input id="uf-smtp-pass" class="settings-input" type="password" placeholder="${placeholderPass}"></div>
          <div class="settings-row" style="margin-top:4px"><label class="settings-label">Default${_hint('Use this account whenever no specific account is chosen.')}</label><label class="admin-switch" style="margin-left:0"><input type="checkbox" id="uf-email-default"><span class="admin-slider"></span></label><span style="font-size:10px;opacity:0.5;margin-left:6px">Used when nothing else is selected</span></div>
          <div class="settings-row" style="margin-top:10px;align-items:center;justify-content:flex-end;gap:6px;">
            <span id="uf-email-msg" style="font-size:11px;flex:1;margin-right:8px"></span>
            <button class="admin-btn-add" id="uf-email-test" style="display:inline-flex;align-items:center;gap:5px;background:transparent;color:var(--accent, var(--red));border-color:color-mix(in srgb, var(--accent, var(--red)) 45%, var(--border));">
              <span class="uf-email-test-ico" style="display:inline-flex;width:11px;height:11px;align-items:center;justify-content:center;">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="22 4 12 14.01 9 11.01"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>
              </span>
              Test
            </button>
            <button class="admin-btn-add" id="uf-email-save" style="display:inline-flex;align-items:center;gap:5px;background:transparent;color:var(--accent, var(--red));border-color:color-mix(in srgb, var(--accent, var(--red)) 45%, var(--border));font-weight:600;">
              <span class="uf-email-save-ico" style="display:inline-flex;width:11px;height:11px;align-items:center;justify-content:center;">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>
              </span>
              <span class="uf-email-save-label">${isEdit ? 'Save' : 'Create'}</span>
            </button>
            <button class="admin-btn-add" id="uf-email-cancel" style="display:inline-flex;align-items:center;gap:5px;background:transparent;color:var(--accent, var(--red));border-color:color-mix(in srgb, var(--accent, var(--red)) 45%, var(--border));">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              Cancel
            </button>
          </div>
        </div>
      </div>`;

    // Provider-specific helper notes — surfaces for providers that
    // require an app-specific password (Gmail killed basic IMAP auth
    // in 2022; iCloud + Yahoo follow the same model). The Generate
    // button opens the right page in a new tab and copies the URL for
    // mobile / cross-device flows.
    const PROVIDER_NOTES = {
      gmail: {
        title: 'Gmail needs an App Password',
        body: 'Your regular Google password won\'t work for IMAP. Generate a 16-character App Password (requires 2-Step Verification enabled) and paste it as the Password.',
        url: 'https://myaccount.google.com/apppasswords',
      },
      icloud: {
        title: 'iCloud needs an App-Specific Password',
        body: 'Sign in to your Apple ID, go to Sign-In and Security → App-Specific Passwords, and generate one (requires 2FA on your Apple ID).',
        url: 'https://account.apple.com/account/manage',
      },
      yahoo: {
        title: 'Yahoo needs an App Password',
        body: 'Generate an App Password from Yahoo Account Security (requires 2-Step Verification enabled) and paste it as the Password.',
        url: 'https://login.yahoo.com/account/security/app-passwords',
      },
      outlook: {
        title: 'Outlook / Office 365 needs OAuth',
        body: 'Microsoft disables normal password login for IMAP/SMTP in most Outlook and Microsoft 365 accounts. Odysseus does not support Microsoft OAuth/Graph mail yet, so this preset is only a placeholder for future support.',
        url: 'https://learn.microsoft.com/exchange/clients-and-mobile-in-exchange-online/disable-basic-authentication-in-exchange-online',
        linkLabel: 'Read Microsoft note',
      },
    };
    const noteEl = el('uf-email-provider-note');
    const _copyProviderUrl = async (text) => {
      const value = String(text || '');
      if (!value) return false;
      if (navigator.clipboard && window.isSecureContext) {
        try {
          await navigator.clipboard.writeText(value);
          return true;
        } catch (_) {
          // Fall through to the textarea path below.
        }
      }
      const ta = document.createElement('textarea');
      ta.value = value;
      ta.setAttribute('readonly', 'readonly');
      ta.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;z-index:-1;';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      ta.setSelectionRange(0, value.length);
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (_) { ok = false; }
      ta.remove();
      return ok;
    };
    if (noteEl && !noteEl._ufProviderCopyWired) {
      noteEl._ufProviderCopyWired = true;
      noteEl.addEventListener('click', async (e) => {
        const copyBtn = e.target.closest?.('.uf-prov-copy');
        if (!copyBtn || !noteEl.contains(copyBtn)) return;
        e.preventDefault();
        e.stopPropagation();
        const url = copyBtn.dataset.url || '';
        const orig = copyBtn.innerHTML;
        const ok = await _copyProviderUrl(url);
        if (!ok) {
          uiModule.showError?.('Copy failed');
          return;
        }
        uiModule.showToast?.('Copied');
        copyBtn.innerHTML = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> Copied';
        setTimeout(() => {
          if (copyBtn.isConnected) copyBtn.innerHTML = orig;
        }, 1500);
      });
    }
    const _renderProviderNote = (key) => {
      const n = PROVIDER_NOTES[key];
      if (!n) { noteEl.style.display = 'none'; noteEl.innerHTML = ''; return; }
      noteEl.style.display = '';
      noteEl.innerHTML = `
        <div style="font-weight:600;margin-bottom:3px;">${esc(n.title)}</div>
        <div style="opacity:0.8;margin-bottom:6px;">${esc(n.body)}</div>
        <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
          <a href="${esc(n.url)}" target="_blank" rel="noopener noreferrer" class="admin-btn-sm" style="background:var(--red);border-color:var(--red);color:#fff;text-decoration:none;display:inline-flex;align-items:center;gap:5px;font-weight:600;">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
            ${esc(n.linkLabel || 'Generate App Password')}
          </a>
          <button type="button" class="admin-btn-sm uf-prov-copy" data-url="${esc(n.url)}" style="opacity:0.7;display:inline-flex;align-items:center;gap:5px;">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
            Copy link
          </button>
        </div>`;
    };

    // Show/hide the OAuth section and password fields based on provider selection.
    function _syncOauthUI(providerKey) {
      const p = PROVIDERS[providerKey];
      const isOauth = !!(p && p.oauth);
      el('uf-oauth-section').style.display = isOauth ? '' : 'none';
      formEl.querySelectorAll('.uf-password-section').forEach(r => {
        r.style.display = isOauth ? 'none' : '';
      });
    }

    // Custom dropdown wire-up — the native <select> stays in the DOM as the
    // data source and accessibility target, but the visible UI is a button +
    // popup so each provider row can render with its SVG logo. Selecting an
    // option updates select.value and dispatches a `change` event so the
    // existing autofill handler below runs unchanged.
    (() => {
      const trigger = el('uf-email-provider-trigger');
      const menu = el('uf-email-provider-menu');
      const sel = el('uf-email-provider');
      if (!trigger || !menu || !sel) return;
      const labelEl = trigger.querySelector('.ufp-label');
      const iconEl = trigger.querySelector('.ufp-icon');
      const _setFromKey = (k) => {
        const row = menu.querySelector(`.ufp-option[data-value="${k}"]`);
        const lbl = row?.querySelector('span')?.textContent || 'Custom…';
        if (labelEl) labelEl.textContent = lbl;
        if (iconEl) iconEl.innerHTML = PROV_LOGO[k] || _customLogo;
      };
      // Menu is reused (hidden, not recreated). _closeMenu hides it and tears
      // down its outside-click listener + Escape-stack entry; bindMenuDismiss is
      // re-registered fresh on each open (see _openMenu).
      let _closeMenu = () => { menu.style.display = 'none'; };
      const _openMenu = () => {
        menu.style.display = 'block';
        // Drop-up when there's not enough room below the trigger.
        const tRect = trigger.getBoundingClientRect();
        const mRect = menu.getBoundingClientRect();
        const below = window.innerHeight - tRect.bottom;
        const above = tRect.top;
        if (mRect.height > below && above > below) {
          menu.style.top = 'auto'; menu.style.bottom = 'calc(100% + 2px)';
        } else {
          menu.style.top = 'calc(100% + 2px)'; menu.style.bottom = 'auto';
        }
        _closeMenu = bindMenuDismiss(menu, () => { menu.style.display = 'none'; }, (ev) => !menu.contains(ev.target) && ev.target !== trigger);
      };
      trigger.addEventListener('click', (e) => { e.stopPropagation(); menu.style.display === 'block' ? _closeMenu() : _openMenu(); });
      menu.querySelectorAll('.ufp-option').forEach(btn => {
        btn.addEventListener('mouseenter', () => { btn.style.background = 'color-mix(in srgb, var(--fg) 8%, transparent)'; });
        btn.addEventListener('mouseleave', () => { btn.style.background = 'transparent'; });
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const k = btn.dataset.value || '';
          sel.value = k;
          _setFromKey(k);
          _closeMenu();
          sel.dispatchEvent(new Event('change', { bubbles: true }));
        });
      });
      _setFromKey(sel.value || '');
    })();

    // Provider preset → autofill IMAP + SMTP host/port + STARTTLS, set the
    // helper note, and update the Email/Username placeholders to a
    // provider-specific example so users see the right format at a glance.
    el('uf-email-provider').addEventListener('change', (e) => {
      const key = e.target.value;
      _renderProviderNote(key);
      _syncOauthUI(key);
      const p = PROVIDERS[key];
      if (!p) return;
      el('uf-imap-host').value = p.imap.host;
      el('uf-imap-port').value = p.imap.port;
      el('uf-imap-starttls').checked = !!p.imap.starttls;
      el('uf-smtp-host').value = p.smtp.host;
      el('uf-smtp-port').value = p.smtp.port;
      el('uf-smtp-security').value = p.smtp.security || ((parseInt(p.smtp.port || 465) === 587) ? 'starttls' : 'ssl');
      if (p.emailEx) {
        el('uf-email-from').placeholder = p.emailEx;
        el('uf-imap-user').placeholder = p.emailEx;
        el('uf-smtp-user').placeholder = p.emailEx;
      }
    });

    // Init OAuth UI for accounts already connected via OAuth.
    if (existing && existing.oauth_provider === 'google') _syncOauthUI('google_workspace');

    // "Connect with Google" — save the account first, then redirect to OAuth.
    el('uf-oauth-btn').addEventListener('click', async () => {
      const body = _collectBody();
      if (!body.name) body.name = body.from_address;
      if (!body.name) { el('uf-email-msg').textContent = 'Enter a Name or Email first'; el('uf-email-msg').style.color = 'var(--red)'; return; }
      const url = isEdit ? `/api/email/accounts/${editId}` : '/api/email/accounts';
      const method = isEdit ? 'PUT' : 'POST';
      const r = await fetch(url, { method, credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const d = await r.json();
      if (!(d.ok || d.id)) { el('uf-email-msg').textContent = d.error || 'Save failed'; el('uf-email-msg').style.color = 'var(--red)'; return; }
      const accId = isEdit ? editId : d.id;
      window.location.href = `/api/email/oauth/google/authorize?account_id=${encodeURIComponent(accId)}`;
    });

    // "Same as IMAP" toggle — hide the SMTP creds rows when on.
    const _syncSmtpSame = () => {
      const same = el('uf-smtp-same').checked;
      formEl.querySelectorAll('.uf-smtp-creds').forEach(r => {
        r.style.display = same ? 'none' : '';
      });
    };
    el('uf-smtp-same').addEventListener('change', _syncSmtpSame);
    _syncSmtpSame();
    if (existing) {
      el('uf-email-name').value = existing.name || '';
      el('uf-email-from').value = existing.from_address || '';
      el('uf-display-name').value = existing.display_name || '';
      el('uf-imap-host').value = existing.imap_host || '';
      el('uf-imap-port').value = existing.imap_port || 993;
      el('uf-imap-user').value = existing.imap_user || '';
      el('uf-imap-starttls').checked = existing.imap_starttls !== false;
      el('uf-smtp-host').value = existing.smtp_host || '';
      el('uf-smtp-port').value = existing.smtp_port || 465;
      el('uf-smtp-security').value = _smtpSecurity(existing);
      el('uf-smtp-user').value = existing.smtp_user || '';
      el('uf-email-default').checked = !!existing.is_default;
      // If the saved SMTP user matches the IMAP user, keep the "Same as
      // IMAP" toggle ON (and stay hidden). Otherwise turn it off so the
      // separate SMTP credentials are visible for editing.
      const sameCreds = !!(existing.imap_user && existing.smtp_user && existing.imap_user === existing.smtp_user);
      el('uf-smtp-same').checked = sameCreds || !existing.smtp_user;
      _syncSmtpSame();
    } else {
      el('uf-imap-port').value = 993;
      el('uf-smtp-port').value = 465;
      el('uf-smtp-security').value = 'ssl';
    }
    el('uf-email-cancel').addEventListener('click', () => { formEl.style.display = 'none'; });

    // Reset the Test button to neutral when the user edits any field
    // after a test — stale green/red would imply the new values were
    // tested too.
    const _resetTestBtn = () => {
      const btn = el('uf-email-test');
      if (!btn) return;
      btn.style.background = '';
      btn.style.borderColor = '';
      btn.style.color = '';
      btn.style.boxShadow = '';
      btn.style.animation = '';
      const ico = btn.querySelector('.uf-email-test-ico');
      if (ico && btn.dataset.origIco) ico.innerHTML = btn.dataset.origIco;
    };
    formEl.querySelectorAll('input, select').forEach(inp => {
      if (inp.id === 'uf-email-msg') return;
      inp.addEventListener('input', _resetTestBtn);
      inp.addEventListener('change', _resetTestBtn);
    });

    // Collect the current form values + apply the "Same as IMAP" mirror —
    // shared by both Save and Test so they agree on what's being sent.
    const _collectBody = () => {
      const body = {
        name: el('uf-email-name').value.trim(),
        from_address: el('uf-email-from').value.trim(),
        display_name: el('uf-display-name').value.trim(),
        imap_host: el('uf-imap-host').value.trim(),
        imap_port: parseInt(el('uf-imap-port').value) || 993,
        imap_user: el('uf-imap-user').value.trim(),
        imap_starttls: el('uf-imap-starttls').checked,
        smtp_host: el('uf-smtp-host').value.trim(),
        smtp_port: parseInt(el('uf-smtp-port').value) || 465,
        smtp_security: el('uf-smtp-security').value,
        smtp_user: el('uf-smtp-user').value.trim(),
        is_default: el('uf-email-default').checked,
      };
      if (el('uf-imap-pass').value) body.imap_password = el('uf-imap-pass').value;
      if (el('uf-smtp-pass').value) body.smtp_password = el('uf-smtp-pass').value;
      if (el('uf-smtp-same').checked) {
        body.smtp_user = body.imap_user;
        if (body.imap_password) body.smtp_password = body.imap_password;
      }
      return body;
    };

    // Spinner SVG kept inline so we can swap it back to the original
    // checkmark on completion. ~13px to match the button icon size.
    const _spinner = '<span style="display:inline-block;width:11px;height:11px;border-radius:50%;border:1.5px solid currentColor;border-top-color:transparent;animation:whirlpool-spin 0.7s linear infinite"></span>';
    const _checkIcon = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>';

    el('uf-email-test').addEventListener('click', async () => {
      const body = _collectBody();
      // Edit-mode + blank password = use the saved row's stored creds
      // via the account_id shortcut. Other overrides in the body still
      // win (server merges).
      if (isEdit && !body.imap_password) body.account_id = editId;
      const msg = el('uf-email-msg');
      const btn = el('uf-email-test');
      const ico = btn.querySelector('.uf-email-test-ico');
      btn.dataset.origIco = btn.dataset.origIco || ico.innerHTML;
      btn.disabled = true;
      // Clear any prior green/red while testing.
      btn.style.background = '';
      btn.style.borderColor = '';
      btn.style.color = '';
      btn.style.boxShadow = '';
      btn.style.animation = '';
      // Use the canonical whirlpool spinner so this matches Probe / Test
      // elsewhere; fall back to the inline CSS ring if the module fails.
      try {
        const sp = window.spinnerModule || (await import('./spinner.js')).default;
        const wp = sp.createWhirlpool(11);
        wp.element.style.cssText = 'display:inline-flex;width:11px;height:11px;position:relative;top:-2px;';
        ico.innerHTML = '';
        ico.appendChild(wp.element);
      } catch (_) { ico.innerHTML = _spinner; }
      msg.textContent = '';
      msg.style.color = '';
      try {
        const r = await fetch('/api/email/accounts/test', {
          method: 'POST', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const d = await r.json();
        if (d.ok) {
          // Button becomes the indicator — green checkmark with the
          // cookbook-style halo + breathing animation. No status text;
          // the glow is the signal.
          btn.style.background = 'var(--green, #50fa7b)';
          btn.style.borderColor = 'var(--green, #50fa7b)';
          btn.style.color = '#0b0';
          btn.style.boxShadow =
            '0 0 0 2px color-mix(in srgb, var(--green, #50fa7b) 25%, transparent),'
          + ' 0 0 10px 2px color-mix(in srgb, var(--green, #50fa7b) 55%, transparent)';
          btn.style.animation = 'cookbook-srv-glow-ok 2.4s ease-in-out infinite';
          ico.innerHTML = _checkIcon;
        } else {
          // Failure — red glow, original icon, error detail in status
          // text so we can say WHICH half failed (IMAP vs SMTP).
          btn.style.background = 'var(--red)';
          btn.style.borderColor = 'var(--red)';
          btn.style.color = '#fff';
          btn.style.boxShadow =
            '0 0 0 2px color-mix(in srgb, var(--red) 25%, transparent),'
          + ' 0 0 10px 2px color-mix(in srgb, var(--red) 55%, transparent)';
          ico.innerHTML = btn.dataset.origIco;
          const imap = d.imap?.ok ? 'IMAP ok' : `IMAP: ${d.imap?.error || 'fail'}`;
          const smtp = d.smtp ? (d.smtp.ok ? ' · SMTP ok' : ` · SMTP: ${d.smtp.error || 'fail'}`) : '';
          msg.textContent = imap + smtp;
          msg.style.color = 'var(--red)';
        }
      } catch (e) {
        btn.style.background = 'var(--red)';
        btn.style.borderColor = 'var(--red)';
        btn.style.color = '#fff';
        ico.innerHTML = btn.dataset.origIco;
        msg.textContent = 'Test error: ' + e.message;
        msg.style.color = 'var(--red)';
      } finally {
        btn.disabled = false;
      }
    });

    el('uf-email-save').addEventListener('click', async () => {
      const body = _collectBody();
      // Name is optional — fall back to Email so the list still has a label.
      if (!body.name) body.name = body.from_address;
      if (!body.name) { el('uf-email-msg').textContent = 'Need at least a Name or Email'; el('uf-email-msg').style.color = 'var(--red)'; return; }
      const saveBtn = el('uf-email-save');
      saveBtn.disabled = true;
      const saveIcoEl = saveBtn.querySelector('.uf-email-save-ico');
      const saveLblEl = saveBtn.querySelector('.uf-email-save-label');
      const prevIco = saveIcoEl.innerHTML;
      const prevLbl = saveLblEl.textContent;
      saveIcoEl.innerHTML = _spinner;
      saveLblEl.textContent = 'Saving…';
      try {
        const url = isEdit ? `/api/email/accounts/${editId}` : '/api/email/accounts';
        const method = isEdit ? 'PUT' : 'POST';
        const r = await fetch(url, {
          method, credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const d = await r.json();
        if (!(d.ok || d.id)) {
          el('uf-email-msg').textContent = d.error || 'Failed';
          el('uf-email-msg').style.color = 'var(--red)';
          return;
        }
        el('uf-email-msg').textContent = 'Saved';
        el('uf-email-msg').style.color = 'var(--green,#50fa7b)';
        integrationNotice = 'Email account saved. For more settings, go to Settings > Email.';
        formEl.style.display = 'none';
        await renderList();
        notifyIntegrationsChanged();
      } catch (e) {
        el('uf-email-msg').textContent = 'Error: ' + e.message;
        el('uf-email-msg').style.color = 'var(--red)';
      } finally {
        saveBtn.disabled = false;
        saveIcoEl.innerHTML = prevIco;
        saveLblEl.textContent = prevLbl;
      }
    });
  }

  // ── Vaultwarden form ──
  async function showVaultForm() {
    formEl.innerHTML = `
      <div class="admin-card" style="margin-top:8px">
        <h2 style="font-size:13px">Vaultwarden (Password Vault)</h2>
        <div id="uf-vault-status" style="font-size:11px;opacity:0.7;margin-bottom:8px">Loading...</div>
        <div class="settings-col">
          <div class="settings-row"><label class="settings-label">Server URL</label><input id="uf-vault-url" class="settings-input" placeholder="https://vault.example.com"></div>
          <div class="settings-row"><label class="settings-label">Email</label><input id="uf-vault-email" class="settings-input" placeholder="you@example.com"></div>
          <div class="settings-row"><label class="settings-label">Master Password</label><input id="uf-vault-pass" class="settings-input" type="password" placeholder="Only required for Login / Unlock"></div>
          <div class="settings-row" style="margin-top:10px;align-items:center;justify-content:flex-end;gap:6px;flex-wrap:wrap;">
            <span id="uf-vault-msg" style="font-size:11px;flex:1;margin-right:8px"></span>
            <button class="admin-btn-add" id="uf-vault-save" style="background:transparent;color:var(--accent, var(--red));border-color:color-mix(in srgb, var(--accent, var(--red)) 45%, var(--border));font-weight:600;">Save Config</button>
            <button class="admin-btn-add" id="uf-vault-login" style="background:transparent;color:var(--accent, var(--red));border-color:color-mix(in srgb, var(--accent, var(--red)) 45%, var(--border));">Login</button>
            <button class="admin-btn-add" id="uf-vault-unlock" style="background:transparent;color:var(--accent, var(--red));border-color:color-mix(in srgb, var(--accent, var(--red)) 45%, var(--border));">Unlock</button>
            <button class="admin-btn-add" id="uf-vault-lock" style="background:transparent;color:var(--accent, var(--red));border-color:color-mix(in srgb, var(--accent, var(--red)) 45%, var(--border));">Lock</button>
            <button class="admin-btn-add" id="uf-vault-logout" style="background:transparent;color:var(--accent, var(--red));border-color:color-mix(in srgb, var(--accent, var(--red)) 45%, var(--border));">Logout</button>
            <button class="admin-btn-add" id="uf-vault-cancel" style="background:transparent;color:var(--accent, var(--red));border-color:color-mix(in srgb, var(--accent, var(--red)) 45%, var(--border));">Cancel</button>
          </div>
          <div style="font-size:10px;opacity:0.5;margin-top:6px;line-height:1.4">
            <strong>Login</strong> registers this device with your Vaultwarden account (once per account).<br>
            <strong>Unlock</strong> decrypts the vault — required after restart or Lock. Session is saved so the assistant can read passwords.
          </div>
        </div>
      </div>`;

    const msg = (text, color) => {
      const m = el('uf-vault-msg');
      m.textContent = text || '';
      m.style.color = color || '';
    };

    async function refreshStatus() {
      try {
        const r = await fetch('/api/vault/config', { credentials: 'same-origin' });
        const d = await r.json();
        el('uf-vault-url').value = d.server_url || '';
        el('uf-vault-email').value = d.email || '';
        const installed = d.bw_installed;
        const parts = [];
        parts.push(installed ? 'bw CLI: installed' : 'bw CLI: NOT installed (install nodejs-bitwarden-cli)');
        parts.push(d.unlocked ? 'Status: UNLOCKED' : 'Status: locked');
        if (d.unlocked_at) parts.push(`Last unlock: ${d.unlocked_at.replace('T',' ').slice(0,19)}`);
        const statusEl = el('uf-vault-status');
        statusEl.textContent = parts.join(' — ');
        statusEl.style.color = !installed ? 'var(--red)' : d.unlocked ? 'var(--green,#50fa7b)' : '';
      } catch (_) {
        el('uf-vault-status').textContent = 'Failed to load vault status';
      }
    }
    await refreshStatus();

    el('uf-vault-cancel').addEventListener('click', () => { formEl.style.display = 'none'; });

    el('uf-vault-save').addEventListener('click', async () => {
      msg('Saving...');
      try {
        const r = await fetch('/api/vault/config', {
          method: 'POST', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ server_url: el('uf-vault-url').value, email: el('uf-vault-email').value }),
        });
        const d = await r.json();
        if (d.ok) { msg('Saved', 'var(--green,#50fa7b)'); await refreshStatus(); await renderList(); }
        else msg(d.error || 'Failed', 'var(--red)');
      } catch (e) { msg('Error: ' + e.message, 'var(--red)'); }
    });

    el('uf-vault-login').addEventListener('click', async () => {
      const email = el('uf-vault-email').value.trim();
      const pass = el('uf-vault-pass').value;
      if (!email || !pass) { msg('Email + master password required', 'var(--red)'); return; }
      msg('Logging in...');
      try {
        const r = await fetch('/api/vault/login', {
          method: 'POST', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, master_password: pass }),
        });
        const d = await r.json();
        if (d.ok) {
          msg(d.already ? 'Already logged in — use Unlock' : 'Logged in', 'var(--green,#50fa7b)');
          el('uf-vault-pass').value = '';
          await refreshStatus(); await renderList();
        } else msg(d.error || 'Login failed', 'var(--red)');
      } catch (e) { msg('Error: ' + e.message, 'var(--red)'); }
    });

    el('uf-vault-unlock').addEventListener('click', async () => {
      const pass = el('uf-vault-pass').value;
      if (!pass) { msg('Master password required', 'var(--red)'); return; }
      msg('Unlocking...');
      try {
        const r = await fetch('/api/vault/unlock', {
          method: 'POST', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ master_password: pass }),
        });
        const d = await r.json();
        if (d.ok) {
          msg('Vault unlocked', 'var(--green,#50fa7b)');
          el('uf-vault-pass').value = '';
          await refreshStatus(); await renderList();
        } else msg(d.error || 'Unlock failed', 'var(--red)');
      } catch (e) { msg('Error: ' + e.message, 'var(--red)'); }
    });

    el('uf-vault-lock').addEventListener('click', async () => {
      msg('Locking...');
      try {
        await fetch('/api/vault/lock', { method: 'POST', credentials: 'same-origin' });
        msg('Locked', 'var(--green,#50fa7b)');
        await refreshStatus(); await renderList();
      } catch (e) { msg('Error: ' + e.message, 'var(--red)'); }
    });

    el('uf-vault-logout').addEventListener('click', async () => {
      if (!await window.styledConfirm('Log out of Bitwarden CLI? You\'ll need to re-enter your master password to log back in.', { confirmText: 'Log out' })) return;
      msg('Logging out...');
      try {
        await fetch('/api/vault/logout', { method: 'POST', credentials: 'same-origin' });
        msg('Logged out', 'var(--green,#50fa7b)');
        await refreshStatus(); await renderList();
      } catch (e) { msg('Error: ' + e.message, 'var(--red)'); }
    });
  }

  // ── MCP form — full management view ──
  async function showMcpForm(editId) {
    // Toggle an in-flight loading state on a button (disabled + dimmed + label).
    function _setBtnLoading(btn, loading, label) {
      if (!btn) return;
      btn.disabled = loading;
      btn.style.opacity = loading ? '0.6' : '';
      btn.style.cursor = loading ? 'progress' : '';
      if (label != null) btn.textContent = label;
    }
    function _showMcpPasteback(id) {
      const msg = el('uf-mcp-msg'); if (!msg) return;
      if (el('uf-mcp-pasteback')) return;  // already shown
      msg.innerHTML =
        'Authorize in the opened tab. If the redirect fails (remote access), paste the resulting URL here: ' +
        '<input id="uf-mcp-pasteback" class="settings-input" placeholder="http://localhost:7000/api/mcp/oauth/callback?code=..." style="margin-top:4px">' +
        '<button class="admin-btn-sm" id="uf-mcp-paste-go" style="margin-top:4px">Submit</button>';
      const pasteGo = el('uf-mcp-paste-go');
      if (pasteGo) pasteGo.addEventListener('click', async () => {
        const cb = el('uf-mcp-pasteback').value.trim();
        if (!cb) return;
        const pf = new FormData(); pf.append('callback_url', cb);
        _setBtnLoading(pasteGo, true, 'Submitting…');
        try {
          await fetch(`/api/mcp/oauth/exchange/${id}`, { method: 'POST', credentials: 'same-origin', body: pf });
        } finally {
          _setBtnLoading(pasteGo, false, 'Submit');
        }
      });
    }

    // Drives the OAuth flow: waits for the auth_url (discovery+DCR may lag),
    // opens it once, then resolves on connected/error.
    async function _handleMcpAuth(id, initialAuthUrl, tries = 90) {
      let opened = false;
      const openAuth = (u) => { if (!opened && u) { opened = true; window.open(u, '_blank', 'noopener'); _showMcpPasteback(id); } };
      openAuth(initialAuthUrl);
      const msg = el('uf-mcp-msg');
      let fails = 0;
      for (let i = 0; i < tries; i++) {
        await new Promise(res => setTimeout(res, 2000));
        try {
          const r = await fetch('/api/mcp/servers', { credentials: 'same-origin' });
          if (!r.ok) throw new Error('HTTP ' + r.status);
          const list = await r.json();
          fails = 0;
          const s = Array.isArray(list) ? list.find(x => x.id === id) : null;
          if (!s) continue;
          if (s.auth_url) openAuth(s.auth_url);
          if (s.status === 'connected') {
            if (msg) msg.textContent = `Connected (${s.tool_count || 0} tools)`;
            await renderList(); return;
          }
          if (s.status === 'error') {
            if (msg) msg.textContent = `Failed: ${s.error || 'unknown'}`; return;
          }
        } catch (e) {
          // Tolerate a single blip, but surface persistent failures instead of
          // silently polling until timeout.
          if (++fails >= 5 && msg) msg.textContent = `Status check failing (${e.message || 'network error'}) — still retrying…`;
        }
      }
      if (msg) msg.textContent = 'Authorization timed out. Reconnect from the server list to retry.';
    }
    if (editId && editId !== 'new') {
      // Show management view for existing server
      formEl.innerHTML = '<div class="admin-card" style="margin-top:8px"><span style="opacity:0.5;font-size:11px">Loading...</span></div>';
      try {
        const res = await fetch('/api/mcp/servers', { credentials: 'same-origin' });
        const servers = await res.json();
        const srv = servers.find(s => (s.id || s.name) === editId);
        if (!srv) { formEl.innerHTML = '<div class="admin-card" style="margin-top:8px">Server not found</div>'; return; }
        const esc = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;');
        const statusColor = srv.needs_oauth ? '#e5a33a' : srv.status === 'connected' ? 'var(--green,#50fa7b)' : srv.status === 'error' ? 'var(--red)' : 'var(--fg)';
        const toolInfo = srv.status === 'connected' ? `${srv.enabled_tool_count}/${srv.tool_count} tools` : '';
        const statusText = srv.needs_oauth ? 'Needs authorization' : srv.status === 'connected' ? `Connected (${toolInfo})` : srv.status === 'error' ? `Error: ${esc(srv.error || 'unknown')}` : 'Disconnected';
        formEl.innerHTML = `
          <div class="admin-card" style="margin-top:8px">
            <h2 style="font-size:13px">${esc(srv.name)}</h2>
            <div style="display:flex;align-items:center;gap:6px;margin-bottom:8px">
              <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${statusColor}"></span>
              <span style="font-size:11px;opacity:0.7">${statusText}</span>
            </div>
            <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:8px;justify-content:flex-end;">
              <span id="uf-mcp-msg" style="font-size:11px;flex:1;margin-right:8px"></span>
              ${srv.needs_oauth ? `<a href="/api/mcp/oauth/authorize/${srv.id}" target="_blank" class="admin-btn-add" style="background:transparent;color:var(--accent, var(--red));border-color:color-mix(in srgb, var(--accent, var(--red)) 45%, var(--border));text-decoration:none;font-weight:600;">Authorize</a>` : ''}
              <button class="admin-btn-add" id="uf-mcp-reconnect" style="background:transparent;color:var(--accent, var(--red));border-color:color-mix(in srgb, var(--accent, var(--red)) 45%, var(--border));">Reconnect</button>
              <button class="admin-btn-add" id="uf-mcp-toggle" style="background:transparent;color:var(--accent, var(--red));border-color:color-mix(in srgb, var(--accent, var(--red)) 45%, var(--border));">${srv.is_enabled ? 'Disable' : 'Enable'}</button>
              <button class="admin-btn-add" id="uf-mcp-cancel" style="background:transparent;color:var(--accent, var(--red));border-color:color-mix(in srgb, var(--accent, var(--red)) 45%, var(--border));">Close</button>
            </div>
            <div id="uf-mcp-tools-panel"></div>
          </div>`;
        // Reconnect
        el('uf-mcp-reconnect').addEventListener('click', async () => {
          const msg = el('uf-mcp-msg'); msg.textContent = 'Reconnecting...';
          try {
            const r = await fetch(`/api/mcp/servers/${srv.id}/reconnect`, { method: 'POST', credentials: 'same-origin' });
            const d = await r.json();
            msg.textContent = d.connected ? `Connected (${d.tool_count} tools)` : `Failed: ${d.error || 'unknown'}`;
            await renderList();
            showMcpForm(editId); // refresh this view
          } catch (e) { msg.textContent = 'Failed'; }
        });
        // Toggle enable/disable
        el('uf-mcp-toggle').addEventListener('click', async () => {
          const fd = new FormData(); fd.append('is_enabled', String(!srv.is_enabled));
          await fetch(`/api/mcp/servers/${srv.id}`, { method: 'PATCH', body: fd, credentials: 'same-origin' });
          await renderList();
          showMcpForm(editId);
        });
        el('uf-mcp-cancel').addEventListener('click', () => { formEl.style.display = 'none'; });
        // Load tools list
        if (srv.status === 'connected' && srv.tool_count > 0) {
          const panel = el('uf-mcp-tools-panel');
          try {
            const tr = await fetch(`/api/mcp/servers/${srv.id}/tools`, { credentials: 'same-origin' });
            const tools = await tr.json();
            if (tools.length) {
              const disabled = new Set(tools.filter(t => t.is_disabled).map(t => t.name));
              panel.innerHTML = `<div class="mcp-tools-header"><span>Tools</span><span style="display:flex;gap:8px;align-items:center"><span class="mcp-tools-count">${tools.length - disabled.size}/${tools.length} enabled</span><a href="#" id="uf-mcp-all">All</a> <a href="#" id="uf-mcp-none">None</a></span></div><div class="mcp-tools-list">${tools.map(t => `<label title="${esc(t.description)}"><input type="checkbox" data-mcp-tool-name="${esc(t.name)}" ${!t.is_disabled ? 'checked' : ''}><span><strong>${esc(t.name)}</strong> <span style="opacity:0.5">— ${esc((t.description||'').slice(0,80))}</span></span></label>`).join('')}</div>`;
              const saveFn = async () => {
                const dis = [];
                panel.querySelectorAll('input[type=checkbox]').forEach(cb => { if (!cb.checked) dis.push(cb.dataset.mcpToolName); });
                await fetch(`/api/mcp/servers/${srv.id}/tools`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ disabled: dis }) });
                const cnt = panel.querySelector('.mcp-tools-count');
                if (cnt) cnt.textContent = `${tools.length - dis.length}/${tools.length} enabled`;
              };
              panel.querySelectorAll('input[type=checkbox]').forEach(cb => cb.addEventListener('change', saveFn));
              el('uf-mcp-all')?.addEventListener('click', (e) => { e.preventDefault(); panel.querySelectorAll('input[type=checkbox]').forEach(cb => cb.checked = true); saveFn(); });
              el('uf-mcp-none')?.addEventListener('click', (e) => { e.preventDefault(); panel.querySelectorAll('input[type=checkbox]').forEach(cb => cb.checked = false); saveFn(); });
            }
          } catch (_) { panel.innerHTML = '<span style="opacity:0.5;font-size:11px">Failed to load tools</span>'; }
        }
      } catch (_) { formEl.innerHTML = '<div class="admin-card" style="margin-top:8px">Failed to load server</div>'; }
    } else {
      // Add new MCP server form
      formEl.innerHTML = `
        <div class="admin-card" style="margin-top:8px">
          <h2 style="font-size:13px">Add MCP Server</h2>
          <div class="settings-col">
            <div class="settings-row"><label class="settings-label">Name</label><input id="uf-mcp-name" class="settings-input" placeholder="Server name"></div>
            <div class="settings-row"><label class="settings-label">Transport</label><select id="uf-mcp-transport" class="settings-input"><option value="stdio">stdio</option><option value="sse">SSE</option><option value="http">Streamable HTTP</option></select></div>
            <div id="uf-mcp-stdio-fields" style="display:flex;flex-direction:column;gap:6px;">
              <div class="settings-row"><label class="settings-label">Command</label><input id="uf-mcp-cmd" class="settings-input" placeholder="npx"></div>
              <div class="settings-row"><label class="settings-label">Args</label><input id="uf-mcp-args" class="settings-input" placeholder='["-y", "@modelcontextprotocol/server-filesystem"]'></div>
              <div class="settings-row"><label class="settings-label">Env</label><input id="uf-mcp-env" class="settings-input" placeholder='{"KEY": "value"}'></div>
            </div>
            <div id="uf-mcp-sse-fields" style="display:none;flex-direction:column;gap:6px;">
              <div class="settings-row"><label class="settings-label">URL</label><input id="uf-mcp-url" class="settings-input" placeholder="http://localhost:3001/sse"></div>
            </div>
            <div class="settings-row" style="margin-top:10px;align-items:center;justify-content:flex-end;gap:6px;">
              <span id="uf-mcp-msg" style="font-size:11px;flex:1;margin-right:8px"></span>
              <button class="admin-btn-add" id="uf-mcp-save" style="background:transparent;color:var(--accent, var(--red));border-color:color-mix(in srgb, var(--accent, var(--red)) 45%, var(--border));font-weight:600;">Save</button>
              <button class="admin-btn-add" id="uf-mcp-cancel" style="background:transparent;color:var(--accent, var(--red));border-color:color-mix(in srgb, var(--accent, var(--red)) 45%, var(--border));">Cancel</button>
            </div>
          </div>
        </div>`;
      el('uf-mcp-transport').addEventListener('change', () => {
        const v = el('uf-mcp-transport').value;
        const isUrl = (v === 'sse' || v === 'http');
        el('uf-mcp-stdio-fields').style.display = isUrl ? 'none' : 'flex';
        el('uf-mcp-sse-fields').style.display = isUrl ? 'flex' : 'none';
        const urlInput = el('uf-mcp-url');
        if (urlInput) urlInput.placeholder = (v === 'http') ? 'https://mcp.example.com/mcp' : 'http://localhost:3001/sse';
      });
      el('uf-mcp-cancel').addEventListener('click', () => { formEl.style.display = 'none'; });
      el('uf-mcp-save').addEventListener('click', async () => {
        const transport = el('uf-mcp-transport').value;
        // routes/mcp_routes.py uses FastAPI Form(...) — send multipart, not JSON.
        const fd = new FormData();
        fd.append('name', el('uf-mcp-name').value);
        fd.append('transport', transport);
        if (transport === 'stdio') {
          fd.append('command', el('uf-mcp-cmd').value);
          // Unlike env below, an unparseable args value is not silently
          // defaulted: it would spawn the subprocess with an empty argv.
          let args;
          try { args = JSON.stringify(JSON.parse(el('uf-mcp-args').value || '[]')); }
          catch (_) { el('uf-mcp-msg').textContent = 'Args must be valid JSON, e.g. ["-y", "pkg"]'; return; }
          let env  = '{}'; try { env  = JSON.stringify(JSON.parse(el('uf-mcp-env').value  || '{}')); } catch (_) {}
          fd.append('args', args);
          fd.append('env', env);
        } else {
          fd.append('url', el('uf-mcp-url').value);
        }
        const saveBtn = el('uf-mcp-save'), cancelBtn = el('uf-mcp-cancel');
        const _origLabel = saveBtn.textContent;
        _setBtnLoading(saveBtn, true, 'Saving…'); if (cancelBtn) cancelBtn.disabled = true;
        try {
          const r = await fetch('/api/mcp/servers', { method: 'POST', credentials: 'same-origin', body: fd });
          const data = await r.json().catch(() => ({}));
          if (r.ok && data.needs_auth) {
            el('uf-mcp-msg').textContent = 'Preparing authorization…';
            _handleMcpAuth(data.id, data.auth_url);
          } else if (r.ok && (data.connected || data.status === 'connected')) {
            el('uf-mcp-msg').textContent = `Connected (${data.tool_count || 0} tools)`;
            formEl.style.display = 'none'; await renderList();
          } else if (r.ok) {
            el('uf-mcp-msg').textContent = 'Saved'; formEl.style.display = 'none'; await renderList();
          } else {
            // Surface the server's reason. The Args validation above rejects
            // unparseable JSON, but `"x"` and `{}` parse and are refused by
            // routes/mcp/mcp_routes.py with a message naming the expected
            // shape; a bare status code sends the user looking in the wrong
            // place. Matches what admin.js shows for the same endpoint.
            el('uf-mcp-msg').textContent = data.detail || `Failed (${r.status})`;
          }
        } catch (_) { el('uf-mcp-msg').textContent = 'Failed'; }
        finally { _setBtnLoading(saveBtn, false, _origLabel); if (cancelBtn) cancelBtn.disabled = false; }
      });
    }
  }

  async function showAgentForm(kind, editId) {
    const cfg = AGENT_CONFIGS[kind] || AGENT_CONFIGS.codex;
    let tokens = [];
    try {
      const tokRes = await fetch('/api/tokens', { credentials: 'same-origin' });
      if (tokRes.ok) tokens = await tokRes.json();
    } catch (_) {}

    const toolScopes = [
      { key: 'todos:read', label: 'Todos', detail: 'Read notes and checklists' },
      { key: 'todos:write', label: 'Todos write', detail: 'Create, update, delete, and toggle todo items' },
      { key: 'documents:read', label: 'Documents', detail: 'Read documents when a document API is enabled' },
      { key: 'documents:write', label: 'Documents write', detail: 'Create and update draft documents' },
      { key: 'email:read', label: 'Email', detail: 'Read email when an email API is enabled' },
      { key: 'email:draft', label: 'Email drafts', detail: 'Create email reply drafts without sending' },
      { key: 'email:send', label: 'Email send', detail: 'Send email directly' },
      { key: 'calendar:read', label: 'Calendar', detail: 'Read calendar events when enabled' },
      { key: 'calendar:write', label: 'Calendar write', detail: 'Create and update calendar events' },
      { key: 'memory:read', label: 'Memory', detail: 'Read memory when enabled' },
      { key: 'memory:write', label: 'Memory write', detail: 'Write memory when enabled' },
      { key: 'cookbook:read', label: 'Cookbook', detail: 'List cookbook tasks + tail their tmux output (debug a model serve from outside the UI)' },
      { key: 'cookbook:launch', label: 'Cookbook launch', detail: 'Launch and stop cookbook serve tasks. Powerful: runs SSH commands on your configured servers, bounded by the same allowlist the UI uses (vllm/python3/sglang/llama-server/...)' },
    ];
    // Strict name-prefix match keeps Codex and Claude tokens in their own forms.
    const agentTokens = (Array.isArray(tokens) ? tokens : []).filter(tok =>
      (tok.name || '').toLowerCase().startsWith(cfg.namePrefix)
    );
    const current = agentTokens.find(t => String(t.id) === String(editId));
    const _scopeIcons = {
      todos: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="2"/><line x1="8" y1="9" x2="16" y2="9"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="13" y2="17"/></svg>',
      documents: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>',
      email: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><polyline points="2 6 12 13 22 6"/></svg>',
      calendar: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>',
      memory: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 2a2.5 2.5 0 0 0-2.5 2.5 2.5 2.5 0 0 0-2.5 2.5A2.5 2.5 0 0 0 2 9.5v3A2.5 2.5 0 0 0 4.5 15a2.5 2.5 0 0 0 2.5 2.5A2.5 2.5 0 0 0 9.5 20H10V2z"/><path d="M14.5 2a2.5 2.5 0 0 1 2.5 2.5 2.5 2.5 0 0 1 2.5 2.5A2.5 2.5 0 0 1 22 9.5v3A2.5 2.5 0 0 1 19.5 15a2.5 2.5 0 0 1-2.5 2.5A2.5 2.5 0 0 1 14.5 20H14V2z"/></svg>',
      cookbook: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>',
    };
    const _scopeNiceLabel = (label) => label.replace(/\s+(write|drafts?|send)$/i, '');
    const _scopeAction = (key) => (key.split(':')[1] || '').toLowerCase();
    const _pillStyle = (action) => {
      if (action === 'read') return 'background:rgba(150,150,150,0.18);color:var(--fg-muted,#888);';
      return 'background:color-mix(in srgb, var(--accent, var(--red)) 18%, transparent);color:var(--accent, var(--red));';
    };
    const scopeToggles = (t) => {
      const scopes = new Set(t.scopes || []);
      return toolScopes.map(scope => {
        const tool = scope.key.split(':')[0];
        const action = _scopeAction(scope.key);
        const icon = _scopeIcons[tool] || '';
        const niceLabel = _scopeNiceLabel(scope.label);
        return `
        <label class="settings-row" style="align-items:center;gap:8px;display:flex;min-height:30px;padding:2px 0;">
          <span style="opacity:0.7;display:inline-flex;align-items:center;justify-content:center;width:16px;flex-shrink:0;">${icon}</span>
          <span class="settings-label" style="width:75px;flex-shrink:0;padding:0;">${esc(niceLabel)}</span>
          <span style="font-size:9px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;padding:1px 7px;border-radius:999px;flex-shrink:0;min-width:44px;text-align:center;margin-left:-3px;box-sizing:border-box;${_pillStyle(action)}">${esc(action)}</span>
          <span style="font-size:11px;line-height:1.35;opacity:0.62;flex:1;min-width:0;">${esc(scope.detail)}</span>
          <label class="admin-switch" style="margin-left:auto;flex-shrink:0;"><input type="checkbox" class="uf-codex-scope" data-token-id="${esc(t.id)}" data-scope="${esc(scope.key)}" ${scopes.has(scope.key) ? 'checked' : ''}><span class="admin-slider"></span></label>
        </label>`;
      }).join('');
    };
    const origin = window.location.origin || '';
    const setupForToken = (token) => cfg.buildSetup(origin, token);

    // Inline editor for the existing token the user clicked into (current).
    // Shows the rename input, the prefix/last-used, and scope toggles that
    // PATCH /api/tokens/{id} on change. The integration row's trash button
    // handles revoke, so no Revoke button in here.
    const editExistingHtml = current ? `
      <div style="border:1px solid var(--border);border-radius:6px;padding:9px 10px;margin-bottom:8px;">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
          <input type="text" id="uf-codex-existing-rename" data-token-id="${esc(current.id)}" value="${esc(current.name || cfg.defaultName)}" style="font-size:12px;font-weight:600;padding:3px 6px;flex:1;background:transparent;border:1px solid transparent;border-radius:4px;" title="Click to rename">
          <span style="font-size:10px;opacity:0.55;">${esc(current.token_prefix || 'token')}...${current.last_used_at ? ` · Last used ${new Date(current.last_used_at).toLocaleDateString()}` : ' · Never used'}</span>
        </div>
        <div style="font-size:11px;font-weight:600;opacity:0.62;margin-bottom:4px;">Permissions</div>
        ${scopeToggles(current)}
        <div id="uf-codex-existing-msg" style="font-size:11px;min-height:14px;margin-top:4px;"></div>
      </div>` : '';

    formEl.innerHTML = `
      <div class="admin-card" style="margin-top:8px">
        <div class="settings-col">
          ${editExistingHtml}
          <div id="uf-codex-prompt" style="display:${current ? 'none' : 'block'};padding:6px 0;">
            <div style="font-size:11px;opacity:0.7;margin-bottom:6px;">Name this ${esc(cfg.word)} agent so you can tell it apart from other ones (e.g. "${esc(cfg.defaultName)} — laptop").</div>
            <input type="text" id="uf-codex-name-input" class="settings-select" placeholder="${esc(cfg.defaultName)}" style="width:100%;font-size:12px;padding:6px 8px;">
          </div>
          <div id="uf-codex-pending" style="display:none;align-items:center;gap:8px;padding:6px 0;font-size:11px;opacity:0.7;"></div>
          <div id="uf-codex-reveal" style="display:none;width:100%;box-sizing:border-box;">
            <div style="font-weight:600;font-size:12px;margin-bottom:6px;">Token</div>

            <div style="font-size:11px;opacity:0.62;margin-bottom:4px;">Copy this token, it won't be shown again.</div>
            <div style="position:relative;">
              <code id="uf-codex-token" style="display:block;word-break:break-all;font-size:11px;padding:6px 30px 6px 8px;background:rgba(0,0,0,0.08);border-radius:4px;"></code>
              <button type="button" class="admin-btn-sm" id="uf-codex-copy-token" title="Copy token" aria-label="Copy token" style="position:absolute;right:4px;top:50%;transform:translateY(-50%);padding:3px 5px;background:none;border:none;color:inherit;opacity:0.7;cursor:pointer;display:inline-flex;align-items:center;">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
              </button>
            </div>

            <div style="margin-top:14px;font-weight:600;font-size:11px;margin-bottom:4px;">Quickstart &mdash; simply paste directly in your terminal.</div>
            <div style="font-size:11px;opacity:0.62;margin-bottom:6px;">${cfg.setupDescription}</div>
            <pre style="margin:0;white-space:pre;overflow-x:auto;max-height:220px;overflow-y:auto;font-size:10px;line-height:1.45;padding:8px 10px;background:rgba(0,0,0,0.08);border-radius:4px;width:100%;box-sizing:border-box;"><code id="uf-codex-setup-code"></code></pre>

            <div style="margin-top:14px;display:flex;align-items:center;gap:8px;">
              <span style="font-weight:600;font-size:11px;">Configure access</span>
              <span style="flex:1"></span>
              <button type="button" class="admin-btn-sm" id="uf-codex-copy-setup" title="Copy setup" aria-label="Copy setup" style="font-size:11px;font-weight:normal;display:inline-flex;align-items:center;gap:5px;opacity:0.85;">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                <span>Copy</span>
              </button>
              <button type="button" class="admin-btn-sm" id="uf-codex-toggle-config" aria-expanded="false" style="font-size:11px;font-weight:normal;display:inline-flex;align-items:center;gap:5px;opacity:0.85;">
                <svg id="uf-codex-toggle-config-caret" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="transition:transform 0.15s"><polyline points="6 9 12 15 18 9"/></svg>
                <span>Configure</span>
              </button>
            </div>
            <div id="uf-codex-config-body" style="display:none;">
              <div style="font-size:11px;opacity:0.62;margin:4px 0 6px;">Toggle which Odysseus tools this agent can use. New agents start with chat only.</div>
              <div id="uf-codex-inline-scopes"></div>
            </div>
          </div>
          <div class="settings-row" style="margin-top:10px;align-items:center;gap:6px;">
            <button class="admin-btn-add" id="uf-codex-cancel" style="display:inline-flex;align-items:center;gap:5px;background:transparent;color:var(--accent, var(--red));border-color:color-mix(in srgb, var(--accent, var(--red)) 45%, var(--border));">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              Cancel
            </button>
            <span id="uf-codex-msg" style="font-size:11px;flex:1;text-align:center;"></span>
            <button class="admin-btn-add" id="uf-codex-revoke" style="display:none;align-items:center;gap:5px;background:color-mix(in srgb, var(--color-error) 10%, transparent);color:var(--color-error);border:1px solid var(--color-error);font-weight:600;">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
              Revoke
            </button>
            <button class="admin-btn-add" id="uf-codex-create-btn" style="display:${current ? 'none' : 'inline-flex'};align-items:center;gap:5px;background:transparent;color:var(--accent, var(--red));border-color:color-mix(in srgb, var(--accent, var(--red)) 45%, var(--border));">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 2l-9.6 9.6"/><circle cx="7.5" cy="15.5" r="5.5"/><path d="M15.5 7.5l3 3"/></svg>
              Create token
            </button>
            <button class="admin-btn-add" id="uf-codex-save" style="display:none;align-items:center;gap:5px;background:transparent;color:var(--accent, var(--red));border-color:color-mix(in srgb, var(--accent, var(--red)) 45%, var(--border));font-weight:600;">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>
              Save
            </button>
          </div>
        </div>
      </div>`;

    // Editing an existing token: surface Revoke alongside Cancel, and stash
    // the id so the Revoke handler knows what to DELETE.
    if (current) {
      formEl.dataset.createdTokenId = String(current.id);
      const revokeBtn = el('uf-codex-revoke');
      if (revokeBtn) revokeBtn.style.display = 'inline-flex';
      // Inline rename + per-scope PATCH on change.
      const renameInput = el('uf-codex-existing-rename');
      if (renameInput) {
        const original = renameInput.value;
        const commit = async () => {
          const name = (renameInput.value || '').trim();
          if (!name || name === original) return;
          try {
            const r = await fetch(`/api/tokens/${renameInput.dataset.tokenId}`, {
              method: 'PATCH', credentials: 'same-origin',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ name }),
            });
            if (!r.ok) throw new Error('Save failed');
            notifyIntegrationsChanged();
          } catch (_) { renameInput.value = original; }
        };
        renameInput.addEventListener('blur', commit);
        renameInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); renameInput.blur(); } });
      }
      formEl.querySelectorAll('.uf-codex-scope').forEach(cb => {
        cb.addEventListener('change', async () => {
          const msg = el('uf-codex-existing-msg');
          const scopes = ['chat'].concat(
            Array.from(formEl.querySelectorAll('.uf-codex-scope:checked')).map(input => input.dataset.scope)
          );
          try {
            const r = await fetch(`/api/tokens/${cb.dataset.tokenId}`, {
              method: 'PATCH', credentials: 'same-origin',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ scopes }),
            });
            const d = await r.json().catch(() => ({}));
            if (!r.ok) throw new Error(d.detail || 'Failed');
            if (msg) { msg.textContent = 'Saved'; msg.style.color = 'var(--green, #50fa7b)'; setTimeout(() => { msg.textContent = ''; }, 1200); }
            notifyIntegrationsChanged();
          } catch (err) {
            cb.checked = !cb.checked;
            if (msg) { msg.textContent = (err && err.message) || 'Failed'; msg.style.color = 'var(--red)'; }
          }
        });
      });
    }

    el('uf-codex-cancel')?.addEventListener('click', () => { formEl.style.display = 'none'; });

    // Configure access — collapsed by default so the reveal panel doesn't
    // dump 13 toggles at once. Click reveals + rotates the caret.
    el('uf-codex-toggle-config')?.addEventListener('click', () => {
      const body = el('uf-codex-config-body');
      const btn = el('uf-codex-toggle-config');
      const caret = el('uf-codex-toggle-config-caret');
      if (!body || !btn) return;
      const open = body.style.display === 'none';
      body.style.display = open ? '' : 'none';
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (caret) caret.style.transform = open ? 'rotate(180deg)' : '';
    });

    el('uf-codex-save')?.addEventListener('click', async () => {
      const msg = el('uf-codex-msg');
      const tokenId = formEl.dataset.createdTokenId;
      if (!tokenId) { formEl.style.display = 'none'; return; }
      const scopes = ['chat'].concat(
        Array.from(formEl.querySelectorAll('#uf-codex-inline-scopes .uf-codex-scope:checked'))
          .map(input => input.dataset.scope)
      );
      try {
        const r = await fetch(`/api/tokens/${tokenId}`, {
          method: 'PATCH', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ scopes }),
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.detail || 'Failed');
        if (msg) { msg.textContent = 'Saved'; msg.style.color = 'var(--green, #50fa7b)'; }
        await renderList();
        setTimeout(() => { formEl.style.display = 'none'; }, 350);
      } catch (err) {
        if (msg) { msg.textContent = err?.message || 'Save failed'; msg.style.color = 'var(--red)'; }
      }
    });

    // Revoke = delete this agent token entirely. Confirmation prompt keeps
    // it from being a one-click footgun. Closes the form on success.
    el('uf-codex-revoke')?.addEventListener('click', async () => {
      const tokenId = formEl.dataset.createdTokenId;
      if (!tokenId) return;
      const ok = window.styledConfirm
        ? await window.styledConfirm(`Revoke this ${cfg.word} agent token? Integrations using it will lose access.`, { confirmText: 'Revoke', danger: true })
        : confirm(`Revoke this ${cfg.word} agent token? Integrations using it will lose access.`);
      if (!ok) return;
      const msg = el('uf-codex-msg');
      try {
        const r = await fetch(`/api/tokens/${tokenId}`, { method: 'DELETE', credentials: 'same-origin' });
        if (!r.ok) throw new Error('Revoke failed');
        if (msg) { msg.textContent = 'Revoked'; msg.style.color = 'var(--color-error)'; }
        await renderList();
        setTimeout(() => { formEl.style.display = 'none'; }, 350);
      } catch (err) {
        if (msg) { msg.textContent = err?.message || 'Revoke failed'; msg.style.color = 'var(--red)'; }
      }
    });

    const _autoCreateCodex = async () => {
      const msg = el('uf-codex-msg');
      const prompt = el('uf-codex-prompt');
      const pending = el('uf-codex-pending');
      const createBtn = el('uf-codex-create-btn');
      if (prompt) prompt.style.display = 'none';
      if (createBtn) createBtn.style.display = 'none';
      // Whirlpool spinner while the POST is in flight.
      let _wp = null;
      if (pending) {
        pending.innerHTML = '';
        pending.style.display = 'flex';
        try {
          const sp = window.spinnerModule || (await import('./spinner.js')).default;
          _wp = sp.createWhirlpool(14);
          _wp.element.style.cssText = 'display:inline-flex;width:14px;height:14px;margin:0 4px 0 0;';
          pending.appendChild(_wp.element);
          pending.appendChild(document.createTextNode('Creating token…'));
        } catch (_) {
          pending.textContent = 'Creating token…';
        }
      }
      const existingNames = new Set(agentTokens.map(t => (t.name || '').trim()));
      const nameInput = el('uf-codex-name-input');
      // User-typed name wins. Empty / whitespace falls back to the default,
      // auto-suffixed with " 2", " 3"… so two tokens never collide.
      let name = (nameInput && nameInput.value || '').trim() || cfg.defaultName;
      if (existingNames.has(name)) {
        let n = 2;
        const base = name;
        while (existingNames.has(name)) { name = `${base} ${n++}`; }
      }
      // Minimum scope on creation so the token isn't effectively saved
      // with everything granted before the user has clicked Save. The
      // UI toggles below are pre-checked as a preview of what *will*
      // be granted; nothing else is persisted server-side until Save.
      const fd = new FormData();
      fd.append('name', name);
      fd.append('scopes', 'chat');
      try {
        const r = await fetch('/api/tokens', { method: 'POST', credentials: 'same-origin', body: fd });
        const d = await r.json();
        if (!r.ok) throw new Error(d.detail || 'Failed');
        if (_wp) { try { _wp.destroy(); } catch (_) {} }
        if (pending) pending.style.display = 'none';
        el('uf-codex-token').textContent = d.token || '';
        el('uf-codex-reveal').style.display = '';
        const setupBtn = el('uf-codex-copy-setup');
        if (setupBtn) setupBtn.dataset.token = d.token || '';
        const setupCode = el('uf-codex-setup-code');
        if (setupCode) setupCode.textContent = setupForToken(d.token || '');
        // Populate inline scope toggles for the just-created token with
        // ALL scopes pre-checked as a UI preview — the underlying token
        // still only has 'chat' until the user clicks Save below.
        const uiToken = { id: d.id, scopes: ['chat'].concat(toolScopes.map(s => s.key)) };
        const inlineEl = el('uf-codex-inline-scopes');
        if (inlineEl) {
          inlineEl.innerHTML = `
            <div class="uf-codex-token" data-token-id="${esc(uiToken.id)}">
              ${scopeToggles(uiToken)}
              <div class="uf-codex-scope-msg" data-token-id="${esc(uiToken.id)}" style="font-size:11px;min-height:14px;"></div>
            </div>`;
          // No auto-PATCH: scope toggles only persist on Save click below.
        }
        // Now that the token exists, surface the Save button.
        const saveBtn = el('uf-codex-save');
        if (saveBtn) saveBtn.style.display = 'inline-flex';
        // Remember the created token id so Save can PATCH its scopes.
        formEl.dataset.createdTokenId = String(uiToken.id);
        if (msg) {
          msg.textContent = `Created "${name}".`;
          msg.style.color = 'var(--green, #50fa7b)';
        }
        await renderList();
      } catch (err) {
        if (_wp) { try { _wp.destroy(); } catch (_) {} }
        if (pending) pending.style.display = 'none';
        if (msg) {
          msg.textContent = err?.message || 'Failed';
          msg.style.color = 'var(--red)';
        }
      }
    };
    // Bind the explicit Create button; no auto-creation.
    el('uf-codex-create-btn')?.addEventListener('click', () => { _autoCreateCodex(); });
    const _copyCodexToken = async (text) => {
      const value = String(text || '');
      if (!value) return false;
      if (navigator.clipboard && window.isSecureContext) {
        try {
          await navigator.clipboard.writeText(value);
          return true;
        } catch (_) {}
      }
      const ta = document.createElement('textarea');
      ta.value = value;
      ta.setAttribute('readonly', 'readonly');
      ta.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;z-index:-1;';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      ta.setSelectionRange(0, value.length);
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (_) { ok = false; }
      ta.remove();
      return ok;
    };
    const _selectTextFallback = (text, containerId) => {
      const code = document.createElement('pre');
      code.textContent = text;
      code.style.cssText = 'white-space:pre-wrap;word-break:break-word;font-size:10px;margin:6px 0 0;';
      el(containerId)?.appendChild(code);
      const range = document.createRange();
      range.selectNodeContents(code);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    };
    const COPY_ICON = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
    const CHECK_ICON = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
    el('uf-codex-copy-setup')?.addEventListener('click', async () => {
      const token = el('uf-codex-copy-setup')?.dataset.token || '';
      const btn = el('uf-codex-copy-setup');
      if (!token) return;
      const setup = setupForToken(token);
      const ok = await _copyCodexToken(setup);
      if (!btn) return;
      if (ok) {
        btn.innerHTML = CHECK_ICON;
        btn.style.color = 'var(--accent, var(--red))';
        btn.style.opacity = '1';
      } else {
        _selectTextFallback(setup, 'uf-codex-reveal');
      }
      setTimeout(() => {
        const latest = el('uf-codex-copy-setup');
        if (latest) { latest.innerHTML = COPY_ICON; latest.style.color = ''; latest.style.opacity = '0.7'; }
      }, 1600);
    });
    el('uf-codex-copy-token')?.addEventListener('click', async () => {
      const token = el('uf-codex-token')?.textContent || '';
      const ok = await _copyCodexToken(token);
      const btn = el('uf-codex-copy-token');
      if (!btn) return;
      if (ok) {
        btn.innerHTML = CHECK_ICON;
        btn.style.color = 'var(--accent, var(--red))';
        btn.style.opacity = '1';
      } else {
        _selectTextFallback(token, 'uf-codex-reveal');
      }
      setTimeout(() => {
        const latest = el('uf-codex-copy-token');
        if (latest) { latest.innerHTML = COPY_ICON; latest.style.color = ''; latest.style.opacity = '0.7'; }
      }, 1600);
    });
    function _wireScopeChange(scope) {
      scope.querySelectorAll('.uf-codex-scope').forEach(cb => {
        if (cb.dataset.wired === '1') return;
        cb.dataset.wired = '1';
        cb.addEventListener('change', async () => {
          const tokenId = cb.dataset.tokenId;
          const panel = formEl.querySelector(`.uf-codex-token[data-token-id="${CSS.escape(tokenId)}"]`);
          const msg = formEl.querySelector(`.uf-codex-scope-msg[data-token-id="${CSS.escape(tokenId)}"]`);
          const scopes = Array.from(panel.querySelectorAll('.uf-codex-scope:checked')).map(input => input.dataset.scope);
          try {
            const r = await fetch(`/api/tokens/${tokenId}`, {
              method: 'PATCH',
              credentials: 'same-origin',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ scopes }),
            });
            const d = await r.json().catch(() => ({}));
            if (!r.ok) throw new Error(d.detail || 'Failed');
            if (msg) { msg.textContent = 'Saved'; msg.style.color = 'var(--green, #50fa7b)'; }
            await renderList();
          } catch (err) {
            cb.checked = !cb.checked;
            if (msg) { msg.textContent = err?.message || 'Failed'; msg.style.color = 'var(--red)'; }
          }
        });
      });
    }
    // Note: don't call _wireScopeChange(formEl) here. The existing-token
    // editor (current) already wires its own change handler that PATCHes
    // immediately. The inline scopes for a *just-created* token should
    // remain unwired so they only persist on Save click below.
  }

  // ── Add button now drops a type-picker menu directly anchored to itself ──
  if (addBtn) {
    const _typeOptions = [
      ['api', 'API Service', 'Connect an external API service.'],
      ['caldav', 'CalDAV Calendar', 'Sync calendars you choose.'],
      ['claude', 'Claude Agent', 'Configure a scoped agent token.'],
      ['codex', 'Codex Agent', 'Configure a scoped agent token.'],
      ['carddav', 'Contacts (CardDAV)', 'Sync contacts from a server.'],
      ['contacts', 'Contacts Import', 'Import contacts into Odysseus.'],
      ['email', 'Email (IMAP/SMTP)', 'Connect mail; sending is optional.'],
      ['moodle', 'ETH Moodle', 'Read enrolled course content; optional indexing, no writes.'],
      ['browser', 'Browser Session', 'Sign in yourself; form controls are semantic, checkout is blocked.'],
      ['whatsapp', 'WhatsApp', 'Managed pairing; history read, outbound off by default.'],
      ['maps', 'Maps', 'Geocoding and directions; OpenRouteService key required.'],
      ['shopping', 'Shopping Search', 'Public product listings; no cart or purchase.'],
      ['mcp', 'MCP Tool Server', 'Connect a tool server and review its permissions.'],
    ];
    const _iconFor = (k) => (INTG_TYPES[k]?.icon || '').replace(/width="14"/, 'width="16"').replace(/height="14"/, 'height="16"');
    const _rowsHtml = _typeOptions.map(([k, label, description]) => `<button type="button" class="uf-type-option" data-value="${k}" style="display:flex;align-items:center;gap:10px;width:100%;padding:8px 10px;background:transparent;border:0;color:var(--fg);font:inherit;cursor:pointer;text-align:left;"><span style="display:inline-flex;color:var(--accent, var(--red));flex-shrink:0;">${_iconFor(k)}</span><span style="min-width:0"><span style="display:block">${esc(label)}</span><small style="display:block;opacity:.62;font-size:10px;line-height:1.3">${esc(description)}</small></span></button>`).join('');

    // Anchor wrapper so the absolutely-positioned menu lands directly under
    // the add button. The button is the wrapper's only sibling.
    if (!addBtn.parentElement.classList.contains('uf-add-anchor')) {
      addBtn.parentElement.style.position = 'relative';
      addBtn.parentElement.classList.add('uf-add-anchor');
    }
    // Menu is created per open and removed on close. _closeMenu routes through
    // the bindMenuDismiss close() bound when the menu opens, so the outside-click
    // listener + Escape-stack entry are torn down alongside the node removal.
    let _menuEl = null;
    let _closeMenu = () => {};
    addBtn.setAttribute('aria-haspopup', 'menu');
    addBtn.setAttribute('aria-expanded', 'false');
    addBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (_menuEl) { _closeMenu(); return; }
      const menu = document.createElement('div');
      menu.className = 'uf-add-menu';
      menu.setAttribute('role', 'menu');
      menu.setAttribute('aria-label', 'Add an integration');
      menu.innerHTML = _rowsHtml;
      menu.style.cssText = 'position:absolute;right:0;z-index:1000;background:var(--panel);border:1px solid var(--border);border-radius:6px;max-height:340px;overflow-y:auto;box-shadow:0 6px 18px rgba(0,0,0,0.25);min-width:220px;';
      menu.querySelectorAll('.uf-type-option').forEach(button => button.setAttribute('role', 'menuitem'));
      addBtn.parentElement.appendChild(menu);
      _menuEl = menu;
      addBtn.setAttribute('aria-expanded', 'true');
      const tRect = addBtn.getBoundingClientRect();
      const mRect = menu.getBoundingClientRect();
      const below = window.innerHeight - tRect.bottom;
      const above = tRect.top;
      if (mRect.height > below && above > below) {
        menu.style.top = 'auto'; menu.style.bottom = 'calc(100% + 2px)';
      } else {
        menu.style.top = 'calc(100% + 2px)'; menu.style.bottom = 'auto';
      }
      menu.querySelectorAll('.uf-type-option').forEach(button => {
        button.addEventListener('mouseenter', () => { button.style.background = 'color-mix(in srgb, var(--fg) 8%, transparent)'; });
        button.addEventListener('mouseleave', () => { button.style.background = 'transparent'; });
        button.addEventListener('click', (ev) => {
          ev.stopPropagation();
          const k = button.dataset.value;
          _closeMenu();
          formEl.style.display = '';
          showForm(k, null);
        });
      });
      _closeMenu = bindMenuDismiss(menu, () => {
        menu.remove();
        _menuEl = null;
        addBtn.setAttribute('aria-expanded', 'false');
      }, (ev) => !menu.contains(ev.target) && ev.target !== addBtn);
      menu.addEventListener('keydown', event => {
        const items = Array.from(menu.querySelectorAll('.uf-type-option'));
        const current = items.indexOf(document.activeElement);
        let next = current;
        if (event.key === 'ArrowDown') next = (current + 1 + items.length) % items.length;
        else if (event.key === 'ArrowUp') next = (current - 1 + items.length) % items.length;
        else if (event.key === 'Home') next = 0;
        else if (event.key === 'End') next = items.length - 1;
        else if (event.key === 'Escape') { event.preventDefault(); _closeMenu(); addBtn.focus(); return; }
        else return;
        event.preventDefault();
        items[next]?.focus();
      });
      menu.querySelector('.uf-type-option')?.focus();
    });
  }

  try {
    connectorSetupMetadata = await connectorRequest('/api/connectors/setup');
  } catch (error) {
    connectorSetupMetadataError = error.message || 'Setup metadata is unavailable.';
  }
  await renderList();
}

/* ═══════════════════════════════════════════
   PUBLIC API
   ═══════════════════════════════════════════ */
export function open(tab) { _shell.open(tab); }
export function close() { _shell.close(); }
function syncAdminVisibility() { _shell.syncAdminVisibility(); }

handleSettingsOauthReturn({ openSettings: open });

const settingsModule = { open, close, initIntegrations, initUnifiedIntegrations, syncAdminVisibility, refreshAiModelEndpoints };


export default settingsModule;
