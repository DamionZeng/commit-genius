(function () {
  const vscode = acquireVsCodeApi();

  // --- State ---
  let isRunning = false;
  let config = {};

  // --- DOM Elements ---
  const statusWorkspace = document.getElementById('status-workspace');
  const statusStage = document.getElementById('status-stage');
  const commitInput = document.getElementById('commit-message-input');
  const logPre = document.getElementById('log');
  const statusText = document.getElementById('statusText');

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
      case 'runState':
        isRunning = message.state === 'running';
        updateLoadingState(isRunning);
        if (statusText) {
            statusText.textContent = isRunning ? '运行中...' : '空闲';
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
      }
      
      vscode.postMessage({ type: 'runAction', action, payload });
    });
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
          showToast('已重置为初始加载状态', 'info');
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
    } else if (message.action === 'stageAll' || message.action === 'unstageAll') {
        if (message.content) updateStatusNodes(message.content);
    } else if (message.action === 'push' || message.action === 'commitGenerated' || message.action === 'amendGenerated' || message.action === 'revert' || message.action === 'reset') {
         if (message.content && message.content.includes('branch:')) {
             updateStatusNodes(message.content);
         }
         if ((message.action === 'commitGenerated' || message.action === 'amendGenerated') && commitInput) {
             commitInput.value = '';
         }
    }
  }

  function updateStatusNodes(content) {
      const lines = content.split('\n');
      let stagedCount = 0;
      let modifiedCount = 0;
      let untrackedCount = 0;
      
      lines.forEach(line => {
          const lower = line.toLowerCase();
          if (lower.startsWith('staged:')) stagedCount = parseInt(line.split(':')[1]) || 0;
          if (lower.startsWith('modified:')) modifiedCount = parseInt(line.split(':')[1]) || 0;
          if (lower.startsWith('untracked:')) untrackedCount = parseInt(line.split(':')[1]) || 0;
      });

      if (statusWorkspace) {
          const total = modifiedCount + untrackedCount;
          statusWorkspace.textContent = total > 0 ? `${total} 个文件待暂存` : '无改动';
          statusWorkspace.className = 'node-status ' + (total > 0 ? 'warning' : 'success');
      }

      if (statusStage) {
          statusStage.textContent = stagedCount > 0 ? `${stagedCount} 个文件待提交` : '空';
          statusStage.className = 'node-status ' + (stagedCount > 0 ? 'warning' : 'success');
      }
  }

  function updateLoadingState(loading) {
      document.querySelectorAll('button').forEach(btn => {
          btn.disabled = loading;
          if (loading) btn.classList.add('loading');
          else btn.classList.remove('loading');
      });
      if (commitInput) commitInput.disabled = loading;
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
      
      title.textContent = level === 'error' ? 'Error' : 'Success';
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
