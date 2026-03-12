import * as vscode from 'vscode';
import * as path from 'path';

export function getWorkspaceRoot(): string {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    throw new Error('No workspace folder is open.');
  }
  return folder.uri.fsPath;
}

export function resolveWorkspacePath(root: string, relPath: string): string {
  const rel = String(relPath || '').trim();
  if (!rel) {
    throw new Error('Invalid file path.');
  }
  if (path.isAbsolute(rel)) {
    throw new Error('File path must be relative to the workspace root.');
  }

  const absRoot = path.resolve(root);
  const abs = path.resolve(absRoot, rel);
  const relative = path.relative(absRoot, abs);
  if (!relative || relative === '.' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('File path is outside the workspace root.');
  }

  return abs;
}
