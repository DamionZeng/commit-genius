import axios from 'axios';
import { ExtensionConfig } from './config';

type Role = 'system' | 'user' | 'assistant';

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
}

interface ChatCompletionStreamChunk {
  choices?: Array<{
    delta?: {
      content?: string;
    };
    message?: {
      content?: string;
    };
  }>;
}

export interface ChatMessage {
  role: Role;
  content: string;
}

export interface ChatRequestOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

function sanitizeUserMessage(text: string): string {
  const raw = String(text || '');
  const redacted = raw
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(apiKey|api_key|token)\s*=\s*([^\s|]+)/gi, '$1=[REDACTED]')
    .replace(/\b(sk-[A-Za-z0-9]{10,})\b/g, 'sk-[REDACTED]')
    .replace(/\b(rk-[A-Za-z0-9]{10,})\b/g, 'rk-[REDACTED]');
  const oneLine = redacted.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= 320) return oneLine;
  return oneLine.slice(0, 320).trimEnd() + '…';
}

export function toUserSafeErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return sanitizeUserMessage(raw || 'Unknown error.');
}

function formatAiRequestError(err: unknown, baseUrl: string): Error {
  if (axios.isAxiosError(err)) {
    const status = err.response?.status;
    const statusText = err.response?.statusText;
    const code = err.code;
    const message = err.message || 'Request failed.';

    const parts = [
      'AI request failed.',
      `baseUrl=${normalizeBaseUrl(baseUrl)}`,
      status ? `status=${status}${statusText ? ` ${statusText}` : ''}` : undefined,
      code ? `code=${code}` : undefined,
      message ? `message=${message}` : undefined
    ].filter(Boolean);

    return new Error(sanitizeUserMessage(parts.join(' | ')));
  }

  if (err instanceof Error) return err;
  return new Error(String(err));
}

export async function chatText(
  config: ExtensionConfig['ai'],
  messages: ChatMessage[],
  options?: ChatRequestOptions
): Promise<string> {
  if (!config.apiKey) {
    throw new Error('Missing AI API key.');
  }

  const client = axios.create({
    baseURL: normalizeBaseUrl(config.baseUrl),
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json'
    },
    timeout: options?.timeoutMs ?? 60_000,
    signal: options?.signal
  });

  let resp;
  try {
    resp = await client.post<ChatCompletionResponse>('/chat/completions', {
      model: config.model,
      temperature: config.temperature,
      messages
    });
  } catch (err) {
    throw formatAiRequestError(err, config.baseUrl);
  }

  const text = resp.data.choices?.[0]?.message?.content;
  if (typeof text !== 'string' || !text.trim()) {
    throw new Error('AI response is empty.');
  }
  return text.trim();
}

export async function chatTextStream(
  config: ExtensionConfig['ai'],
  messages: ChatMessage[],
  onDelta: (chunk: string) => void | Promise<void>,
  options?: ChatRequestOptions
): Promise<string> {
  if (!config.apiKey) {
    throw new Error('Missing AI API key.');
  }

  const client = axios.create({
    baseURL: normalizeBaseUrl(config.baseUrl),
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json'
    },
    timeout: options?.timeoutMs ?? 60_000,
    signal: options?.signal
  });

  let resp;
  try {
    resp = await client.post('/chat/completions', {
      model: config.model,
      temperature: config.temperature,
      messages,
      stream: true
    }, { responseType: 'stream' });
  } catch (err) {
    throw formatAiRequestError(err, config.baseUrl);
  }

  const stream = resp?.data as unknown;
  const asyncIterable = stream as { [Symbol.asyncIterator]?: unknown };
  if (!stream || typeof asyncIterable?.[Symbol.asyncIterator] !== 'function') {
    throw new Error('AI streaming response is not a readable stream.');
  }

  let full = '';
  let buffer = '';

  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      buffer += Buffer.from(chunk).toString('utf8');

      for (let idx = buffer.indexOf('\n'); idx !== -1; idx = buffer.indexOf('\n')) {
        const rawLine = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);

        const line = rawLine.trim();
        if (!line) continue;
        if (!line.startsWith('data:')) continue;

        const data = line.slice('data:'.length).trim();
        if (!data) continue;
        if (data === '[DONE]') {
          buffer = '';
          break;
        }

        let parsed: ChatCompletionStreamChunk | undefined;
        try {
          parsed = JSON.parse(data) as ChatCompletionStreamChunk;
        } catch {
          continue;
        }

        const delta =
          parsed?.choices?.[0]?.delta?.content ??
          parsed?.choices?.[0]?.message?.content ??
          '';

        if (typeof delta === 'string' && delta) {
          full += delta;
          await onDelta(delta);
        }
      }

      if (buffer === '') {
        continue;
      }
    }
  } catch (err) {
    throw formatAiRequestError(err, config.baseUrl);
  }

  const text = full.trim();
  if (!text) {
    throw new Error('AI response is empty.');
  }
  return text;
}

export async function chatJson<T>(
  config: ExtensionConfig['ai'],
  messages: ChatMessage[],
  validate: (value: unknown) => value is T,
  options?: ChatRequestOptions
): Promise<T> {
  const text = await chatText(config, [
    ...messages,
    {
      role: 'system',
      content: 'Return only valid JSON. Do not wrap JSON in markdown fences.'
    }
  ], options);

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    const start = sanitizeUserMessage(text);
    throw new Error(`AI returned non-JSON output: ${start}`);
  }

  if (!validate(parsed)) {
    throw new Error('AI returned unexpected JSON schema.');
  }
  return parsed;
}
