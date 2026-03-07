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

function formatAiRequestError(err: unknown, baseUrl: string): Error {
  if (axios.isAxiosError(err)) {
    const status = err.response?.status;
    const statusText = err.response?.statusText;
    const code = err.code;
    const message = err.message || 'Request failed.';
    const responseData: unknown = err.response?.data;
    const responsePreview =
      typeof responseData === 'string'
        ? responseData.slice(0, 800)
        : responseData
          ? JSON.stringify(responseData).slice(0, 800)
          : '';

    const parts = [
      'AI request failed.',
      `baseUrl=${normalizeBaseUrl(baseUrl)}`,
      status ? `status=${status}${statusText ? ` ${statusText}` : ''}` : undefined,
      code ? `code=${code}` : undefined,
      message ? `message=${message}` : undefined,
      responsePreview ? `response=${responsePreview}` : undefined
    ].filter(Boolean);

    return new Error(parts.join(' | '));
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
    throw new Error('Missing commitGenius.ai.apiKey.');
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
    const start = text.slice(0, 500);
    throw new Error(`AI returned non-JSON output: ${start}`);
  }

  if (!validate(parsed)) {
    throw new Error('AI returned unexpected JSON schema.');
  }
  return parsed;
}
