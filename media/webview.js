(function () {
  const vscode = acquireVsCodeApi();

  // --- State ---
  let isRunning = false;
  let config = {};
  let lastWorkingFiles = [];
  const selectedWorkingPaths = new Set();
  let currentAction = '';

  // --- DOM Elements ---
  const statusWorkspace = document.getElementById('status-workspace');
  const statusStage = document.getElementById('status-stage');
  const statusLocal = document.getElementById('status-local');
  const statusRemote = document.getElementById('status-remote');
  const badgeWorking = document.getElementById('badge-working');
  const badgeStaged = document.getElementById('badge-staged');
  const workingFileList = document.getElementById('workingFileList');
  const commitInput = document.getElementById('commit-message-input');
  const logPre = document.getElementById('log');
  const statusText = document.getElementById('statusText');
  const branchList = document.getElementById('branchList');
  const stepNodes = Array.from(document.querySelectorAll('.node[data-step]'));

  if (statusWorkspace) {
    statusWorkspace.style.display = 'none';
  }

  // Settings Elements
  const settingsOverlay = document.getElementById('settingsOverlay');
  const openSettingsPanelBtn = document.getElementById('openSettingsPanel');
  const settingsCloseBtn = document.getElementById('settingsClose');
  const saveBtn = document.getElementById('save');
  const reloadBtn = document.getElementById('reload');
  const showKeyCheckbox = document.getElementById('showKey');
  
  // Config Inputs
  const inputs = {
    target: document.getElementById('configTarget'),
    'ai.baseUrl': document.getElementById('aiBaseUrl'),
    'ai.model': document.getElementById('aiModel'),
    'ai.apiKey': document.getElementById('aiApiKey'),
    'ai.temperature': document.getElementById('aiTemperature'),
    'commit.diffScope': document.getElementById('commitDiffScope'),
    'changelog.path': document.getElementById('changelogPath'),
    'pr.platform': document.getElementById('prPlatform'),
    'pr.baseRef': document.getElementById('prBaseRef'),
    'pr.includeChecklist': document.getElementById('prIncludeChecklist')
  };

  // --- Initialization ---
  try {
    const raw = document.getElementById('initialJson').value;
    const initial = JSON.parse(raw);
    config = initial;
    populateConfig(initial);
  } catch (e) {
    console.error('Failed to load initial config', e);
  }

  // Initial Status Check
  vscode.postMessage({ type: 'runAction', action: 'gitStatus' });

  // --- Event Listeners ---

  // 1. Global Message Handler
  window.addEventListener('message', (event) => {
    const message = event.data;
    switch (message.type) {
      case 'toast':
        showToast(message.message, message.level);
        break;
      case 'confirm':
        handleConfirm(message);
        break;
      case 'prompt':
        handlePrompt(message);
        break;
      case 'branches':
        updateBranches(message.current, message.branches);
        break;
      case 'workingFiles':
        renderWorkingFiles(message.files);
        break;
      case 'runState':
        isRunning = message.state === 'running';
        currentAction = message.action || '';
        updateLoadingState(isRunning, currentAction);
        if (statusText) {
            statusText.textContent = isRunning ? 'Running...' : 'Idle';
            statusText.className = 'node-status ' + (isRunning ? 'warning' : 'success');
        }
        break;
      case 'log':
        appendLog(message.message, message.level);
        break;
      case 'result':
        handleResult(message);
        break;
    }
  });

  // 2. Action Buttons
  document.querySelectorAll('button[data-action]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (isRunning) return;
      const action = btn.getAttribute('data-action');
      
      let payload = undefined;
      if (action === 'commitGenerated' || action === 'amendGenerated') {
          if (commitInput) {
              const message = commitInput.value;
              if (message.trim()) {
                  payload = { message };
              }
          }
      } else if (action === 'stageFiles') {
          const targets = pickTargetWorkingFiles();
          payload = { paths: targets.map((f) => f.path) };
      } else if (action === 'checkoutFiles') {
          const targets = pickTargetWorkingFiles();
          payload = { files: targets.map((f) => ({ path: f.path, kind: f.kind })) };
      }
      
      vscode.postMessage({ type: 'runAction', action, payload });
    });
  });

  document.getElementById('commitExpand')?.addEventListener('click', () => {
    if (isRunning) return;
    const message = commitInput ? String(commitInput.value || '') : '';
    vscode.postMessage({ type: 'runAction', action: 'openCommitEditor', payload: { message } });
  });

  // 3. Settings Overlay
  if (openSettingsPanelBtn) {
    openSettingsPanelBtn.addEventListener('click', () => {
      settingsOverlay.classList.add('show');
      settingsOverlay.setAttribute('aria-hidden', 'false');
    });
  }

  if (settingsCloseBtn) {
    settingsCloseBtn.addEventListener('click', () => {
      settingsOverlay.classList.remove('show');
      settingsOverlay.setAttribute('aria-hidden', 'true');
    });
  }

  // Close on backdrop click
  document.querySelectorAll('.overlayBackdrop').forEach(el => {
      el.addEventListener('click', () => {
          settingsOverlay.classList.remove('show');
          settingsOverlay.setAttribute('aria-hidden', 'true');
      });
  });

  // 4. Config Actions
  if (saveBtn) {
      saveBtn.addEventListener('click', () => {
          const values = {};
          // Collect values
          for (const [key, el] of Object.entries(inputs)) {
              if (key === 'target') continue; // handled separately
              if (el.type === 'checkbox') {
                  values[key] = el.checked;
              } else if (el.type === 'number') {
                  values[key] = parseFloat(el.value);
              } else {
                  values[key] = el.value;
              }
          }
          
          const target = inputs.target.value;
          vscode.postMessage({ type: 'saveConfig', target, values });
      });
  }

  if (reloadBtn) {
      reloadBtn.addEventListener('click', () => {
          // In a real app we might reload from disk, but here we just re-populate with initial or current memory
          populateConfig(config); 
          // Or ask extension to reload? The extension sends initial config on load.
          // Since we don't have a 'reloadConfig' command, we just re-apply what we have or maybe we should have one.
          // For now, let's just show a toast.
          showToast('Reset to the initial state.', 'info');
      });
  }
  
  if (showKeyCheckbox) {
      showKeyCheckbox.addEventListener('change', (e) => {
          if (inputs['ai.apiKey']) {
              inputs['ai.apiKey'].type = e.target.checked ? 'text' : 'password';
          }
      });
  }
  
  document.getElementById('openSettings')?.addEventListener('click', () => {
      vscode.postMessage({ type: 'runAction', action: 'openSettings' });
  });

  // 5. Log Actions
  document.getElementById('clearLog')?.addEventListener('click', () => {
      if (logPre) logPre.textContent = '';
  });

  // --- Helper Functions ---

  function populateConfig(cfg) {
      if (!cfg || !cfg.values) return;
      
      if (inputs.target && cfg.target) {
          inputs.target.value = cfg.target;
      }
      
      for (const [key, val] of Object.entries(cfg.values)) {
          const el = inputs[key];
          if (!el) continue;
          
          if (el.type === 'checkbox') {
              el.checked = !!val;
          } else {
              el.value = val !== undefined ? val : '';
          }
      }
  }

  function handleResult(message) {
    if (message.action === 'commitMessage') {
      if (commitInput) {
        commitInput.value = message.content;
        commitInput.focus();
        // Trigger input event to resize if needed (though CSS handles it mostly)
      }
    } else if (message.action === 'gitStatus') {
        updateStatusNodes(message.content);
    } else if (message.action === 'stageAll' || message.action === 'unstageAll' || message.action === 'stageFiles' || message.action === 'checkoutFiles') {
        if (message.content) updateStatusNodes(message.content);
        if (message.action === 'stageFiles' || message.action === 'checkoutFiles') {
          clearWorkingSelection();
        }
    } else if (message.action === 'push' || message.action === 'pull' || message.action === 'commitGenerated' || message.action === 'amendGenerated' || message.action === 'revert' || message.action === 'reset') {
         if (message.content && message.content.includes('branch:')) {
             updateStatusNodes(message.content);
         }
         if ((message.action === 'commitGenerated' || message.action === 'amendGenerated') && commitInput) {
             commitInput.value = '';
         }
    }
  }

  function clearWorkingSelection() {
    selectedWorkingPaths.clear();
    if (!workingFileList) return;
    workingFileList.querySelectorAll('.file-select').forEach((el) => {
      el.checked = false;
    });
    workingFileList.querySelectorAll('.file-row').forEach((el) => {
      el.classList.remove('is-selected');
    });
  }

  function updateBranches(current, branches) {
    if (!branchList || !Array.isArray(branches)) return;

    branchList.textContent = '';
    branches.forEach((b) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'branch-chip' + (b === current ? ' is-active' : '');
      btn.textContent = b;
      btn.addEventListener('click', () => {
        if (isRunning) return;
        if (b === current) return;
        vscode.postMessage({ type: 'runAction', action: 'checkoutBranch', payload: { branch: b } });
      });
      branchList.appendChild(btn);
    });
  }

  function renderWorkingFiles(files) {
    const safeFiles = Array.isArray(files) ? files : [];
    lastWorkingFiles = safeFiles
      .map((f) => ({ path: String(f?.path || ''), kind: String(f?.kind || 'other') }))
      .filter((f) => Boolean(f.path))
      .slice(0, 200);

    const present = new Set(lastWorkingFiles.map((f) => f.path));
    Array.from(selectedWorkingPaths).forEach((p) => {
      if (!present.has(p)) selectedWorkingPaths.delete(p);
    });

    const count = lastWorkingFiles.length;

    if (badgeWorking) {
      if (count > 0) {
        badgeWorking.textContent = String(count);
        badgeWorking.classList.add('show');
      } else {
        badgeWorking.textContent = '';
        badgeWorking.classList.remove('show');
      }
    }

    if (!workingFileList) return;
    workingFileList.textContent = '';
    workingFileList.style.display = 'flex';
    workingFileList.style.flexDirection = 'column';
    workingFileList.style.alignItems = 'stretch';

    if (count === 0) {
      const empty = document.createElement('div');
      empty.textContent = 'No changes';
      empty.style.color = 'var(--muted)';
      empty.style.fontSize = '12px';
      empty.style.padding = '4px 2px';
      workingFileList.appendChild(empty);
      return;
    }

    lastWorkingFiles
      .slice(0, 200)
      .sort((a, b) => String(a.path || '').localeCompare(String(b.path || '')))
      .forEach((f) => {
        const filePath = String(f.path || '');
        const kind = String(f.kind || 'other');

        const row = document.createElement('div');
        row.className = 'file-row' + (selectedWorkingPaths.has(filePath) ? ' is-selected' : '');
        row.style.display = 'grid';
        row.style.gridTemplateColumns = '14px 1fr';
        row.style.alignItems = 'center';
        row.style.columnGap = '8px';
        row.style.width = '100%';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.className = 'file-select';
        checkbox.style.margin = '0';
        checkbox.style.width = '14px';
        checkbox.style.height = '14px';
        checkbox.checked = selectedWorkingPaths.has(filePath);
        checkbox.addEventListener('change', () => {
          if (checkbox.checked) selectedWorkingPaths.add(filePath);
          else selectedWorkingPaths.delete(filePath);
          row.classList.toggle('is-selected', checkbox.checked);
        });

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'file-item';
        btn.style.width = '100%';
        btn.style.minWidth = '0';
        btn.style.display = 'flex';
        btn.style.alignItems = 'center';
        btn.style.gap = '10px';
        btn.style.textAlign = 'left';
        const kindShort =
          kind === 'modified'
            ? 'M'
            : kind === 'untracked'
              ? 'U'
              : kind === 'deleted'
                ? 'D'
                : kind === 'renamed'
                  ? 'R'
                  : 'O';

        const pathSpan = document.createElement('span');
        pathSpan.className = 'file-path';
        pathSpan.textContent = filePath;
        pathSpan.style.flex = '1';
        pathSpan.style.minWidth = '0';
        pathSpan.style.overflow = 'hidden';
        pathSpan.style.textOverflow = 'ellipsis';
        pathSpan.style.whiteSpace = 'nowrap';

        const kindSpan = document.createElement('span');
        kindSpan.className = 'file-kind';
        kindSpan.textContent = kindShort;
        kindSpan.style.flex = '0 0 auto';

        btn.appendChild(pathSpan);
        btn.appendChild(kindSpan);

        btn.addEventListener('click', () => {
          if (isRunning) return;
          if (!filePath) return;
          vscode.postMessage({ type: 'runAction', action: 'openDiff', payload: { path: filePath, kind } });
        });

        row.appendChild(checkbox);
        row.appendChild(btn);
        workingFileList.appendChild(row);
      });
  }

  function pickTargetWorkingFiles() {
    if (!Array.isArray(lastWorkingFiles) || lastWorkingFiles.length === 0) return [];
    if (!selectedWorkingPaths.size) return lastWorkingFiles;
    return lastWorkingFiles.filter((f) => selectedWorkingPaths.has(String(f.path || '')));
  }

  function updateStatusNodes(content) {
      const s = parseStatusText(content);
      const stagedCount = s.staged;
      const modifiedCount = s.modified;
      const untrackedCount = s.untracked;

      if (statusWorkspace) {
          const total = modifiedCount + untrackedCount;
          statusWorkspace.textContent = total > 0 ? `${total} to stage` : 'No changes';
          statusWorkspace.className = 'node-status ' + (total > 0 ? 'warning' : 'success');
      }

      if (statusStage) {
          statusStage.textContent = stagedCount > 0 ? 'Staged' : 'Empty';
          statusStage.className = 'node-status ' + (stagedCount > 0 ? 'warning' : 'success');
      }
      
      if (badgeStaged) {
        if (stagedCount > 0) {
          badgeStaged.textContent = String(stagedCount);
          badgeStaged.classList.add('show');
        } else {
          badgeStaged.textContent = '';
          badgeStaged.classList.remove('show');
        }
      }

      if (statusLocal) {
        if (s.ahead > 0) {
          statusLocal.textContent = `Push ${s.ahead}`;
          statusLocal.className = 'node-status warning';
        } else {
          statusLocal.textContent = 'Synced';
          statusLocal.className = 'node-status success';
        }
      }

      if (statusRemote) {
        if (s.behind > 0) {
          statusRemote.textContent = `Pull ${s.behind}`;
          statusRemote.className = 'node-status warning';
        } else {
          statusRemote.textContent = 'Synced';
          statusRemote.className = 'node-status success';
        }
      }

      setActiveStep(pickActiveStep(s));
  }

  function parseStatusText(content) {
    const out = { branch: '', tracking: '', ahead: 0, behind: 0, staged: 0, modified: 0, untracked: 0 };
    if (!content) return out;
    const lines = String(content).split('\n');
    lines.forEach((line) => {
      const lower = line.toLowerCase();
      if (lower.startsWith('branch:')) {
        const raw = line.slice(line.indexOf(':') + 1).trim();
        const m = raw.match(/^(\S+)(?:\s*\(([^)]+)\))?(?:\s+ahead:(\d+))?(?:\s+behind:(\d+))?/);
        if (m) {
          out.branch = m[1] || '';
          out.tracking = m[2] || '';
          out.ahead = m[3] ? parseInt(m[3], 10) || 0 : 0;
          out.behind = m[4] ? parseInt(m[4], 10) || 0 : 0;
        }
      }
      if (lower.startsWith('staged:')) out.staged = parseInt(line.split(':')[1], 10) || 0;
      if (lower.startsWith('modified:')) out.modified = parseInt(line.split(':')[1], 10) || 0;
      if (lower.startsWith('untracked:')) out.untracked = parseInt(line.split(':')[1], 10) || 0;
    });
    return out;
  }

  function pickActiveStep(s) {
    const workingCount = (s.modified || 0) + (s.untracked || 0);
    if ((s.staged || 0) > 0) return 'staging';
    if (workingCount > 0) return 'working';
    if ((s.ahead || 0) > 0) return 'local';
    if ((s.behind || 0) > 0) return 'remote';
    return 'local';
  }

  function setActiveStep(step) {
    if (!stepNodes.length) return;
    stepNodes.forEach((el) => {
      el.classList.toggle('is-active', el.dataset.step === step);
    });
  }

  function updateLoadingState(loading, action) {
      document.querySelectorAll('button').forEach(btn => {
          btn.disabled = loading;
          if (loading) btn.classList.add('loading');
          else btn.classList.remove('loading');
      });
      if (commitInput) commitInput.disabled = loading;
      const shouldShow = Boolean(loading) && isAiAction(String(action || ''));
      setLoadingOverlayVisible(shouldShow, action);
  }

  function isAiAction(action) {
    return (
      action === 'commitMessage' ||
      action === 'commitGenerated' ||
      action === 'amendGenerated' ||
      action === 'changelog' ||
      action === 'prDescription' ||
      action === 'testConnection'
    );
  }

  function ensureUiStyles() {
    if (document.getElementById('cgUiStyles')) return;
    const style = document.createElement('style');
    style.id = 'cgUiStyles';
    style.textContent = `
      @keyframes cgSpin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      .cg-overlay {
        position: fixed;
        inset: 0;
        display: none;
        align-items: center;
        justify-content: center;
        background: rgba(0,0,0,0.35);
        z-index: 9999;
        padding: 16px;
        box-sizing: border-box;
      }
      .cg-overlay.show { display: flex; }
      .cg-card {
        width: min(520px, 100%);
        border: 1px solid var(--border);
        border-radius: 12px;
        background: color-mix(in srgb, var(--bg) 78%, transparent);
        backdrop-filter: blur(10px);
        padding: 14px;
        box-sizing: border-box;
        display: flex;
        flex-direction: column;
        gap: 10px;
        color: var(--fg);
      }
      .cg-card-title {
        font-size: 12px;
        color: var(--muted);
        font-weight: 600;
      }
      .cg-card-body {
        font-size: 13px;
        line-height: 1.5;
        white-space: pre-wrap;
        word-break: break-word;
      }
      .cg-actions {
        display: flex;
        gap: 8px;
        justify-content: flex-end;
      }
      .cg-btn {
        appearance: none;
        border: 1px solid var(--border);
        border-radius: 10px;
        padding: 7px 12px;
        cursor: pointer;
        background: transparent;
        color: var(--fg);
        font-size: 12px;
      }
      .cg-btn.primary {
        background: var(--accent);
        border-color: var(--accent);
        color: var(--accent-fg);
      }
      .cg-btn.primary:hover {
        background: var(--accent-hover);
        border-color: var(--accent-hover);
      }
      .cg-loading-row {
        display: flex;
        gap: 10px;
        align-items: center;
      }
      .cg-spinner {
        width: 18px;
        height: 18px;
        border-radius: 999px;
        border: 2px solid color-mix(in srgb, var(--fg) 20%, transparent);
        border-top-color: color-mix(in srgb, var(--fg) 75%, transparent);
        animation: cgSpin 0.9s linear infinite;
        flex: 0 0 auto;
      }
      .cg-loading-text {
        font-size: 13px;
        color: var(--fg);
      }
    `;
    document.head.appendChild(style);
  }

  function getOrCreateLoadingOverlay() {
    ensureUiStyles();
    let el = document.getElementById('cgLoadingOverlay');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'cgLoadingOverlay';
    el.className = 'cg-overlay';
    const card = document.createElement('div');
    card.className = 'cg-card';
    const title = document.createElement('div');
    title.className = 'cg-card-title';
    title.textContent = 'Commit Genius';
    const row = document.createElement('div');
    row.className = 'cg-loading-row';
    const spinner = document.createElement('div');
    spinner.className = 'cg-spinner';
    const text = document.createElement('div');
    text.className = 'cg-loading-text';
    text.id = 'cgLoadingText';
    text.textContent = 'Working...';
    row.appendChild(spinner);
    row.appendChild(text);
    card.appendChild(title);
    card.appendChild(row);
    el.appendChild(card);
    document.body.appendChild(el);
    return el;
  }

  function setLoadingOverlayVisible(visible, action) {
    const el = getOrCreateLoadingOverlay();
    el.classList.toggle('show', Boolean(visible));
    const label = document.getElementById('cgLoadingText');
    if (label) {
      label.textContent = action ? `Calling AI: ${action}` : 'Calling AI...';
    }
  }

  function handleConfirm(message) {
    const id = message && message.id ? String(message.id) : '';
    if (!id) return;
    const content = message && message.message ? String(message.message) : '';
    const confirmLabel = message && message.confirmLabel ? String(message.confirmLabel) : 'OK';
    const cancelLabel = message && message.cancelLabel ? String(message.cancelLabel) : 'Cancel';
    showConfirmModal({ content, confirmLabel, cancelLabel })
      .then((ok) => {
        vscode.postMessage({ type: 'confirmResult', id, ok: Boolean(ok) });
      })
      .catch(() => {
        vscode.postMessage({ type: 'confirmResult', id, ok: false });
      });
  }

  function showConfirmModal({ content, confirmLabel, cancelLabel }) {
    ensureUiStyles();
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'cg-overlay show';
      const card = document.createElement('div');
      card.className = 'cg-card';
      const title = document.createElement('div');
      title.className = 'cg-card-title';
      title.textContent = 'Confirm';
      const body = document.createElement('div');
      body.className = 'cg-card-body';
      body.textContent = String(content || '');
      const actions = document.createElement('div');
      actions.className = 'cg-actions';
      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'cg-btn';
      cancelBtn.textContent = cancelLabel || 'Cancel';
      const okBtn = document.createElement('button');
      okBtn.type = 'button';
      okBtn.className = 'cg-btn primary';
      okBtn.textContent = confirmLabel || 'OK';
      actions.appendChild(cancelBtn);
      actions.appendChild(okBtn);
      card.appendChild(title);
      card.appendChild(body);
      card.appendChild(actions);
      overlay.appendChild(card);

      const cleanup = (ok) => {
        window.removeEventListener('keydown', onKeyDown, true);
        overlay.remove();
        resolve(Boolean(ok));
      };

      const onKeyDown = (e) => {
        if (e.key === 'Escape') cleanup(false);
        if (e.key === 'Enter') cleanup(true);
      };

      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) cleanup(false);
      });
      cancelBtn.addEventListener('click', () => cleanup(false));
      okBtn.addEventListener('click', () => cleanup(true));
      window.addEventListener('keydown', onKeyDown, true);

      document.body.appendChild(overlay);
      okBtn.focus();
    });
  }

  function handlePrompt(message) {
    const id = message && message.id ? String(message.id) : '';
    if (!id) return;
    const title = message && message.title ? String(message.title) : 'Input required';
    const content = message && message.message ? String(message.message) : '';
    const placeholder = message && message.placeholder ? String(message.placeholder) : '';
    const confirmLabel = message && message.confirmLabel ? String(message.confirmLabel) : 'OK';
    const cancelLabel = message && message.cancelLabel ? String(message.cancelLabel) : 'Cancel';
    const expected = message && message.expected ? String(message.expected) : '';

    showPromptModal({ title, content, placeholder, confirmLabel, cancelLabel, expected })
      .then((value) => {
        vscode.postMessage({ type: 'promptResult', id, value });
      })
      .catch(() => {
        vscode.postMessage({ type: 'promptResult', id, value: undefined });
      });
  }

  function showPromptModal({ title, content, placeholder, confirmLabel, cancelLabel, expected }) {
    ensureUiStyles();
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'cg-overlay show';
      const card = document.createElement('div');
      card.className = 'cg-card';
      const titleEl = document.createElement('div');
      titleEl.className = 'cg-card-title';
      titleEl.textContent = String(title || 'Input');
      const body = document.createElement('div');
      body.className = 'cg-card-body';
      body.textContent = String(content || '');

      const input = document.createElement('input');
      input.type = 'text';
      input.placeholder = placeholder || '';
      input.autocomplete = 'off';
      input.spellcheck = false;
      input.style.width = '100%';
      input.style.boxSizing = 'border-box';
      input.style.border = '1px solid var(--input-border)';
      input.style.borderRadius = '10px';
      input.style.padding = '8px 10px';
      input.style.background = 'var(--input-bg)';
      input.style.color = 'var(--input-fg)';
      input.style.outline = 'none';

      const actions = document.createElement('div');
      actions.className = 'cg-actions';
      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'cg-btn';
      cancelBtn.textContent = cancelLabel || 'Cancel';
      const okBtn = document.createElement('button');
      okBtn.type = 'button';
      okBtn.className = 'cg-btn primary';
      okBtn.textContent = confirmLabel || 'OK';
      actions.appendChild(cancelBtn);
      actions.appendChild(okBtn);

      card.appendChild(titleEl);
      card.appendChild(body);
      card.appendChild(input);
      card.appendChild(actions);
      overlay.appendChild(card);

      const validate = () => {
        if (!expected) {
          okBtn.disabled = false;
          return;
        }
        okBtn.disabled = input.value !== expected;
      };
      validate();

      const cleanup = (value) => {
        window.removeEventListener('keydown', onKeyDown, true);
        overlay.remove();
        resolve(value);
      };

      const onKeyDown = (e) => {
        if (e.key === 'Escape') cleanup(undefined);
        if (e.key === 'Enter') {
          if (okBtn.disabled) return;
          cleanup(input.value);
        }
      };

      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) cleanup(undefined);
      });
      input.addEventListener('input', validate);
      cancelBtn.addEventListener('click', () => cleanup(undefined));
      okBtn.addEventListener('click', () => {
        if (okBtn.disabled) return;
        cleanup(input.value);
      });
      window.addEventListener('keydown', onKeyDown, true);

      document.body.appendChild(overlay);
      input.focus();
      input.select();
    });
  }

  function appendLog(text, level) {
      if (!logPre) return;
      const span = document.createElement('div');
      span.textContent = `[${new Date().toLocaleTimeString()}] ${text}`;
      if (level === 'error') span.style.color = 'var(--danger)';
      else if (level === 'success') span.style.color = '#2ea043';
      logPre.appendChild(span);
      logPre.scrollTop = logPre.scrollHeight;
  }

  function showToast(message, level) {
      const toast = document.getElementById('toast');
      const title = document.getElementById('toastTitle');
      const body = document.getElementById('toastBody');
      const dot = document.getElementById('toastDot');
      
      if (!toast) return;
      
      title.textContent = level === 'error' ? 'Error' : level === 'info' ? 'Info' : 'Success';
      body.textContent = message;
      
      dot.className = 'dot ' + (level === 'error' ? 'bad' : 'ok');
      
      toast.classList.add('show');
      
      setTimeout(() => {
          toast.classList.remove('show');
      }, 3000);
  }
  
  document.getElementById('toastClose')?.addEventListener('click', () => {
      document.getElementById('toast')?.classList.remove('show');
  });

})();
