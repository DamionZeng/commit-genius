import * as vscode from 'vscode';

import { generateChangelogCommand } from './commands/generateChangelog';
import { generateCommitMessageCommand } from './commands/generateCommitMessage';
import { generatePrDescriptionCommand } from './commands/generatePrDescription';
import { EmptyContentProvider, GitRefContentProvider } from './dashboard/contentProviders';
import { DashboardPanel } from './dashboard/panel';

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider('commit-genius-git', new GitRefContentProvider()),
    vscode.workspace.registerTextDocumentContentProvider('commit-genius-empty', new EmptyContentProvider()),
    vscode.commands.registerCommand('commitGenius.generateCommitMessage', () => generateCommitMessageCommand(context)),
    vscode.commands.registerCommand('commitGenius.generateChangelog', () => generateChangelogCommand(context)),
    vscode.commands.registerCommand('commitGenius.generatePrDescription', () => generatePrDescriptionCommand(context)),
    vscode.commands.registerCommand('commitGenius.openPanel', () => DashboardPanel.createOrShow(context))
  );
}

export function deactivate() {
}

