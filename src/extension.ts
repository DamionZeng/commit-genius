import * as vscode from 'vscode';
import * as path from 'path';
import { writeFile } from 'fs/promises';
import { getAdapter } from './adapters';
import { generateCommitMessageCommand } from './commands/generateCommitMessage';
import { generateChangelogCommand } from './commands/generateChangelog';
import { generatePrDescriptionCommand } from './commands/generatePrDescription';
import { chatJson, chatText } from './utils/ai';
import { getConfig } from './utils/config';
import {
  amendWithMessage,
  checkoutLocalBranch,
  commitWithMessage,
  createGit,
  detectBaseRef,
  getCompareDiff,
  getCompareSummary,
  getDiff,
  getHeadBranch,
  getLocalBranches,
  getRecentCommits,
  getStatusSummary,
  pullCurrentBranch,
  pushCurrentBranch,
  resetTo,
  revertCommit,
  stageAll,
  unstageAll
} from './utils/git';
import { changelogPrompt, commitPrompt, prPrompt } from './utils/prompts';
import { getWorkspaceRoot } from './utils/workspace';

type ConfigTarget = 'workspace' | 'global';

type DashboardAction =
  | 'commitMessage'
  | 'changelog'
  | 'prDescription'
  | 'testConnection'
  | 'openSettings'
  | 'gitStatus'
  | 'checkoutBranch'
  | 'openDiff'
  | 'stageAll'
  | 'unstageAll'
  | 'commitGenerated'
  | 'amendGenerated'
  | 'push'
  | 'pull'
  | 'openCommitEditor'
  | 'revert'
  | 'reset';

type WebviewMessage =
  | { type: 'runAction'; action: DashboardAction; payload?: unknown }
  | { type: 'cancel' }
  | { type: 'saveConfig'; target: ConfigTarget; values: Record<string, unknown> };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseWebviewMessage(value: unknown): WebviewMessage | undefined {
  if (!isRecord(value)) return undefined;

  if (value.type === 'runAction') {
    const action = value.action;
    if (
      action === 'commitMessage' ||
      action === 'changelog' ||
      action === 'prDescription' ||
      action === 'testConnection' ||
      action === 'openSettings' ||
      action === 'gitStatus' ||
      action === 'checkoutBranch' ||
      action === 'openDiff' ||
      action === 'stageAll' ||
      action === 'unstageAll' ||
      action === 'commitGenerated' ||
      action === 'amendGenerated' ||
      action === 'push' ||
      action === 'pull' ||
      action === 'openCommitEditor' ||
      action === 'revert' ||
      action === 'reset'
    ) {
      return { type: 'runAction', action, payload: value.payload };
    }
    return undefined;
  }

  if (value.type === 'cancel') {
    return { type: 'cancel' };
  }

  if (value.type === 'saveConfig') {
    const target: ConfigTarget = value.target === 'global' ? 'global' : 'workspace';
    if (!isRecord(value.values)) return undefined;
    return { type: 'saveConfig', target, values: value.values };
  }

  return undefined;
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < 32; i += 1) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}

class GitRefContentProvider implements vscode.TextDocumentContentProvider {
  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    try {
      const q = new URLSearchParams(uri.query);
      const ref = q.get('ref') || 'HEAD';
      const rel = q.get('path') || '';
      const root = getWorkspaceRoot();
      const git = createGit(root);
      const posixPath = rel.replace(/\\/g, '/');
      const out = await git.raw(['show', `${ref}:${posixPath}`]);
      return out ?? '';
    } catch {
      return '';
    }
  }
}

class EmptyContentProvider implements vscode.TextDocumentContentProvider {
  provideTextDocumentContent(): string {
    return '';
  }
}

