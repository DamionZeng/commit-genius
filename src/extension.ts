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
  commitWithMessage,
  createGit,
  detectBaseRef,
  getCompareDiff,
  getCompareSummary,
  getDiff,
  getHeadBranch,
  getRecentCommits,
  getStatusSummary,
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
  | 'stageAll'
  | 'unstageAll'
  | 'commitGenerated'
  | 'amendGenerated'
  | 'push'
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
      action === 'stageAll' ||
      action === 'unstageAll' ||
      action === 'commitGenerated' ||
      action === 'amendGenerated' ||
      action === 'push' ||
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

  private constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly panel: vscode.WebviewPanel
  ) {
    panel.onDidDispose(() => {
      try {
        this.abortController?.abort();
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
    try {
      await this.panel.webview.postMessage(message);
    } catch (err) {
      void err;
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
      await this.post({ type: 'toast', level: 'success', message: '已发送取消请求。' });
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

        await this.post({ type: 'toast', level: 'success', message: '设置已保存。' });
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
    if (this.abortController) {
      await this.post({ type: 'toast', level: 'error', message: '已有任务正在运行，请先取消或等待完成。' });
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
        await this.post({ type: 'toast', level: 'success', message: '已打开 Settings。' });
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
        await this.post({ type: 'result', action, title: '连接测试结果', content: text });
        await this.post({ type: 'toast', level: 'success', message: '连接测试完成。' });
        return;
      }

      if (action === 'gitStatus') {
        const content = await renderStatus();
        await this.post({ type: 'result', action, title: 'Git Status', content });
        await this.post({ type: 'toast', level: 'success', message: '已获取 Git 状态。' });
        return;
      }

      if (action === 'stageAll') {
        await stageAll(git);
        await this.post({ type: 'result', action, title: '已暂存所有改动', content: await renderStatus() });
        await this.post({ type: 'toast', level: 'success', message: '已暂存所有改动。' });
        return;
      }

      if (action === 'unstageAll') {
        await unstageAll(git);
        await this.post({ type: 'result', action, title: '已取消暂存', content: await renderStatus() });
        await this.post({ type: 'toast', level: 'success', message: '已取消暂存。' });
        return;
      }

      if (action === 'commitMessage') {
        const branch = await getHeadBranch(git);
        await log('info', `branch=${branch}`);
        await log('info', `diffScope=${cfg.commit.diffScope}`);
        const diff = await getDiff(git, cfg.commit.diffScope);

        if (!diff.trim()) {
          await this.post({ type: 'toast', level: 'error', message: '未发现 diff：请先暂存改动或切换 diff scope。' });
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
        await this.post({ type: 'toast', level: 'success', message: '已生成 Commit Message。' });
        return;
      }

      if (action === 'commitGenerated') {
        const status = await getStatusSummary(git);
        if (status.staged === 0) {
          await this.post({ type: 'toast', level: 'error', message: '没有暂存区改动：请先暂存改动再提交。' });
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
            await this.post({ type: 'toast', level: 'error', message: '未发现暂存区 diff：请先暂存改动。' });
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

        const ok = await confirm('确认提交？', '提交');
        if (!ok) {
          await this.post({ type: 'toast', level: 'success', message: '已取消提交。' });
          return;
        }

        const hash = await commitWithMessage(git, message);
        await vscode.env.clipboard.writeText(message);

        await this.post({
          type: 'result',
          action,
          title: hash ? `已提交 ${hash.slice(0, 7)}` : '已提交',
          content: `${message.trimEnd()}\n\n${await renderStatus()}`
        });
        await this.post({ type: 'toast', level: 'success', message: '已提交。' });
        return;
      }

      if (action === 'amendGenerated') {
        const status = await getStatusSummary(git);
        if (status.staged === 0) {
          await this.post({ type: 'toast', level: 'error', message: '没有暂存区改动：请先暂存改动再 amend。' });
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
            await this.post({ type: 'toast', level: 'error', message: '未发现暂存区 diff：请先暂存改动。' });
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

        const ok = await confirm('确认 Amend？', 'Amend');
        if (!ok) {
          await this.post({ type: 'toast', level: 'success', message: '已取消 amend。' });
          return;
        }

        const hash = await amendWithMessage(git, message);
        await vscode.env.clipboard.writeText(message);

        await this.post({
          type: 'result',
          action,
          title: hash ? `已 amend ${hash.slice(0, 7)}` : '已 amend',
          content: `${message.trimEnd()}\n\n${await renderStatus()}`
        });
        await this.post({ type: 'toast', level: 'success', message: '已 amend。' });
        return;
      }

      if (action === 'push') {
        const ok = await confirm('将推送当前分支到 origin。继续？', '推送');
        if (!ok) {
          await this.post({ type: 'toast', level: 'success', message: '已取消推送。' });
          return;
        }

        await pushCurrentBranch(git);
        await this.post({ type: 'result', action, title: '已推送', content: await renderStatus() });
        await this.post({ type: 'toast', level: 'success', message: '已推送。' });
        return;
      }

      if (action === 'revert') {
        const commits = await getRecentCommits(git, 30);
        if (commits.length === 0) {
          await this.post({ type: 'toast', level: 'error', message: '仓库里没有可用的 commit。' });
          return;
        }

        const picked = await vscode.window.showQuickPick(
          commits.map((c) => ({
            label: `${c.hash.slice(0, 7)} ${c.message}`,
            description: `${c.authorName} · ${c.date}`,
            hash: c.hash
          })),
          { title: '选择要 revert 的提交（将生成一个新的 revert commit）' }
        );
        if (!picked) {
          await this.post({ type: 'toast', level: 'success', message: '已取消 revert。' });
          return;
        }

        const ok = await confirm(`将 revert：${picked.label}。继续？`, 'Revert');
        if (!ok) {
          await this.post({ type: 'toast', level: 'success', message: '已取消 revert。' });
          return;
        }

        await revertCommit(git, picked.hash);
        await this.post({ type: 'result', action, title: '已 revert', content: await renderStatus() });
        await this.post({ type: 'toast', level: 'success', message: '已 revert。' });
        return;
      }

      if (action === 'reset') {
        const option = await vscode.window.showQuickPick(
          [
            { label: '撤回上一次提交（保留更改）', mode: 'soft' as const, ref: 'HEAD~1', dangerous: false },
            { label: '撤回上一次提交（取消暂存）', mode: 'mixed' as const, ref: 'HEAD~1', dangerous: false },
            { label: '强制回退上一次提交（丢弃更改）', mode: 'hard' as const, ref: 'HEAD~1', dangerous: true },
            { label: '选择回退到某个提交…', mode: undefined, ref: undefined, dangerous: true }
          ],
          { title: 'Reset 操作（请谨慎）' }
        );
        if (!option) {
          await this.post({ type: 'toast', level: 'success', message: '已取消 reset。' });
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
            await this.post({ type: 'toast', level: 'error', message: '仓库里没有可用的 commit。' });
            return;
          }

          const target = await vscode.window.showQuickPick(
            commits.map((c) => ({
              label: `${c.hash.slice(0, 7)} ${c.message}`,
              description: `${c.authorName} · ${c.date}`,
              hash: c.hash
            })),
            { title: '选择 reset 目标（HEAD 将移动到该提交）' }
          );
          if (!target) {
            await this.post({ type: 'toast', level: 'success', message: '已取消 reset。' });
            return;
          }
          ref = target.hash;

          const modePick = await vscode.window.showQuickPick(
            [
              { label: 'soft（保留更改）', mode: 'soft' as const, dangerous: false },
              { label: 'mixed（取消暂存）', mode: 'mixed' as const, dangerous: false },
              { label: 'hard（丢弃更改）', mode: 'hard' as const, dangerous: true }
            ],
            { title: '选择 reset 模式' }
          );
          if (!modePick) {
            await this.post({ type: 'toast', level: 'success', message: '已取消 reset。' });
            return;
          }
          mode = modePick.mode;
          option.dangerous = modePick.dangerous;
        }

        if (mode === 'hard') {
          const token = await vscode.window.showInputBox({
            title: '危险操作确认',
            prompt: 'hard reset 会丢弃更改。输入 RESET 确认继续',
            placeHolder: 'RESET',
            ignoreFocusOut: true
          });
          if (token !== 'RESET') {
            await this.post({ type: 'toast', level: 'success', message: '已取消 hard reset。' });
            return;
          }
        } else {
          const ok = await confirm(`将执行：git reset --${mode} ${ref}。继续？`, '继续');
          if (!ok) {
            await this.post({ type: 'toast', level: 'success', message: '已取消 reset。' });
            return;
          }
        }

        await resetTo(git, mode, ref);
        await this.post({ type: 'result', action, title: `已 reset --${mode}`, content: await renderStatus() });
        await this.post({ type: 'toast', level: 'success', message: '已 reset。' });
        return;
      }

      if (action === 'changelog') {
        const commits = await getRecentCommits(git, 200);
        if (commits.length === 0) {
          await this.post({ type: 'toast', level: 'error', message: '仓库里没有可用的 commit。' });
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
        await this.post({ type: 'toast', level: 'success', message: '已生成 CHANGELOG。' });
        return;
      }

      if (action === 'prDescription') {
        const branch = await getHeadBranch(git);
        const baseRef = cfg.pr.baseRef?.trim() ? cfg.pr.baseRef.trim() : await detectBaseRef(git);
        await log('info', `branch=${branch}`);
        await log('info', `baseRef=${baseRef}`);

        const diff = await getCompareDiff(git, baseRef);
        if (!diff.trim()) {
          await this.post({ type: 'toast', level: 'error', message: `未发现 ${baseRef} 与 HEAD 的差异。` });
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
        await this.post({ type: 'toast', level: 'success', message: '已生成 PR 描述并复制到剪贴板。' });
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
<html lang="zh-CN">
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

      .wrap { padding: 20px; max-width: 800px; margin: 0 auto; }
      
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

      /* Flow Chart Styles */
      .flow-container {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 0;
        margin-bottom: 32px;
      }
      
      .node-wrapper {
        width: 100%;
        max-width: 500px;
        position: relative;
        z-index: 1;
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
        font-size: 20px;
        width: 36px;
        height: 36px;
        display: flex;
        align-items: center;
        justify-content: center;
        background: color-mix(in srgb, var(--bg) 50%, transparent);
        border-radius: 8px;
      }
      
      .node-title {
        font-size: 14px;
        font-weight: 600;
        flex: 1;
      }
      
      .node-status {
        font-size: 11px;
        color: var(--muted);
        background: color-mix(in srgb, var(--bg) 80%, transparent);
        padding: 2px 8px;
        border-radius: 99px;
      }

      .node-actions {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
        margin-top: 4px;
      }

      .connector {
        width: 2px;
        height: 32px;
        background: var(--border);
        position: relative;
        overflow: hidden;
      }
      
      .connector::after {
        content: '';
        position: absolute;
        top: -100%;
        left: 0;
        width: 100%;
        height: 100%;
        background: linear-gradient(to bottom, transparent, var(--accent), transparent);
        animation: flow 1.5s infinite linear;
      }
      
      @keyframes flow {
        0% { top: -100%; }
        100% { top: 100%; }
      }

      /* AI Input Area */
      textarea.ai-input {
        width: 100%;
        min-height: 80px;
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
          <div><strong>Webview 脚本未启用</strong></div>
        </div>
      </noscript>

      <!-- Toast Notification -->
      <div id="toast" class="toast" role="status">
        <div class="dot" id="toastDot"></div>
        <div style="flex:1">
          <strong id="toastTitle" style="display:block; margin-bottom:2px"></strong>
          <span id="toastBody" style="font-size:11px; color:var(--muted)"></span>
        </div>
        <button class="btn secondary" id="toastClose" type="button" style="padding:2px 6px; font-size:10px">✕</button>
      </div>

      <!-- Header -->
      <div class="title">
        <h1>Commit Genius <span class="sub">AI 驱动的 Git 助手</span></h1>
        <div class="inline">
          <button class="btn secondary" id="openSettingsPanel" type="button">⚙ 设置</button>
        </div>
      </div>

      <!-- Flow Chart -->
      <div class="flow-container">
        <!-- Step 1: Workspace -->
        <div class="node-wrapper">
          <div class="node">
            <div class="node-header">
              <div class="node-icon">📂</div>
              <div class="node-title">工作区 (Working Directory)</div>
              <div class="node-status" id="status-workspace">检测中...</div>
            </div>
            <div class="node-actions">
              <button class="btn" data-action="stageAll">全部暂存</button>
              <button class="btn secondary" data-action="gitStatus">刷新状态</button>
            </div>
          </div>
        </div>

        <div class="connector"></div>

        <!-- Step 2: Staging -->
        <div class="node-wrapper">
          <div class="node">
            <div class="node-header">
              <div class="node-icon">📦</div>
              <div class="node-title">暂存区 (Staging Area)</div>
              <div class="node-status" id="status-stage">未暂存</div>
            </div>
            <div class="node-actions">
              <button class="btn secondary" data-action="unstageAll">取消暂存</button>
            </div>
          </div>
        </div>

        <div class="connector"></div>

        <!-- Step 3: Commit Message -->
        <div class="node-wrapper">
          <div class="node" style="border-color: var(--focus);">
            <div class="node-header">
              <div class="node-icon">🤖</div>
              <div class="node-title">
                提交信息 (Commit Message)
                <span class="ai-badge">AI Powered</span>
              </div>
            </div>
            <div class="node-content">
              <textarea id="commit-message-input" class="ai-input" placeholder="在此输入提交信息，或点击下方按钮使用 AI 生成..."></textarea>
            </div>
            <div class="node-actions">
              <button class="btn" data-action="commitMessage">✨ AI 生成消息</button>
              <button class="btn" data-action="commitGenerated">提交 (Commit)</button>
              <button class="btn secondary" data-action="amendGenerated">Amend</button>
            </div>
          </div>
        </div>

        <div class="connector"></div>

        <!-- Step 4: Remote -->
        <div class="node-wrapper">
          <div class="node">
            <div class="node-header">
              <div class="node-icon">🚀</div>
              <div class="node-title">远程仓库 (Remote)</div>
            </div>
            <div class="node-actions">
              <button class="btn" data-action="push">推送 (Push)</button>
              <button class="btn danger" data-action="revert">Revert</button>
              <button class="btn danger" data-action="reset">Reset</button>
            </div>
          </div>
        </div>

        <!-- Extra Features -->
        <div class="features-grid">
          <div class="feature-card">
            <div class="node-icon">📝</div>
            <div class="node-title">Changelog</div>
            <div style="font-size:11px; color:var(--muted)">自动生成更新日志</div>
            <button class="btn secondary" data-action="changelog">✨ 生成日志</button>
          </div>
          <div class="feature-card">
            <div class="node-icon">🔀</div>
            <div class="node-title">Pull Request</div>
            <div style="font-size:11px; color:var(--muted)">生成 PR 标题和描述</div>
            <button class="btn secondary" data-action="prDescription">✨ 生成 PR 描述</button>
          </div>
        </div>
      </div>

      <!-- Log Section (Minimized) -->
      <div class="log-section">
        <div class="node-header" style="margin-bottom:8px">
          <div class="node-title" style="font-size:12px">运行日志</div>
          <div class="node-status" id="statusText">空闲</div>
          <button class="btn secondary" id="clearLog" style="padding:2px 6px; font-size:10px">清空</button>
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
      <div class="drawer" role="dialog" aria-modal="true" aria-label="设置">
        <div class="drawerHeader">
          <h2>设置</h2>
          <button class="btn secondary" id="settingsClose" type="button">关闭</button>
        </div>
        <div class="drawerBody">
          <!-- Settings Content (Simplified) -->
          <div class="row cols2">
            <label>保存位置 <select id="configTarget"><option value="workspace">工作区</option><option value="global">全局</option></select></label>
            <div class="inline" style="justify-content:flex-end; align-self:end">
              <button class="btn secondary" id="reload" type="button">重载</button>
              <button class="btn" id="save" type="button">保存</button>
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
            <label class="toggle"><input id="showKey" type="checkbox" /> 显示 Key</label>
            <button class="btn secondary" data-action="testConnection" type="button" style="margin-left:auto">测试连接</button>
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
          
          <button class="btn secondary" id="openSettings" type="button">打开 VS Code Settings UI</button>
        </div>
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
    vscode.commands.registerCommand('commitGenius.generateCommitMessage', generateCommitMessageCommand),
    vscode.commands.registerCommand('commitGenius.generateChangelog', generateChangelogCommand),
    vscode.commands.registerCommand('commitGenius.generatePrDescription', generatePrDescriptionCommand),
    vscode.commands.registerCommand('commitGenius.openPanel', () => DashboardPanel.createOrShow(context))
  );
}

export function deactivate() {
}
