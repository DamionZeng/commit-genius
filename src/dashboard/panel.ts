import * as vscode from 'vscode';

import { runDashboardAction } from './actions';
import { getCommitEditorHtml, getDashboardHtml } from './html';
import type { DashboardAction, PanelToWebviewMessage } from './protocol';
import { getNonce, parseWebviewMessage } from './protocol';
import { toUserSafeErrorMessage } from './services/aiService';
import { setAiApiKey } from '../utils/config';

export class DashboardPanel {
  static readonly viewType = 'commitGenius.panel';
  static current?: DashboardPanel;

  private abortController?: AbortController;
  private commitEditorPanel?: vscode.WebviewPanel;
  private readonly webviewPanels = new Set<vscode.WebviewPanel>();
  private readonly pendingConfirms = new Map<string, { panel: vscode.WebviewPanel; resolve: (ok: boolean) => void }>();
  private readonly pendingPrompts = new Map<string, { panel: vscode.WebviewPanel; resolve: (value: string | undefined) => void }>();

  private constructor(
    private readonly extensionContext: vscode.ExtensionContext,
    private readonly panel: vscode.WebviewPanel
  ) {
    this.webviewPanels.add(panel);

    panel.onDidDispose(() => {
      try {
        this.abortController?.abort();
      } catch (err) {
        void err;
      }
      try {
        this.commitEditorPanel?.dispose();
      } catch (err) {
        void err;
      }
      for (const [id, pending] of this.pendingConfirms.entries()) {
        if (pending.panel === panel) {
          try {
            pending.resolve(false);
          } catch (err) {
            void err;
          }
          this.pendingConfirms.delete(id);
        }
      }
      for (const [id, pending] of this.pendingPrompts.entries()) {
        if (pending.panel === panel) {
          try {
            pending.resolve(undefined);
          } catch (err) {
            void err;
          }
          this.pendingPrompts.delete(id);
        }
      }
      if (DashboardPanel.current === this) DashboardPanel.current = undefined;
    });

    panel.webview.onDidReceiveMessage((raw) => void this.onMessageFrom(panel, raw));
  }

  static createOrShow(context: vscode.ExtensionContext): void {
    if (DashboardPanel.current) {
      DashboardPanel.current.panel.reveal(vscode.ViewColumn.Active);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      DashboardPanel.viewType,
      'Commit Genius',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: false,
        localResourceRoots: [context.extensionUri, vscode.Uri.joinPath(context.extensionUri, 'media')]
      }
    );

    try {
      panel.webview.options = {
        enableScripts: true,
        localResourceRoots: [context.extensionUri, vscode.Uri.joinPath(context.extensionUri, 'media')]
      };
    } catch (err) {
      void err;
    }

    panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'commit-genius.svg');

    const instance = new DashboardPanel(context, panel);
    DashboardPanel.current = instance;
    panel.webview.html = getDashboardHtml(context, panel.webview);
  }

  private async post(message: PanelToWebviewMessage): Promise<void> {
    for (const panel of this.webviewPanels) {
      try {
        await panel.webview.postMessage(message);
      } catch (err) {
        void err;
      }
    }
  }

  private async postTo(panel: vscode.WebviewPanel, message: PanelToWebviewMessage): Promise<void> {
    try {
      await panel.webview.postMessage(message);
    } catch (err) {
      void err;
    }
  }

  private async onMessageFrom(panel: vscode.WebviewPanel, raw: unknown): Promise<void> {
    const message = parseWebviewMessage(raw);
    if (!message) {
      return;
    }

    if (message.type === 'confirmResult') {
      const pending = this.pendingConfirms.get(message.id);
      if (!pending) return;
      if (pending.panel !== panel) return;
      this.pendingConfirms.delete(message.id);
      try {
        pending.resolve(message.ok);
      } catch (err) {
        void err;
      }
      return;
    }

    if (message.type === 'promptResult') {
      const pending = this.pendingPrompts.get(message.id);
      if (!pending) return;
      if (pending.panel !== panel) return;
      this.pendingPrompts.delete(message.id);
      try {
        pending.resolve(message.value);
      } catch (err) {
        void err;
      }
      return;
    }

    if (message.type === 'cancel') {
      if (!this.abortController) return;
      try {
        this.abortController.abort();
      } catch (err) {
        void err;
      }
      await this.post({ type: 'toast', level: 'success', message: 'Cancel request sent.' });
      return;
    }

    if (message.type === 'saveConfig') {
      const { target, values } = message;

      const configurationTarget =
        target === 'workspace' && vscode.workspace.workspaceFolders?.length
          ? vscode.ConfigurationTarget.Workspace
          : vscode.ConfigurationTarget.Global;

      const c = vscode.workspace.getConfiguration('commitGenius');
      const allowedKeys = new Set([
        'ai.baseUrl',
        'ai.model',
        'ai.temperature',
        'commit.diffScope',
        'changelog.path',
        'pr.platform',
        'pr.baseRef',
        'pr.includeChecklist'
      ]);

      try {
        const rawKey = typeof values['ai.apiKey'] === 'string' ? values['ai.apiKey'] : '';
        if (rawKey && rawKey.trim()) {
          await setAiApiKey(this.extensionContext, rawKey);
        }

        const updates: Array<Thenable<void>> = [];
        for (const [key, value] of Object.entries(values)) {
          if (!allowedKeys.has(key)) continue;
          if (key === 'ai.temperature') {
            const n = typeof value === 'number' ? value : Number(value);
            const safe = Number.isFinite(n) ? Math.min(2, Math.max(0, n)) : 0.2;
            updates.push(c.update(key, safe, configurationTarget));
            continue;
          }
          updates.push(c.update(key, value, configurationTarget));
        }
        await Promise.all(updates);

        await this.post({ type: 'toast', level: 'success', message: 'Settings saved.' });
      } catch (err) {
        const msg = toUserSafeErrorMessage(err);
        await this.post({ type: 'toast', level: 'error', message: msg });
      }
      return;
    }

    if (message.type === 'runAction') {
      await this.runAction(panel, message.action, message.payload);
    }
  }

  private async confirmWithPanel(
    panel: vscode.WebviewPanel,
    message: string,
    confirmLabel: string,
    cancelLabel = 'Cancel'
  ): Promise<boolean> {
    const id = getNonce();
    return await new Promise<boolean>((resolve) => {
      this.pendingConfirms.set(id, { panel, resolve });
      void this.postTo(panel, { type: 'confirm', id, message, confirmLabel, cancelLabel });
    });
  }

  private async promptWithPanel(options: {
    panel: vscode.WebviewPanel;
    title: string;
    message: string;
    placeholder?: string;
    confirmLabel: string;
    cancelLabel?: string;
    expected?: string;
  }): Promise<string | undefined> {
    const id = getNonce();
    return await new Promise<string | undefined>((resolve) => {
      this.pendingPrompts.set(id, { panel: options.panel, resolve });
      void this.postTo(options.panel, {
        type: 'prompt',
        id,
        title: options.title,
        message: options.message,
        placeholder: options.placeholder,
        confirmLabel: options.confirmLabel,
        cancelLabel: options.cancelLabel ?? 'Cancel',
        expected: options.expected
      });
    });
  }

  private async runAction(sourcePanel: vscode.WebviewPanel, action: DashboardAction, payload?: unknown): Promise<void> {
    await runDashboardAction({
      extensionContext: this.extensionContext,
      sourcePanel,
      action,
      payload,
      post: (m) => this.post(m),
      postTo: (p, m) => this.postTo(p, m),
      confirm: (message, confirmLabel) => this.confirmWithPanel(sourcePanel, message, confirmLabel),
      promptWithPanel: (options) => this.promptWithPanel(options),
      openCommitEditor: (initialMessage) => this.openCommitEditor(initialMessage),
      getAbortController: () => this.abortController,
      setAbortController: (c) => {
        this.abortController = c;
      }
    });
  }

  private openCommitEditor(initialMessage: string): void {
    if (this.commitEditorPanel) {
      this.commitEditorPanel.reveal(vscode.ViewColumn.Active);
      try {
        void this.commitEditorPanel.webview.postMessage({
          type: 'result',
          action: 'commitMessage',
          title: 'Commit Message',
          content: initialMessage
        } satisfies PanelToWebviewMessage);
      } catch (err) {
        void err;
      }
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'commitGenius.commitEditor',
      'Commit Message',
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [this.extensionContext.extensionUri, vscode.Uri.joinPath(this.extensionContext.extensionUri, 'media')]
      }
    );

    try {
      panel.webview.options = {
        enableScripts: true,
        localResourceRoots: [this.extensionContext.extensionUri, vscode.Uri.joinPath(this.extensionContext.extensionUri, 'media')]
      };
    } catch (err) {
      void err;
    }

    this.commitEditorPanel = panel;
    this.webviewPanels.add(panel);

    panel.onDidDispose(() => {
      this.webviewPanels.delete(panel);
      for (const [id, pending] of this.pendingConfirms.entries()) {
        if (pending.panel === panel) {
          try {
            pending.resolve(false);
          } catch (err) {
            void err;
          }
          this.pendingConfirms.delete(id);
        }
      }
      for (const [id, pending] of this.pendingPrompts.entries()) {
        if (pending.panel === panel) {
          try {
            pending.resolve(undefined);
          } catch (err) {
            void err;
          }
          this.pendingPrompts.delete(id);
        }
      }
      if (this.commitEditorPanel === panel) this.commitEditorPanel = undefined;
    });

    panel.webview.onDidReceiveMessage((raw) => void this.onMessageFrom(panel, raw));
    panel.webview.html = getCommitEditorHtml(this.extensionContext, panel.webview, initialMessage);
  }
}

