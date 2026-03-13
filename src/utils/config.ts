import * as vscode from 'vscode';

export type DiffScope = 'staged' | 'workingTree';
export type PrPlatform = 'github' | 'gitlab' | 'bitbucket';

export const AI_API_KEY_SECRET_KEY = 'gitGenius.ai.apiKey';

export interface ExtensionConfig {
  ai: {
    baseUrl: string;
    apiKey: string;
    model: string;
    temperature: number;
  };
  commit: {
    diffScope: DiffScope;
  };
  changelog: {
    path: string;
  };
  pr: {
    platform: PrPlatform;
    baseRef: string;
    includeChecklist: boolean;
  };
}

export function getConfig(): ExtensionConfig {
  const c = vscode.workspace.getConfiguration('gitGenius');
  return {
    ai: {
      baseUrl: c.get<string>('ai.baseUrl', 'https://api.openai.com/v1'),
      apiKey: '',
      model: c.get<string>('ai.model', 'gpt-4o-mini'),
      temperature: c.get<number>('ai.temperature', 0.2)
    },
    commit: {
      diffScope: c.get<DiffScope>('commit.diffScope', 'staged')
    },
    changelog: {
      path: c.get<string>('changelog.path', 'CHANGELOG.md')
    },
    pr: {
      platform: c.get<PrPlatform>('pr.platform', 'github'),
      baseRef: c.get<string>('pr.baseRef', ''),
      includeChecklist: c.get<boolean>('pr.includeChecklist', true)
    }
  };
}

export async function getAiApiKey(context: vscode.ExtensionContext): Promise<string> {
  const c = vscode.workspace.getConfiguration('gitGenius');
  const inspected = c.inspect<string>('ai.apiKey');
  const workspaceValue = typeof inspected?.workspaceValue === 'string' ? inspected.workspaceValue : '';
  const globalValue = typeof inspected?.globalValue === 'string' ? inspected.globalValue : '';
  const key = workspaceValue || globalValue;
  if (key) {
    await context.secrets.store(AI_API_KEY_SECRET_KEY, key);

    if (workspaceValue) {
      await c.update('ai.apiKey', '', vscode.ConfigurationTarget.Workspace);
    }
    if (globalValue) {
      await c.update('ai.apiKey', '', vscode.ConfigurationTarget.Global);
    }

    return key;
  }

  const existing = await context.secrets.get(AI_API_KEY_SECRET_KEY);
  return existing || '';
}

export async function setAiApiKey(context: vscode.ExtensionContext, apiKey: string): Promise<void> {
  const key = String(apiKey || '').trim();
  if (!key) return;

  await context.secrets.store(AI_API_KEY_SECRET_KEY, key);

  const c = vscode.workspace.getConfiguration('gitGenius');
  const inspected = c.inspect<string>('ai.apiKey');
  const workspaceValue = typeof inspected?.workspaceValue === 'string' ? inspected.workspaceValue : '';
  const globalValue = typeof inspected?.globalValue === 'string' ? inspected.globalValue : '';
  if (workspaceValue) {
    await c.update('ai.apiKey', '', vscode.ConfigurationTarget.Workspace);
  }
  if (globalValue) {
    await c.update('ai.apiKey', '', vscode.ConfigurationTarget.Global);
  }
}

export async function getConfigWithSecrets(context: vscode.ExtensionContext): Promise<ExtensionConfig> {
  const cfg = getConfig();
  cfg.ai.apiKey = await getAiApiKey(context);
  return cfg;
}
