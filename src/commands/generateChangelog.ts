import * as vscode from 'vscode';
import * as path from 'path';
import { writeFile } from 'fs/promises';
import { chatText } from '../utils/ai';
import { getConfig } from '../utils/config';
import { createGit, getRecentCommits } from '../utils/git';
import { changelogPrompt } from '../utils/prompts';
import { getWorkspaceRoot } from '../utils/workspace';

export async function generateChangelogCommand(): Promise<void> {
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Commit Genius: Generating CHANGELOG' },
    async () => {
      try {
        const root = getWorkspaceRoot();
        const cfg = getConfig();
        const git = createGit(root);
        const commits = await getRecentCommits(git, 200);

        if (commits.length === 0) {
          await vscode.window.showWarningMessage('No commits found in this repository.');
          return;
        }

        const commitLines = commits.map((c) => `${c.hash.slice(0, 7)} ${c.message}`);
        const markdown = await chatText(cfg.ai, [
          { role: 'system', content: 'You generate clean, useful changelogs for developers.' },
          { role: 'user', content: changelogPrompt({ commits: commitLines }) }
        ]);

        const outPath = path.resolve(root, cfg.changelog.path);
        await writeFile(outPath, markdown.trimEnd() + '\n', 'utf8');

        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(outPath));
        await vscode.window.showTextDocument(doc, { preview: false });

        await vscode.window.showInformationMessage(`CHANGELOG generated: ${cfg.changelog.path}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await vscode.window.showErrorMessage(`Commit Genius: ${msg}`);
      }
    }
  );
}
