import * as vscode from 'vscode';

import { getNonce } from './protocol';

export function getInitialConfig() {
  const c = vscode.workspace.getConfiguration('gitGenius');
  return {
    target: vscode.workspace.workspaceFolders?.length ? ('workspace' as const) : ('global' as const),
    values: {
      'ai.baseUrl': c.get<string>('ai.baseUrl', 'https://api.openai.com/v1'),
      'ai.apiKey': '',
      'ai.model': c.get<string>('ai.model', 'gpt-4o-mini'),
      'ai.temperature': c.get<number>('ai.temperature', 0.2),
      'commit.diffScope': c.get<string>('commit.diffScope', 'staged'),
      'changelog.path': c.get<string>('changelog.path', 'CHANGELOG.md'),
      'pr.platform': c.get<string>('pr.platform', 'github'),
      'pr.baseRef': c.get<string>('pr.baseRef', ''),
      'pr.includeChecklist': c.get<boolean>('pr.includeChecklist', true)
    }
  };
}

export function getDashboardHtml(context: vscode.ExtensionContext, webview: vscode.Webview): string {
  const nonce = getNonce();
  const initial = getInitialConfig();
  const initialJson = JSON.stringify(initial).replace(/</g, '\\u003c');
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'webview.js'));

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https: data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}' ${webview.cspSource};" />
    <title>Git Genius</title>
    <style>
      :root {
        color-scheme: light dark;
        --bg: var(--vscode-sideBar-background);
        --fg: var(--vscode-foreground);
        --muted: var(--vscode-descriptionForeground);
        --card: color-mix(in srgb, var(--vscode-editor-background) 80%, transparent);
        --border: color-mix(in srgb, var(--vscode-panel-border) 55%, transparent);
        --input-bg: var(--vscode-input-background);
        --input-fg: var(--vscode-input-foreground);
        --input-border: var(--vscode-input-border);
        --focus: var(--vscode-focusBorder);
        --accent: var(--vscode-button-background);
        --accent-fg: var(--vscode-button-foreground);
        --accent-hover: var(--vscode-button-hoverBackground);
        --danger: var(--vscode-inputValidation-errorBorder);
      }

      * { box-sizing: border-box; }
      html, body { padding: 0; margin: 0; }
      body {
        font-family: var(--vscode-font-family);
        color: var(--fg);
        background: linear-gradient(180deg, color-mix(in srgb, var(--bg) 90%, transparent), var(--bg));
        overflow-y: scroll;
        overflow-x: hidden;
      }

      .wrap { padding: 18px 14px; max-width: 1200px; margin: 0 auto; }
      
      /* Title Bar */
      .title {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 24px;
      }
      .title h1 {
        margin: 0;
        font-size: 18px;
        font-weight: 600;
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .title .sub {
        font-size: 12px;
        color: var(--muted);
        font-weight: normal;
      }

      .icon-btn {
        display: inline-flex;
        align-items: center;
        gap: 8px;
      }
      .icon-btn svg {
        width: 14px;
        height: 14px;
        flex: 0 0 auto;
      }

      /* Branch Bar */
      .branch-bar {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 10px 12px;
        border-radius: 12px;
        border: 1px solid var(--border);
        background: var(--card);
        margin-bottom: 14px;
      }
      .branch-label {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        color: var(--muted);
        font-size: 12px;
        white-space: nowrap;
      }
      .branch-label svg { width: 14px; height: 14px; }
      .branch-list {
        display: flex;
        align-items: center;
        gap: 8px;
        overflow: auto;
        padding: 2px 0;
        flex: 1;
      }
      .branch-chip {
        appearance: none;
        border: 1px solid var(--border);
        background: transparent;
        color: var(--fg);
        border-radius: 999px;
        padding: 4px 10px;
        font-size: 12px;
        cursor: pointer;
        white-space: nowrap;
        transition: background 0.1s, border-color 0.1s;
      }
      .branch-chip:hover { background: color-mix(in srgb, var(--bg) 82%, transparent); }
      .branch-chip.is-active {
        border-color: color-mix(in srgb, var(--focus) 90%, transparent);
        background: color-mix(in srgb, var(--focus) 14%, transparent);
      }

      /* Flow Chart Styles */
      .flow-container {
        display: grid;
        gap: 14px;
        margin-bottom: 32px;
      }
      
      .flow-row {
        display: flex;
        align-items: stretch;
        gap: 12px;
        width: 100%;
      }

      .flow-step { flex: 1; min-width: 0; }
      .flow-link {
        width: 28px;
        position: relative;
        flex: 0 0 auto;
        display: flex;
        align-items: center;
        justify-content: center;
      }

      .flow-connector {
        width: 28px;
        height: 40px;
        display: block;
      }
      .flow-connector path {
        fill: none;
        stroke-linecap: round;
      }
      .flow-connector-base {
        stroke: color-mix(in srgb, var(--border) 70%, transparent);
        stroke-width: 2;
        opacity: 0.95;
      }
      .flow-connector-flow {
        stroke: color-mix(in srgb, var(--focus) 92%, #4cc2ff);
        stroke-width: 2.5;
        stroke-dasharray: 6 10;
        opacity: 0;
        filter: drop-shadow(0 0 6px color-mix(in srgb, var(--focus) 40%, transparent));
      }
      .flow-link.is-flowing .flow-connector-flow { opacity: 0.95; }
      .flow-link.is-flowing.dir-forward .flow-connector-flow { animation: cgFlowFwd 1.15s linear infinite; }
      .flow-link.is-flowing.dir-backward .flow-connector-flow { animation: cgFlowBwd 1.15s linear infinite; }

      @keyframes cgFlowFwd { from { stroke-dashoffset: 0; } to { stroke-dashoffset: -32; } }
      @keyframes cgFlowBwd { from { stroke-dashoffset: 0; } to { stroke-dashoffset: 32; } }

      @media (prefers-reduced-motion: reduce) {
        .flow-link.is-flowing .flow-connector-flow { animation: none; }
      }
      
      .node {
        background: var(--card);
        border: 1px solid var(--border);
        border-radius: 12px;
        padding: 16px;
        display: flex;
        flex-direction: column;
        gap: 12px;
        transition: all 0.2s ease;
        position: relative;
        height: 100%;
      }

      .count-badge {
        position: absolute;
        top: 10px;
        right: 10px;
        min-width: 18px;
        height: 18px;
        padding: 0 6px;
        display: none;
        align-items: center;
        justify-content: center;
        border-radius: 999px;
        background: color-mix(in srgb, var(--focus) 22%, transparent);
        border: 1px solid color-mix(in srgb, var(--focus) 75%, transparent);
        color: var(--fg);
        font-size: 11px;
        font-weight: 700;
        line-height: 18px;
      }
      .count-badge.show { display: inline-flex; }

      .file-list {
        border-top: 1px solid var(--border);
        padding-top: 10px;
        display: flex;
        flex-direction: column;
        gap: 6px;
        height: 160px;
        overflow-x: hidden;
        overflow-y: auto;
      }
      .file-list::-webkit-scrollbar { width: 4px; height: 4px; }
      .file-list::-webkit-scrollbar-track { background: transparent; }
      .file-list::-webkit-scrollbar-thumb {
        background: color-mix(in srgb, var(--fg) 22%, transparent);
        border-radius: 999px;
      }
      .file-list::-webkit-scrollbar-thumb:hover {
        background: color-mix(in srgb, var(--fg) 32%, transparent);
      }
      .file-row {
        display: grid;
        grid-template-columns: 14px 1fr;
        align-items: center;
        column-gap: 8px;
        min-width: 0;
        width: 100%;
      }
      .file-select {
        margin: 0;
        flex: 0 0 auto;
        width: 14px;
        height: 14px;
      }
      .file-item {
        appearance: none;
        border: 1px solid var(--border);
        background: color-mix(in srgb, var(--bg) 65%, transparent);
        color: var(--fg);
        border-radius: 10px;
        padding: 8px 10px;
        cursor: pointer;
        display: flex;
        align-items: center;
        gap: 10px;
        text-align: left;
        flex: 1;
        width: 100%;
        min-width: 0;
      }
      .file-item:hover {
        border-color: color-mix(in srgb, var(--focus) 60%, transparent);
        background: color-mix(in srgb, var(--bg) 78%, transparent);
      }
      .file-row.is-selected .file-item {
        border-color: color-mix(in srgb, var(--focus) 80%, transparent);
      }
      .file-path {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 12px;
      }
      .file-kind {
        font-size: 10px;
        color: var(--muted);
        border: 1px solid var(--border);
        background: transparent;
        border-radius: 999px;
        padding: 2px 6px;
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }

      .node.is-active {
        border-color: color-mix(in srgb, var(--focus) 90%, transparent);
        box-shadow: 0 0 0 1px color-mix(in srgb, var(--focus) 45%, transparent), 0 10px 30px rgba(0,0,0,0.12);
      }
      
      .node:hover {
        transform: translateY(-2px);
        box-shadow: 0 4px 12px rgba(0,0,0,0.1);
        border-color: var(--focus);
      }

      .node-header {
        display: flex;
        align-items: center;
        gap: 12px;
      }
      
      .node-icon {
        width: 36px;
        height: 36px;
        display: flex;
        align-items: center;
        justify-content: center;
        background: color-mix(in srgb, var(--bg) 50%, transparent);
        border-radius: 8px;
        color: color-mix(in srgb, var(--fg) 92%, transparent);
      }
      .node-icon svg {
        width: 18px;
        height: 18px;
      }
      
      .node-title {
        font-size: 14px;
        font-weight: 600;
        flex: 1;
        min-width: 0;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .node[data-step="remote"] .node-header { gap: 10px; }
      .node[data-step="remote"] .node-icon { width: 32px; height: 32px; }
      .node[data-step="remote"] .node-title {
        white-space: normal;
        overflow: visible;
        text-overflow: clip;
        word-break: break-all;
      }
      
      .node-status {
        font-size: 11px;
        color: var(--muted);
        background: color-mix(in srgb, var(--bg) 80%, transparent);
        padding: 2px 8px;
        border-radius: 99px;
      }
      .node-status.success {
        color: #2ea043;
        background: color-mix(in srgb, #2ea043 14%, transparent);
      }
      .node-status.warning {
        color: #d29922;
        background: color-mix(in srgb, #d29922 14%, transparent);
      }

      .node-actions {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
        margin-top: auto;
      }
      
      .node-content {
        display: flex;
        flex-direction: column;
        flex: 1;
        min-height: 0;
      }

      @media (max-width: 900px) {
        .flow-row { flex-direction: column; }
        .flow-link { width: 100%; height: 28px; }
        .flow-connector {
          width: 28px;
          height: 28px;
          transform: rotate(90deg);
          transform-origin: 50% 50%;
        }
      }

      /* AI Input Area */
      textarea.ai-input {
        width: 100%;
        min-height: 120px;
        flex: 1;
        background: var(--input-bg);
        border: 1px solid var(--input-border);
        color: var(--input-fg);
        border-radius: 8px;
        padding: 10px;
        font-family: var(--vscode-editor-font-family);
        font-size: 12px;
        resize: vertical;
        transition: border-color 0.2s;
        margin-bottom: 8px;
      }

      .textarea-wrap {
        position: relative;
        display: flex;
        flex: 1;
        min-height: 0;
      }

      .expand-btn {
        position: absolute;
        top: 8px;
        right: 8px;
        padding: 4px 6px;
        font-size: 11px;
        border-radius: 6px;
        opacity: 0.9;
      }

      .actions-row {
        display: flex;
        gap: 8px;
        width: 100%;
      }
      
      textarea.ai-input:focus {
        border-color: var(--focus);
        outline: none;
      }
      
      .ai-badge {
        background: linear-gradient(135deg, #6366f1, #a855f7);
        color: white;
        font-size: 10px;
        padding: 2px 6px;
        border-radius: 4px;
        font-weight: bold;
        margin-left: 8px;
        vertical-align: middle;
      }

      /* Buttons */
      .btn {
        appearance: none;
        border: 1px solid color-mix(in srgb, var(--accent) 70%, transparent);
        background: var(--accent);
        color: var(--accent-fg);
        border-radius: 6px;
        padding: 6px 12px;
        font-weight: 600;
        cursor: pointer;
        font-size: 12px;
        transition: background 0.1s;
      }
      .btn:hover { background: var(--accent-hover); }
      .btn:disabled { opacity: .6; cursor: not-allowed; }
      
      .btn.secondary {
        background: transparent;
        color: var(--fg);
        border-color: var(--border);
      }
      .btn.secondary:hover { background: color-mix(in srgb, var(--bg) 82%, transparent); }
      
      .btn.danger {
        background: transparent;
        color: var(--fg);
        border-color: color-mix(in srgb, var(--danger) 80%, transparent);
      }
      .btn.danger:hover { background: color-mix(in srgb, var(--danger) 16%, transparent); }

      /* Feature Grid */
      .features-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
        gap: 16px;
        width: 100%;
        max-width: 500px;
        margin-top: 0;
      }
      
      .feature-card {
        background: var(--card);
        border: 1px solid var(--border);
        border-radius: 12px;
        padding: 16px;
        display: flex;
        flex-direction: column;
        gap: 12px;
        align-items: center;
        text-align: center;
        transition: transform 0.2s;
      }
      
      .feature-card:hover {
        transform: translateY(-2px);
        border-color: var(--focus);
      }

      /* Utility & Layout */
      .row { display: grid; gap: 10px; }
      .row.cols2 { grid-template-columns: 1fr 1fr; }
      .inline { display: flex; align-items: center; gap: 8px; }
      label { display: grid; gap: 6px; font-size: 11px; color: var(--muted); }
      input, select {
        width: 100%; border: 1px solid var(--input-border);
        background: var(--input-bg); color: var(--input-fg);
        border-radius: 6px; padding: 6px 8px; outline: none; font-size: 12px;
      }
      input:focus, select:focus { border-color: var(--focus); }
      
      /* Toast & Log (Hidden by default or minimized) */
      .toast {
        position: fixed; top: 20px; right: 20px; z-index: 300;
        padding: 12px 16px; border-radius: 8px;
        border: 1px solid var(--border);
        background: var(--bg);
        box-shadow: 0 4px 12px rgba(0,0,0,0.2);
        display: none; align-items: center; gap: 12px;
        max-width: 300px;
      }
      .toast.show { display: flex; }
      .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); }
      .dot.ok { background: #2ea043; }
      .dot.bad { background: #f85149; }
      .btn.loading { cursor: progress; opacity: 0.85; }

      .log-section {
        margin-top: 32px;
        border-top: 1px solid var(--border);
        padding-top: 16px;
      }
      .log {
        background: color-mix(in srgb, var(--bg) 50%, transparent);
        border: 1px solid var(--border);
        border-radius: 8px;
        padding: 10px;
        font-family: monospace;
        font-size: 11px;
        height: 120px;
        overflow: auto;
        white-space: pre-wrap;
      }
      
      .overlay {
        position: fixed; inset: 0; display: none; z-index: 100;
      }
      .overlay.show { display: block; }
      .overlayBackdrop { position: absolute; inset: 0; background: rgba(0,0,0,0.4); }
      .drawer {
        position: absolute; top: 10px; right: 10px; bottom: 10px;
        width: min(480px, calc(100vw - 20px));
        border: 1px solid var(--border);
        background: var(--bg);
        border-radius: 12px;
        box-shadow: 0 8px 30px rgba(0,0,0,0.3);
        display: grid; grid-template-rows: auto 1fr;
        overflow: hidden;
      }
      .drawerHeader { padding: 12px 16px; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; }
      .drawerBody { padding: 16px; overflow: auto; display: grid; gap: 16px; }
      
      /* Toggle Switch */
      .toggle { display: inline-flex; align-items: center; gap: 8px; cursor: pointer; }
      .toggle input { width: auto; }
    </style>
  </head>
  <body>
    <div class="wrap" id="mainWrap">
      <noscript>
        <div class="toast show error">
          <div class="dot bad"></div>
          <div><strong>Webview scripts are disabled</strong></div>
        </div>
      </noscript>

      <!-- Toast Notification -->
      <div id="toast" class="toast" role="status">
        <div class="dot" id="toastDot"></div>
        <div style="flex:1">
          <strong id="toastTitle" style="display:block; margin-bottom:2px"></strong>
          <span id="toastBody" style="font-size:11px; color:var(--muted)"></span>
        </div>
        <button class="btn secondary" id="toastClose" type="button" style="padding:2px 6px; font-size:10px" aria-label="Close">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="width:12px; height:12px">
            <path d="M18 6 6 18"></path>
            <path d="M6 6l12 12"></path>
          </svg>
        </button>
      </div>

      <!-- Header -->
      <div class="title">
        <h1>Git Genius <span class="sub">AI-powered Git assistant</span></h1>
        <div class="inline">
          <button class="btn secondary icon-btn" id="openSettingsPanel" type="button">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z"></path>
              <path d="M19.4 15a8.2 8.2 0 0 0 .1-6l-2.1-.4a7 7 0 0 0-1.1-1.9l1.2-1.8a8.2 8.2 0 0 0-5.2-3L11.5 4a7.6 7.6 0 0 0-2.2 0L8.7 1.9a8.2 8.2 0 0 0-5.2 3l1.2 1.8a7 7 0 0 0-1.1 1.9L1.5 9a8.2 8.2 0 0 0 .1 6l2.1.4a7 7 0 0 0 1.1 1.9l-1.2 1.8a8.2 8.2 0 0 0 5.2 3l.6-2.1a7.6 7.6 0 0 0 2.2 0l.6 2.1a8.2 8.2 0 0 0 5.2-3l-1.2-1.8a7 7 0 0 0 1.1-1.9l2.1-.4Z"></path>
            </svg>
            Settings
          </button>
        </div>
      </div>

      <!-- Flow Chart -->
      <div class="flow-container">
        <div class="branch-bar">
          <div class="branch-label">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M7 4v16"></path>
              <path d="M7 7h8a3 3 0 0 1 3 3v10"></path>
              <circle cx="7" cy="4" r="2"></circle>
              <circle cx="7" cy="20" r="2"></circle>
              <circle cx="18" cy="20" r="2"></circle>
            </svg>
            Local branches
          </div>
          <div class="branch-list" id="branchList"></div>
          <button class="btn secondary" data-action="gitStatus" type="button">Refresh</button>
        </div>

        <div class="flow-row" aria-label="Git workflow">
          <div class="flow-step">
            <div class="node" data-step="working">
              <div class="count-badge" id="badge-working" aria-label="Working directory file count"></div>
              <div class="node-header">
                <div class="node-icon">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <path d="M3 7h6l2 2h10v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"></path>
                    <path d="M3 7V5a2 2 0 0 1 2-2h4l2 2"></path>
                  </svg>
                </div>
                <div class="node-title">Working Directory</div>
              </div>
              <div class="file-list" id="workingFileList" role="list" aria-label="Working directory files"></div>
              <div class="node-actions">
                <div class="actions-row">
                  <button class="btn" data-action="stageFiles">Stage</button>
                  <button class="btn secondary" data-action="checkoutFiles">Checkout</button>
                </div>
              </div>
            </div>
          </div>

          <div class="flow-link" data-link="working-staging" aria-hidden="true">
            <svg class="flow-connector" viewBox="0 0 28 100" preserveAspectRatio="none" aria-hidden="true">
              <path class="flow-connector-base" d="M1,50 C9,18 19,82 27,50"></path>
              <path class="flow-connector-flow" d="M1,50 C9,18 19,82 27,50"></path>
            </svg>
          </div>

          <div class="flow-step">
            <div class="node" data-step="staging">
              <div class="count-badge" id="badge-staged" aria-label="Staging area file count"></div>
              <div class="node-header">
                <div class="node-icon">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <path d="M21 16V8a2 2 0 0 0-1-1.7l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.7l7 4a2 2 0 0 0 2 0l7-4a2 2 0 0 0 1-1.7Z"></path>
                    <path d="M3.3 7.3 12 12l8.7-4.7"></path>
                    <path d="M12 22V12"></path>
                  </svg>
                </div>
                <div class="node-title">Staging Area</div>
                <div class="node-status" id="status-stage">Empty</div>
              </div>
              <div class="node-content">
                <div class="textarea-wrap">
                  <textarea id="commit-message-input" class="ai-input" placeholder="Write a commit message, or generate one with AI..."></textarea>
                  <button class="btn secondary expand-btn" id="commitExpand" type="button" aria-label="Expand commit message">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="width:12px; height:12px">
                      <path d="M15 3h6v6"></path>
                      <path d="M9 21H3v-6"></path>
                      <path d="M21 3l-7 7"></path>
                      <path d="M3 21l7-7"></path>
                    </svg>
                  </button>
                </div>
              </div>
              <div class="node-actions">
                <div class="actions-row">
                  <button class="btn" data-action="commitMessage">Generate</button>
                </div>
                <div class="actions-row">
                  <button class="btn secondary" data-action="unstageAll">Unstage</button>
                  <button class="btn" data-action="commitGenerated">Commit</button>
                </div>
              </div>
            </div>
          </div>

          <div class="flow-link" data-link="staging-local" aria-hidden="true">
            <svg class="flow-connector" viewBox="0 0 28 100" preserveAspectRatio="none" aria-hidden="true">
              <path class="flow-connector-base" d="M1,50 C9,18 19,82 27,50"></path>
              <path class="flow-connector-flow" d="M1,50 C9,18 19,82 27,50"></path>
            </svg>
          </div>

          <div class="flow-step">
            <div class="node" data-step="local">
              <div class="node-header">
                <div class="node-icon">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <path d="M3 6h18"></path>
                    <path d="M6 6v14a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V6"></path>
                    <path d="M9 10h6"></path>
                    <path d="M9 14h6"></path>
                  </svg>
                </div>
                <div class="node-title">
                  Local Repo
                </div>
                <div class="node-status" id="status-local">—</div>
              </div>
              <div class="file-list" id="localCommitList" role="list" aria-label="Recent commits"></div>
              <div class="node-actions">
                <button class="btn" data-action="push">Push</button>
              </div>
            </div>
          </div>

          <div class="flow-link" data-link="local-remote" aria-hidden="true">
            <svg class="flow-connector" viewBox="0 0 28 100" preserveAspectRatio="none" aria-hidden="true">
              <path class="flow-connector-base" d="M1,50 C9,18 19,82 27,50"></path>
              <path class="flow-connector-flow" d="M1,50 C9,18 19,82 27,50"></path>
            </svg>
          </div>

          <div class="flow-step">
            <div class="node" data-step="remote">
              <div class="node-header">
                <div class="node-icon">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <path d="M20 17.5a4.5 4.5 0 0 0-2.2-8.4A6 6 0 0 0 6.2 7.4a4.5 4.5 0 0 0 .8 9.0H18"></path>
                    <path d="M12 13v7"></path>
                    <path d="M8.5 16.5 12 13l3.5 3.5"></path>
                  </svg>
                </div>
                <div class="node-title" id="remoteTitle">Remote Repo</div>
                <div class="node-status" id="status-remote">—</div>
              </div>
              <div class="node-actions">
                <button class="btn" data-action="pull">Pull</button>
              </div>
            </div>
          </div>
        </div>

        <!-- Extra Features -->
        <div class="features-grid">
          <div class="feature-card">
            <div class="node-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9"></path>
                <path d="M14 3v6h6"></path>
                <path d="M8 13h8"></path>
                <path d="M8 17h6"></path>
              </svg>
            </div>
            <div class="node-title">Changelog</div>
            <div style="font-size:11px; color:var(--muted)">Generate a changelog</div>
            <button class="btn secondary" data-action="changelog">Generate</button>
          </div>
          <div class="feature-card">
            <div class="node-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M7 4v16"></path>
                <path d="M7 7h7a3 3 0 0 1 3 3v10"></path>
                <path d="M10 17H7"></path>
                <path d="M17 4v2"></path>
                <path d="M15.5 5.5 17 4l1.5 1.5"></path>
              </svg>
            </div>
            <div class="node-title">Pull Request</div>
            <div style="font-size:11px; color:var(--muted)">Generate PR title and description</div>
            <button class="btn secondary" data-action="prDescription">Generate</button>
          </div>
        </div>
      </div>

      <!-- Log Section (Minimized) -->
      <div class="log-section">
        <div class="node-header" style="margin-bottom:8px">
          <div class="node-title" style="font-size:12px">Activity</div>
          <div class="node-status" id="statusText">Idle</div>
          <button class="btn secondary" id="clearLog" style="padding:2px 6px; font-size:10px">Clear</button>
        </div>
        <pre class="log" id="log"></pre>
        <!-- Hidden elements for compatibility -->
        <div style="display:none">
          <span id="runDot"></span><span id="runLabel"></span>
          <span id="statusDot"></span>
          <span id="duration"></span>
          <button id="cancel"></button>
          <textarea id="result"></textarea>
          <button id="copyLog"></button>
          <button id="copyResult"></button>
          <span id="scopeDot"></span><span id="scopeLabel"></span>
        </div>
      </div>
    </div>

    <!-- Settings Overlay -->
    <div class="overlay" id="settingsOverlay" aria-hidden="true">
      <div class="overlayBackdrop" data-close="settings"></div>
      <div class="drawer" role="dialog" aria-modal="true" aria-label="Settings">
        <div class="drawerHeader">
          <h2>Settings</h2>
          <button class="btn secondary" id="settingsClose" type="button">Close</button>
        </div>
        <div class="drawerBody">
          <!-- Settings Content (Simplified) -->
          <div class="row cols2">
            <label>Save to <select id="configTarget"><option value="workspace">Workspace</option><option value="global">Global</option></select></label>
            <div class="inline" style="justify-content:flex-end; align-self:end">
              <button class="btn secondary" id="reload" type="button">Reload</button>
              <button class="btn" id="save" type="button">Save</button>
            </div>
          </div>
          
          <div class="row cols2">
            <label>API Base URL <input id="aiBaseUrl" spellcheck="false" /></label>
            <label>Model <input id="aiModel" spellcheck="false" /></label>
          </div>
          
          <div class="row cols2">
            <label>API Key <input id="aiApiKey" type="password" spellcheck="false" /></label>
            <label>Temperature <input id="aiTemperature" type="number" step="0.1" /></label>
          </div>

          <div class="inline">
            <label class="toggle"><input id="showKey" type="checkbox" /> Show key</label>
            <button class="btn secondary" data-action="testConnection" type="button" style="margin-left:auto">Test connection</button>
          </div>

          <hr style="border:0; border-top:1px solid var(--border); width:100%; margin:8px 0" />
          
          <div class="row cols2">
            <label>Diff Scope <select id="commitDiffScope"><option value="staged">staged</option><option value="workingTree">workingTree</option></select></label>
            <label>Changelog Path <input id="changelogPath" spellcheck="false" /></label>
          </div>
          
          <div class="row cols2">
            <label>PR Platform <select id="prPlatform"><option value="github">github</option><option value="gitlab">gitlab</option><option value="bitbucket">bitbucket</option></select></label>
            <label>PR Base Ref <input id="prBaseRef" spellcheck="false" /></label>
          </div>
          
          <label class="toggle"><input id="prIncludeChecklist" type="checkbox" /> PR Checklist</label>
          
          <hr style="border:0; border-top:1px solid var(--border); width:100%; margin:8px 0" />
          
          <button class="btn secondary" id="openSettings" type="button">Open VS Code Settings UI</button>
        </div>
      </div>
    </div>

    <textarea id="initialJson" style="display:none">${initialJson}</textarea>
    <script nonce="${nonce}" src="${scriptUri.toString()}"></script>
  </body>
</html>`;
}

export function getCommitEditorHtml(
  context: vscode.ExtensionContext,
  webview: vscode.Webview,
  initialMessage: string
): string {
  const nonce = getNonce();
  const initial = getInitialConfig();
  const initialJson = JSON.stringify(initial).replace(/</g, '\\u003c');
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'webview.js'));
  const safeMessage = initialMessage
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https: data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}' ${webview.cspSource};" />
    <title>Commit Message</title>
    <style>
      :root {
        color-scheme: light dark;
        --bg: var(--vscode-editor-background);
        --fg: var(--vscode-foreground);
        --muted: var(--vscode-descriptionForeground);
        --border: color-mix(in srgb, var(--vscode-panel-border) 55%, transparent);
        --input-bg: var(--vscode-input-background);
        --input-fg: var(--vscode-input-foreground);
        --input-border: var(--vscode-input-border);
        --focus: var(--vscode-focusBorder);
        --accent: var(--vscode-button-background);
        --accent-fg: var(--vscode-button-foreground);
        --accent-hover: var(--vscode-button-hoverBackground);
      }

      body { margin: 0; padding: 0; background: var(--bg); color: var(--fg); font-family: var(--vscode-font-family); }
      .wrap { padding: 16px; display: flex; flex-direction: column; gap: 12px; height: 100vh; box-sizing: border-box; }
      h1 { font-size: 14px; margin: 0; font-weight: 600; }
      textarea.ai-input {
        width: 100%;
        flex: 1;
        min-height: 320px;
        background: var(--input-bg);
        border: 1px solid var(--input-border);
        color: var(--input-fg);
        border-radius: 8px;
        padding: 10px;
        font-family: var(--vscode-editor-font-family);
        font-size: 12px;
        resize: both;
        outline: none;
        box-sizing: border-box;
      }
      textarea.ai-input:focus { border-color: var(--focus); }
      .btn {
        appearance: none;
        border: 1px solid color-mix(in srgb, var(--accent) 70%, transparent);
        background: var(--accent);
        color: var(--accent-fg);
        border-radius: 6px;
        padding: 8px 12px;
        font-size: 12px;
        font-weight: 600;
        cursor: pointer;
      }
      .btn:hover { background: var(--accent-hover); }
      .actions { display: flex; gap: 8px; align-items: center; }
      .hint { font-size: 11px; color: var(--muted); }
    </style>
  </head>
  <body>
    <div class="wrap">
      <div style="display:flex; align-items:baseline; justify-content:space-between; gap:12px">
        <h1>Commit Message</h1>
        <div class="hint">Generate uses your configured diff scope</div>
      </div>
      <textarea id="commit-message-input" class="ai-input" placeholder="Write a commit message, or generate one with AI...">${safeMessage}</textarea>
      <div class="actions">
        <button class="btn" data-action="commitMessage" type="button">Generate</button>
      </div>
    </div>

    <textarea id="initialJson" style="display:none">${initialJson}</textarea>
    <script nonce="${nonce}" src="${scriptUri.toString()}"></script>
  </body>
</html>`;
}