function getInitialConfig() {
  const c = vscode.workspace.getConfiguration('commitGenius');
  return {
    target: vscode.workspace.workspaceFolders?.length ? ('workspace' as const) : ('global' as const),
    values: {
      'ai.baseUrl': c.get<string>('ai.baseUrl', 'https://api.openai.com/v1'),
      'ai.apiKey': c.get<string>('ai.apiKey', ''),
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

type LogLevel = 'info' | 'success' | 'error' | 'warn';

type PanelToWebviewMessage =
  | { type: 'toast'; level: 'success' | 'error'; message: string }
  | { type: 'runState'; state: 'running' | 'idle'; action?: DashboardAction; durationMs?: number }
  | { type: 'log'; level: LogLevel; message: string }
  | { type: 'branches'; current: string; branches: string[] }
  | {
      type: 'workingFiles';
      files: Array<{ path: string; kind: 'modified' | 'untracked' | 'deleted' | 'renamed' | 'other' }>;
    }
  | { type: 'result'; action: DashboardAction; title: string; content: string };

type PrJson = { title: string; body: string };

function isPrJson(value: unknown): value is PrJson {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.title === 'string' && typeof v.body === 'string';
}

class DashboardPanel {
  static readonly viewType = 'commitGenius.panel';
  static current?: DashboardPanel;

  private abortController?: AbortController;
  private commitEditorPanel?: vscode.WebviewPanel;
  private readonly webviewPanels = new Set<vscode.WebviewPanel>();

  private constructor(
    private readonly context: vscode.ExtensionContext,
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
      if (DashboardPanel.current === this) DashboardPanel.current = undefined;
    });

    panel.webview.onDidReceiveMessage((raw) => this.onMessage(raw));
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
    const html = instance.getHtml(panel.webview);
    panel.webview.html = html;
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

  private async onMessage(raw: unknown): Promise<void> {
    const message = parseWebviewMessage(raw);
    if (!message) {
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
        'ai.apiKey',
        'ai.model',
        'ai.temperature',
        'commit.diffScope',
        'changelog.path',
        'pr.platform',
        'pr.baseRef',
        'pr.includeChecklist'
      ]);

      try {
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
        const msg = err instanceof Error ? err.message : String(err);
        await this.post({ type: 'toast', level: 'error', message: msg });
      }
      return;
    }

    if (message.type === 'runAction') {
      await this.runAction(message.action, message.payload);
    }
  }

  private async runAction(action: DashboardAction, payload?: unknown): Promise<void> {
    if (action === 'openCommitEditor') {
      const initialMessage =
        isRecord(payload) && typeof payload.message === 'string' ? payload.message : '';
      this.openCommitEditor(initialMessage);
      return;
    }

    if (this.abortController) {
      await this.post({
        type: 'toast',
        level: 'error',
        message: 'A task is already running. Cancel it or wait for it to finish.'
      });
      return;
    }

    const startedAt = Date.now();
    this.abortController = new AbortController();

    const log = async (level: LogLevel, text: string) => {
      await this.post({ type: 'log', level, message: text });
    };

    await this.post({ type: 'runState', state: 'running', action });

    try {
      if (action === 'openSettings') {
        await vscode.commands.executeCommand('workbench.action.openSettings');
        await this.post({ type: 'toast', level: 'success', message: 'Opened Settings.' });
        return;
      }

      const root = getWorkspaceRoot();
      const cfg = getConfig();
      const git = createGit(root);

      await log('info', `workspace=${root}`);
      await log('info', `ai.baseUrl=${cfg.ai.baseUrl}`);
      await log('info', `ai.model=${cfg.ai.model}`);

      const renderStatus = async (): Promise<string> => {
        const s = await getStatusSummary(git);
        const tracking = s.tracking ? ` (${s.tracking})` : '';
        const aheadBehind = s.ahead || s.behind ? ` ahead:${s.ahead} behind:${s.behind}` : '';
        const lines = [
          `branch: ${s.current || '(detached)'}${tracking}${aheadBehind}`,
          `staged: ${s.staged}`,
          `modified: ${s.modified}`,
          `untracked: ${s.not_added}`,
          `conflicted: ${s.conflicted}`,
          `created: ${s.created}`,
          `deleted: ${s.deleted}`,
          `renamed: ${s.renamed}`
        ];
        return lines.join('\n');
      };

      const renderBranches = async (): Promise<void> => {
        const b = await getLocalBranches(git);
        await this.post({ type: 'branches', current: b.current, branches: b.all });
      };

      const renderWorkingFiles = async (): Promise<void> => {
        const s = await git.status();
        const files = (s.files ?? [])
          .filter((f) => f.working_dir && f.working_dir !== ' ')
          .slice(0, 200)
          .map((f) => {
            const pathText = String(f.path || '');
            const wd = String(f.working_dir || '');
            const idx = String(f.index || '');
            let kind: 'modified' | 'untracked' | 'deleted' | 'renamed' | 'other' = 'other';
            if (idx === '?' || wd === '?') kind = 'untracked';
            else if (wd === 'D') kind = 'deleted';
            else if (wd === 'R') kind = 'renamed';
            else if (wd !== ' ') kind = 'modified';
            return { path: pathText, kind };
          })
          .filter((f) => f.path);
        await this.post({ type: 'workingFiles', files });
      };

      const confirm = async (message: string, confirmLabel: string): Promise<boolean> => {
        const picked = await vscode.window.showWarningMessage(message, { modal: true }, confirmLabel);
        return picked === confirmLabel;
      };

      if (action === 'testConnection') {
        await log('info', 'calling AI...');
        const text = await chatText(
          cfg.ai,
          [
            { role: 'system', content: 'You are a helpful assistant.' },
            { role: 'user', content: 'Reply with a single word: OK' }
          ],
          { signal: this.abortController.signal, timeoutMs: 60_000 }
        );
        await log('success', 'AI responded.');
        await this.post({ type: 'result', action, title: 'Connection test result', content: text });
        await this.post({ type: 'toast', level: 'success', message: 'Connection test completed.' });
        return;
      }

      if (action === 'gitStatus') {
        const content = await renderStatus();
        await renderBranches();
        await renderWorkingFiles();
        await this.post({ type: 'result', action, title: 'Git Status', content });
        await this.post({ type: 'toast', level: 'success', message: 'Git status refreshed.' });
        return;
      }

      if (action === 'checkoutBranch') {
        if (!isRecord(payload) || typeof payload.branch !== 'string') {
          await this.post({ type: 'toast', level: 'error', message: 'Missing branch parameter.' });
          return;
        }

        await checkoutLocalBranch(git, payload.branch);
        const content = await renderStatus();
        await renderBranches();
        await renderWorkingFiles();
        await this.post({ type: 'result', action: 'gitStatus', title: 'Git Status', content });
        await this.post({ type: 'toast', level: 'success', message: `Switched to branch: ${payload.branch}` });
        return;
      }

      if (action === 'openDiff') {
        if (!isRecord(payload) || typeof payload.path !== 'string' || typeof payload.kind !== 'string') {
          await this.post({ type: 'toast', level: 'error', message: 'Missing diff parameters.' });
          return;
        }

        const relPath = payload.path.trim();
        if (!relPath) {
          await this.post({ type: 'toast', level: 'error', message: 'Invalid file path.' });
          return;
        }

        const abs = path.resolve(root, relPath);
        const rightFile = vscode.Uri.file(abs);

        const makeGitUri = (ref: string): vscode.Uri => {
          const q = new URLSearchParams({ ref, path: relPath }).toString();
          return vscode.Uri.parse(`commit-genius-git:/${encodeURIComponent(relPath)}?${q}`);
        };
        const emptyUri = vscode.Uri.parse(`commit-genius-empty:/${encodeURIComponent(relPath)}`);

        const kind = payload.kind;

        let left = makeGitUri('HEAD');
        let right = rightFile;
        let title = `Diff: ${relPath}`;

        if (kind === 'untracked') {
          left = emptyUri;
          right = rightFile;
          title = `Diff (untracked): ${relPath}`;
        } else if (kind === 'deleted') {
          left = makeGitUri('HEAD');
          right = emptyUri;
          title = `Diff (deleted): ${relPath}`;
        } else {
          left = makeGitUri('HEAD');
          right = rightFile;
        }

        await vscode.commands.executeCommand('vscode.diff', left, right, title);
        return;
      }

      if (action === 'stageAll') {
        await stageAll(git);
        await renderWorkingFiles();
        await this.post({ type: 'result', action, title: 'Staged all changes', content: await renderStatus() });
        await this.post({ type: 'toast', level: 'success', message: 'All changes staged.' });
        return;
      }

      if (action === 'unstageAll') {
        await unstageAll(git);
        await renderWorkingFiles();
        await this.post({ type: 'result', action, title: 'Unstaged changes', content: await renderStatus() });
        await this.post({ type: 'toast', level: 'success', message: 'Unstaged.' });
        return;
      }

      if (action === 'commitMessage') {
        const branch = await getHeadBranch(git);
        await log('info', `branch=${branch}`);
        await log('info', `diffScope=${cfg.commit.diffScope}`);
        const diff = await getDiff(git, cfg.commit.diffScope);

        if (!diff.trim()) {
          await this.post({
            type: 'toast',
            level: 'error',
            message: 'No diff found. Stage changes or switch diff scope.'
          });
          return;
        }

        await log('info', 'calling AI...');
        const message = await chatText(
          cfg.ai,
          [
            { role: 'system', content: 'You are a senior software engineer writing high-quality git commits.' },
            { role: 'user', content: commitPrompt({ diff, branch }) }
          ],
          { signal: this.abortController.signal, timeoutMs: 60_000 }
        );

        await vscode.commands.executeCommand('workbench.view.scm');
        if (vscode.scm?.inputBox) {
          vscode.scm.inputBox.value = message;
          await log('success', 'filled into SCM input box.');
        } else {
          await vscode.env.clipboard.writeText(message);
          await log('warn', 'SCM input box unavailable; copied to clipboard.');
        }

        await this.post({ type: 'result', action, title: 'Commit Message', content: message });
        await this.post({ type: 'toast', level: 'success', message: 'Commit message generated.' });
        return;
      }

      if (action === 'commitGenerated') {
        const status = await getStatusSummary(git);
        if (status.staged === 0) {
          await this.post({
            type: 'toast',
            level: 'error',
            message: 'No staged changes. Stage changes before committing.'
          });
          return;
        }

        let message: string;

        if (isRecord(payload) && typeof payload.message === 'string' && payload.message.trim()) {
          message = payload.message;
        } else {
          const branch = await getHeadBranch(git);
          await log('info', `branch=${branch}`);
          const diff = await getDiff(git, 'staged');
          if (!diff.trim()) {
            await this.post({ type: 'toast', level: 'error', message: 'No staged diff found. Stage changes first.' });
            return;
          }

          await log('info', 'calling AI...');
          message = await chatText(
            cfg.ai,
            [
              { role: 'system', content: 'You are a senior software engineer writing high-quality git commits.' },
              { role: 'user', content: commitPrompt({ diff, branch }) }
            ],
            { signal: this.abortController.signal, timeoutMs: 60_000 }
          );
        }

        const ok = await confirm('Commit changes?', 'Commit');
        if (!ok) {
          await this.post({ type: 'toast', level: 'success', message: 'Commit cancelled.' });
          return;
        }

        const hash = await commitWithMessage(git, message);
        await vscode.env.clipboard.writeText(message);

        await this.post({
          type: 'result',
          action,
          title: hash ? `Committed ${hash.slice(0, 7)}` : 'Committed',
          content: `${message.trimEnd()}\n\n${await renderStatus()}`
        });
        await this.post({ type: 'toast', level: 'success', message: 'Committed.' });
        return;
      }

      if (action === 'amendGenerated') {
        const status = await getStatusSummary(git);
        if (status.staged === 0) {
          await this.post({
            type: 'toast',
            level: 'error',
            message: 'No staged changes. Stage changes before amending.'
          });
          return;
        }

        let message: string;

        if (isRecord(payload) && typeof payload.message === 'string' && payload.message.trim()) {
          message = payload.message;
        } else {
          const branch = await getHeadBranch(git);
          await log('info', `branch=${branch}`);
          const diff = await getDiff(git, 'staged');
          if (!diff.trim()) {
            await this.post({ type: 'toast', level: 'error', message: 'No staged diff found. Stage changes first.' });
            return;
          }

          await log('info', 'calling AI...');
          message = await chatText(
            cfg.ai,
            [
              { role: 'system', content: 'You are a senior software engineer writing high-quality git commits.' },
              { role: 'user', content: commitPrompt({ diff, branch }) }
            ],
            { signal: this.abortController.signal, timeoutMs: 60_000 }
          );
        }

        const ok = await confirm('Amend the last commit?', 'Amend');
        if (!ok) {
          await this.post({ type: 'toast', level: 'success', message: 'Amend cancelled.' });
          return;
        }

        const hash = await amendWithMessage(git, message);
        await vscode.env.clipboard.writeText(message);

        await this.post({
          type: 'result',
          action,
          title: hash ? `Amended ${hash.slice(0, 7)}` : 'Amended',
          content: `${message.trimEnd()}\n\n${await renderStatus()}`
        });
        await this.post({ type: 'toast', level: 'success', message: 'Amended.' });
        return;
      }

      if (action === 'push') {
        const ok = await confirm('Push the current branch to origin?', 'Push');
        if (!ok) {
          await this.post({ type: 'toast', level: 'success', message: 'Push cancelled.' });
          return;
        }

        await pushCurrentBranch(git);
        await this.post({ type: 'result', action, title: 'Pushed', content: await renderStatus() });
        await this.post({ type: 'toast', level: 'success', message: 'Pushed.' });
        return;
      }

      if (action === 'pull') {
        const ok = await confirm('Pull the current branch from origin?', 'Pull');
        if (!ok) {
          await this.post({ type: 'toast', level: 'success', message: 'Pull cancelled.' });
          return;
        }

        await pullCurrentBranch(git);
        await this.post({ type: 'result', action, title: 'Pulled', content: await renderStatus() });
        await this.post({ type: 'toast', level: 'success', message: 'Pulled.' });
        return;
      }

      if (action === 'revert') {
        const commits = await getRecentCommits(git, 30);
        if (commits.length === 0) {
          await this.post({ type: 'toast', level: 'error', message: 'No commits found in this repo.' });
          return;
        }

        const picked = await vscode.window.showQuickPick(
          commits.map((c) => ({
            label: `${c.hash.slice(0, 7)} ${c.message}`,
            description: `${c.authorName} · ${c.date}`,
            hash: c.hash
          })),
          { title: 'Select a commit to revert (creates a new revert commit)' }
        );
        if (!picked) {
          await this.post({ type: 'toast', level: 'success', message: 'Revert cancelled.' });
          return;
        }

        const ok = await confirm(`Revert: ${picked.label}?`, 'Revert');
        if (!ok) {
          await this.post({ type: 'toast', level: 'success', message: 'Revert cancelled.' });
          return;
        }

        await revertCommit(git, picked.hash);
        await this.post({ type: 'result', action, title: 'Reverted', content: await renderStatus() });
        await this.post({ type: 'toast', level: 'success', message: 'Reverted.' });
        return;
      }

      if (action === 'reset') {
        const option = await vscode.window.showQuickPick(
          [
            { label: 'Undo last commit (keep changes)', mode: 'soft' as const, ref: 'HEAD~1', dangerous: false },
            { label: 'Undo last commit (unstage changes)', mode: 'mixed' as const, ref: 'HEAD~1', dangerous: false },
            { label: 'Hard reset last commit (discard changes)', mode: 'hard' as const, ref: 'HEAD~1', dangerous: true },
            { label: 'Reset to a specific commit…', mode: undefined, ref: undefined, dangerous: true }
          ],
          { title: 'Reset (be careful)' }
        );
        if (!option) {
          await this.post({ type: 'toast', level: 'success', message: 'Reset cancelled.' });
          return;
        }

        let mode: 'soft' | 'mixed' | 'hard';
        let ref: string;

        if (option.mode && option.ref) {
          mode = option.mode;
          ref = option.ref;
        } else {
          const commits = await getRecentCommits(git, 30);
          if (commits.length === 0) {
            await this.post({ type: 'toast', level: 'error', message: 'No commits found in this repo.' });
            return;
          }

          const target = await vscode.window.showQuickPick(
            commits.map((c) => ({
              label: `${c.hash.slice(0, 7)} ${c.message}`,
              description: `${c.authorName} · ${c.date}`,
              hash: c.hash
            })),
            { title: 'Select a reset target (HEAD will move to this commit)' }
          );
          if (!target) {
            await this.post({ type: 'toast', level: 'success', message: 'Reset cancelled.' });
            return;
          }
          ref = target.hash;

          const modePick = await vscode.window.showQuickPick(
            [
              { label: 'soft (keep changes)', mode: 'soft' as const, dangerous: false },
              { label: 'mixed (unstage changes)', mode: 'mixed' as const, dangerous: false },
              { label: 'hard (discard changes)', mode: 'hard' as const, dangerous: true }
            ],
            { title: 'Select a reset mode' }
          );
          if (!modePick) {
            await this.post({ type: 'toast', level: 'success', message: 'Reset cancelled.' });
            return;
          }
          mode = modePick.mode;
          option.dangerous = modePick.dangerous;
        }

        if (mode === 'hard') {
          const token = await vscode.window.showInputBox({
            title: 'Dangerous action confirmation',
            prompt: 'Hard reset will discard changes. Type RESET to continue.',
            placeHolder: 'RESET',
            ignoreFocusOut: true
          });
          if (token !== 'RESET') {
            await this.post({ type: 'toast', level: 'success', message: 'Hard reset cancelled.' });
            return;
          }
        } else {
          const ok = await confirm(`Run: git reset --${mode} ${ref}?`, 'Continue');
          if (!ok) {
            await this.post({ type: 'toast', level: 'success', message: 'Reset cancelled.' });
            return;
          }
        }

        await resetTo(git, mode, ref);
        await this.post({ type: 'result', action, title: `Reset --${mode}`, content: await renderStatus() });
        await this.post({ type: 'toast', level: 'success', message: 'Reset complete.' });
        return;
      }

      if (action === 'changelog') {
        const commits = await getRecentCommits(git, 200);
        if (commits.length === 0) {
          await this.post({ type: 'toast', level: 'error', message: 'No commits found in this repo.' });
          return;
        }

        const commitLines = commits.map((c) => `${c.hash.slice(0, 7)} ${c.message}`);
        await log('info', `commits=${commits.length}`);
        await log('info', 'calling AI...');

        const markdown = await chatText(
          cfg.ai,
          [
            { role: 'system', content: 'You generate clean, useful changelogs for developers.' },
            { role: 'user', content: changelogPrompt({ commits: commitLines }) }
          ],
          { signal: this.abortController.signal, timeoutMs: 60_000 }
        );

        const outPath = path.resolve(root, cfg.changelog.path);
        await writeFile(outPath, markdown.trimEnd() + '\n', 'utf8');
        await log('success', `written=${cfg.changelog.path}`);

        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(outPath));
        await vscode.window.showTextDocument(doc, { preview: false });

        await this.post({ type: 'result', action, title: `CHANGELOG (${cfg.changelog.path})`, content: markdown.trimEnd() });
        await this.post({ type: 'toast', level: 'success', message: 'CHANGELOG generated.' });
        return;
      }

      if (action === 'prDescription') {
        const branch = await getHeadBranch(git);
        const baseRef = cfg.pr.baseRef?.trim() ? cfg.pr.baseRef.trim() : await detectBaseRef(git);
        await log('info', `branch=${branch}`);
        await log('info', `baseRef=${baseRef}`);

        const diff = await getCompareDiff(git, baseRef);
        if (!diff.trim()) {
          await this.post({ type: 'toast', level: 'error', message: `No difference between ${baseRef} and HEAD.` });
          return;
        }

        await log('info', 'building summary...');
        const summary = await getCompareSummary(git, baseRef);
        await log('info', 'calling AI...');

        const draft = await chatJson<PrJson>(
          cfg.ai,
          [
            { role: 'system', content: 'You write clear, reviewer-friendly pull request descriptions.' },
            { role: 'user', content: prPrompt({ baseRef, branch, summary, diff }) }
          ],
          isPrJson,
          { signal: this.abortController.signal, timeoutMs: 60_000 }
        );

        const adapter = getAdapter(cfg.pr.platform);
        const formatted = adapter.formatDraft(
          { title: draft.title.trim(), body: draft.body.trim() },
          { includeChecklist: cfg.pr.includeChecklist }
        );

        const clipboardText = `# ${formatted.title}\n\n${formatted.body}\n`;
        await vscode.env.clipboard.writeText(clipboardText);
        await log('success', 'copied to clipboard.');

        await this.post({ type: 'result', action, title: 'PR Description (copied)', content: clipboardText.trimEnd() });
        await this.post({ type: 'toast', level: 'success', message: 'PR description generated and copied to clipboard.' });
        return;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await log('error', msg);
      await this.post({ type: 'toast', level: 'error', message: msg });
    } finally {
      this.abortController = undefined;
      await this.post({ type: 'runState', state: 'idle', action, durationMs: Date.now() - startedAt });
    }
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const initial = getInitialConfig();
    const initialJson = JSON.stringify(initial).replace(/</g, '\\u003c');
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'webview.js'));

    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https: data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}' ${webview.cspSource};" />
    <title>Commit Genius</title>
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
      }

      .wrap { padding: 20px; max-width: 1100px; margin: 0 auto; }
      
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
      }
      .flow-link::before {
        content: '';
        position: absolute;
        left: 50%;
        top: 50%;
        width: 100%;
        height: 2px;
        transform: translate(-50%, -50%);
        background: color-mix(in srgb, var(--border) 70%, transparent);
        border-radius: 999px;
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
        width: 100%;
        min-width: 0;
      }
      .file-item:hover {
        border-color: color-mix(in srgb, var(--focus) 60%, transparent);
        background: color-mix(in srgb, var(--bg) 78%, transparent);
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
        .flow-link { width: 100%; height: 18px; }
        .flow-link::before {
          width: 2px;
          height: 100%;
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
        position: fixed; top: 20px; right: 20px; z-index: 100;
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
    <div class="wrap">
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
        <h1>Commit Genius <span class="sub">AI-powered Git assistant</span></h1>
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
                <button class="btn" data-action="stageAll">Stage</button>
              </div>
            </div>
          </div>

          <div class="flow-link" aria-hidden="true"></div>

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

          <div class="flow-link" aria-hidden="true"></div>

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
              <div class="node-actions">
                <button class="btn" data-action="push">Push</button>
              </div>
            </div>
          </div>

          <div class="flow-link" aria-hidden="true"></div>

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
                <div class="node-title">Remote Repo</div>
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
        localResourceRoots: [this.context.extensionUri, vscode.Uri.joinPath(this.context.extensionUri, 'media')]
      }
    );

    try {
      panel.webview.options = {
        enableScripts: true,
        localResourceRoots: [this.context.extensionUri, vscode.Uri.joinPath(this.context.extensionUri, 'media')]
      };
    } catch (err) {
      void err;
    }

    this.commitEditorPanel = panel;
    this.webviewPanels.add(panel);

    panel.onDidDispose(() => {
      this.webviewPanels.delete(panel);
      if (this.commitEditorPanel === panel) this.commitEditorPanel = undefined;
    });

    panel.webview.onDidReceiveMessage((raw) => this.onMessage(raw));
    panel.webview.html = this.getCommitEditorHtml(panel.webview, initialMessage);
  }

  private getCommitEditorHtml(webview: vscode.Webview, initialMessage: string): string {
    const nonce = getNonce();
    const initial = getInitialConfig();
    const initialJson = JSON.stringify(initial).replace(/</g, '\\u003c');
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'webview.js'));
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
}

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider('commit-genius-git', new GitRefContentProvider()),
    vscode.workspace.registerTextDocumentContentProvider('commit-genius-empty', new EmptyContentProvider()),
    vscode.commands.registerCommand('commitGenius.generateCommitMessage', generateCommitMessageCommand),
    vscode.commands.registerCommand('commitGenius.generateChangelog', generateChangelogCommand),
    vscode.commands.registerCommand('commitGenius.generatePrDescription', generatePrDescriptionCommand),
    vscode.commands.registerCommand('commitGenius.openPanel', () => DashboardPanel.createOrShow(context))
  );
}

export function deactivate() {
}
