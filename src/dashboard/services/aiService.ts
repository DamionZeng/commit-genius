import { getAdapter } from '../../adapters';
import { chatText, chatTextStream, toUserSafeErrorMessage } from '../../utils/ai';
import type { ExtensionConfig } from '../../utils/config';
import { changelogPrompt, commitPrompt, prPrompt } from '../../utils/prompts';

export { toUserSafeErrorMessage };

export async function testAiConnection(cfg: ExtensionConfig['ai'], signal: AbortSignal): Promise<string> {
  return await chatText(
    cfg,
    [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'Reply with a single word: OK' }
    ],
    { signal, timeoutMs: 60_000 }
  );
}

export async function streamCommitMessage(
  cfg: ExtensionConfig['ai'],
  params: { diff: string; branch: string },
  onDelta: (chunk: string) => void | Promise<void>,
  signal: AbortSignal
): Promise<string> {
  return await chatTextStream(
    cfg,
    [
      { role: 'system', content: 'You are a senior software engineer writing high-quality git commits.' },
      { role: 'user', content: commitPrompt({ diff: params.diff, branch: params.branch }) }
    ],
    onDelta,
    { signal, timeoutMs: 60_000 }
  );
}

export async function streamRewrittenCommitMessage(
  cfg: ExtensionConfig['ai'],
  params: { currentMessage: string; instruction: string; branch: string; diff: string },
  onDelta: (chunk: string) => void | Promise<void>,
  signal: AbortSignal
): Promise<string> {
  return await chatTextStream(
    cfg,
    [
      { role: 'system', content: 'You are a senior software engineer writing high-quality git commits.' },
      {
        role: 'user',
        content: [
          'Rewrite the following Conventional Commit message.',
          '',
          `Instruction: ${params.instruction}`,
          '',
          'Rules:',
          '- Output only the final commit message (no markdown).',
          '- Keep Conventional Commits format: <type>(<scope>): <description>.',
          '- Keep subject <= 72 chars, imperative mood.',
          '',
          `Branch: ${params.branch}`,
          '',
          'Current message:',
          params.currentMessage.trim(),
          '',
          'Diff:',
          params.diff.slice(0, 120_000)
        ].join('\n')
      }
    ],
    onDelta,
    { signal, timeoutMs: 60_000 }
  );
}

export async function streamChangelog(
  cfg: ExtensionConfig['ai'],
  params: { commits: string[] },
  onDelta: (chunk: string) => void | Promise<void>,
  signal: AbortSignal
): Promise<string> {
  return await chatTextStream(
    cfg,
    [
      { role: 'system', content: 'You generate clean, useful changelogs for developers.' },
      { role: 'user', content: changelogPrompt({ commits: params.commits }) }
    ],
    onDelta,
    { signal, timeoutMs: 120_000 }
  );
}

type PrJson = { title: string; body: string };

function isPrJson(value: unknown): value is PrJson {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.title === 'string' && typeof v.body === 'string';
}

function extractJsonObject(text: string): unknown {
  const trimmed = String(text || '').trim();
  if (!trimmed) throw new Error('AI returned empty JSON output.');
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) {
      throw new Error(`AI returned non-JSON output: ${trimmed.slice(0, 200)}`);
    }
    const candidate = trimmed.slice(start, end + 1);
    try {
      return JSON.parse(candidate);
    } catch {
      throw new Error(`AI returned non-JSON output: ${trimmed.slice(0, 200)}`);
    }
  }
}

export async function streamPrDescription(
  cfg: ExtensionConfig,
  params: { baseRef: string; branch: string; summary: string; diff: string },
  onDelta: (chunk: string) => void | Promise<void>,
  signal: AbortSignal
): Promise<{ clipboardText: string; formattedTitle: string; formattedBody: string }> {
  const rawJsonText = await chatTextStream(
    cfg.ai,
    [
      { role: 'system', content: 'You write clear, reviewer-friendly pull request descriptions.' },
      { role: 'user', content: prPrompt({ baseRef: params.baseRef, branch: params.branch, summary: params.summary, diff: params.diff }) },
      { role: 'system', content: 'Return only valid JSON. Do not wrap JSON in markdown fences.' }
    ],
    onDelta,
    { signal, timeoutMs: 120_000 }
  );

  const parsed = extractJsonObject(rawJsonText);
  if (!isPrJson(parsed)) {
    throw new Error('AI returned unexpected JSON schema.');
  }
  const draft = parsed;

  const adapter = getAdapter(cfg.pr.platform);
  const formatted = adapter.formatDraft(
    { title: draft.title.trim(), body: draft.body.trim() },
    { includeChecklist: cfg.pr.includeChecklist }
  );

  const clipboardText = `# ${formatted.title}\n\n${formatted.body}\n`;
  return { clipboardText, formattedTitle: formatted.title, formattedBody: formatted.body };
}

