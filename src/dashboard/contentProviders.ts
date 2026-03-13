import * as vscode from 'vscode';

import { createGit } from './services/gitService';
import { getWorkspaceRoot } from '../utils/workspace';

export class GitRefContentProvider implements vscode.TextDocumentContentProvider {
  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    try {
      const q = new URLSearchParams(uri.query);
      const ref = q.get('ref') || 'HEAD';
      const rel = q.get('path') || '';
      const posixPath = rel.replace(/\\/g, '/').replace(/^\/+/, '');
      if (!posixPath || posixPath.split('/').some((p) => p === '..')) {
        return '';
      }
      const root = getWorkspaceRoot();
      const git = createGit(root);
      const out = await git.raw(['show', `${ref}:${posixPath}`]);
      return out ?? '';
    } catch {
      return '';
    }
  }
}

export class EmptyContentProvider implements vscode.TextDocumentContentProvider {
  provideTextDocumentContent(): string {
    return '';
  }
}

