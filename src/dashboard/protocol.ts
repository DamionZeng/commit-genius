export type ConfigTarget = 'workspace' | 'global';

export type DashboardAction =
  | 'commitMessage'
  | 'rewriteCommitMessage'
  | 'changelog'
  | 'prDescription'
  | 'testConnection'
  | 'openSettings'
  | 'gitStatus'
  | 'initGit'
  | 'checkoutBranch'
  | 'openDiff'
  | 'stageFiles'
  | 'checkoutFiles'
  | 'stageAll'
  | 'unstageAll'
  | 'commitGenerated'
  | 'amendGenerated'
  | 'push'
  | 'pull'
  | 'openCommitEditor'
  | 'revert'
  | 'reset'
  | 'commitDetails'
  | 'resetToCommit';

export type WebviewMessage =
  | { type: 'runAction'; action: DashboardAction; payload?: unknown }
  | { type: 'confirmResult'; id: string; ok: boolean }
  | { type: 'promptResult'; id: string; value?: string }
  | { type: 'cancel' }
  | { type: 'saveConfig'; target: ConfigTarget; values: Record<string, unknown> }
  | { type: 'reloadConfig'; target: ConfigTarget };

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function parseWebviewMessage(value: unknown): WebviewMessage | undefined {
  if (!isRecord(value)) return undefined;

  if (value.type === 'runAction') {
    const action = value.action;
    if (
      action === 'commitMessage' ||
      action === 'rewriteCommitMessage' ||
      action === 'changelog' ||
      action === 'prDescription' ||
      action === 'testConnection' ||
      action === 'openSettings' ||
      action === 'gitStatus' ||
      action === 'initGit' ||
      action === 'checkoutBranch' ||
      action === 'openDiff' ||
      action === 'stageFiles' ||
      action === 'checkoutFiles' ||
      action === 'stageAll' ||
      action === 'unstageAll' ||
      action === 'commitGenerated' ||
      action === 'amendGenerated' ||
      action === 'push' ||
      action === 'pull' ||
      action === 'openCommitEditor' ||
      action === 'revert' ||
      action === 'reset' ||
      action === 'commitDetails' ||
      action === 'resetToCommit'
    ) {
      return { type: 'runAction', action, payload: value.payload };
    }
    return undefined;
  }

  if (value.type === 'confirmResult') {
    if (typeof value.id !== 'string') return undefined;
    if (typeof value.ok !== 'boolean') return undefined;
    return { type: 'confirmResult', id: value.id, ok: value.ok };
  }

  if (value.type === 'promptResult') {
    if (typeof value.id !== 'string') return undefined;
    if (value.value !== undefined && typeof value.value !== 'string') return undefined;
    return { type: 'promptResult', id: value.id, value: value.value };
  }

  if (value.type === 'cancel') {
    return { type: 'cancel' };
  }

  if (value.type === 'saveConfig') {
    const target: ConfigTarget = value.target === 'global' ? 'global' : 'workspace';
    if (!isRecord(value.values)) return undefined;
    return { type: 'saveConfig', target, values: value.values };
  }

  if (value.type === 'reloadConfig') {
    const target: ConfigTarget = value.target === 'global' ? 'global' : 'workspace';
    return { type: 'reloadConfig', target };
  }

  return undefined;
}

export function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < 32; i += 1) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}

export type LogLevel = 'info' | 'success' | 'error' | 'warn';

export type PanelToWebviewMessage =
  | { type: 'toast'; level: 'success' | 'error' | 'info'; message: string }
  | {
      type: 'settingsRunState';
      action: 'save' | 'reload';
      state: 'running' | 'idle';
    }
  | { type: 'config'; config: { target: ConfigTarget; values: Record<string, unknown> } }
  | { type: 'runState'; state: 'running' | 'idle'; action?: DashboardAction; durationMs?: number }
  | { type: 'log'; level: LogLevel; message: string }
  | { type: 'streamStart'; action: DashboardAction; title: string }
  | { type: 'streamDelta'; action: DashboardAction; chunk: string }
  | { type: 'branches'; current: string; branches: string[] }
  | { type: 'commits'; commits: Array<{ hash: string; message: string; authorName: string; date: string }> }
  | { type: 'commitDetails'; hash: string; content: string }
  | { type: 'repoState'; state: 'ready' | 'needsInit'; root: string }
  | {
      type: 'workingFiles';
      files: Array<{ path: string; kind: 'modified' | 'untracked' | 'deleted' | 'renamed' | 'other' }>;
    }
  | { type: 'result'; action: DashboardAction; title: string; content: string }
  | { type: 'confirm'; id: string; message: string; confirmLabel: string; cancelLabel: string }
  | {
      type: 'prompt';
      id: string;
      title: string;
      message: string;
      placeholder?: string;
      confirmLabel: string;
      cancelLabel: string;
      expected?: string;
    };

