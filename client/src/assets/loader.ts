/**
 * Конвеєр завантаження ресурсів (Лаба 3). Маніфест перевіряється zod-схемою.
 */
import { z } from "zod";

export class HttpError extends Error {
  readonly url: string;
  readonly status: number;
  constructor(url: string, status: number) {
    super(`HTTP ${status} for ${url}`);
    this.name = "HttpError";
    this.url = url;
    this.status = status;
  }
}

/** Помилка ресурсу з id — щоб екран завантаження показав, що саме впало. */
export class AssetError extends Error {
  readonly assetId: string;
  override readonly cause: unknown;
  constructor(assetId: string, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = cause instanceof Error ? cause.name : "AssetError";
    this.assetId = assetId;
    this.cause = cause;
  }
}

export interface FetchOptions {
  signal?: AbortSignal | undefined;
  timeoutMs?: number;
}

function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export async function fetchChecked(
  url: string,
  { signal, timeoutMs = 8000 }: FetchOptions = {},
): Promise<Response> {
  const response = await fetch(url, { signal: withTimeout(signal, timeoutMs) });
  if (!response.ok) throw new HttpError(url, response.status);
  return response;
}

export async function fetchJson(url: string, opts?: FetchOptions): Promise<unknown> {
  const response = await fetchChecked(url, opts);
  const value: unknown = await response.json();
  return value;
}

/** JSON + zod-схема: на виході — значення потрібного типу або виняток. */
export async function loadJson<T>(
  url: string,
  schema: z.ZodType<T>,
  opts?: FetchOptions,
): Promise<T> {
  return schema.parse(await fetchJson(url, opts));
}

export async function loadImage(url: string, opts?: FetchOptions): Promise<ImageBitmap> {
  const response = await fetchChecked(url, opts);
  return createImageBitmap(await response.blob());
}

export async function loadAudio(
  ctx: BaseAudioContext,
  url: string,
  opts?: FetchOptions,
): Promise<AudioBuffer> {
  const response = await fetchChecked(url, opts);
  return ctx.decodeAudioData(await response.arrayBuffer());
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = (): void => {
      clearTimeout(id);
      reject(signal?.reason);
    };
    const id = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function isRetryable(err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return false;
  if (err instanceof HttpError)
    return err.status >= 500 || err.status === 408 || err.status === 429;
  if (err instanceof SyntaxError || err instanceof z.ZodError) return false;
  return err instanceof Error && (err.name === "TypeError" || err.name === "TimeoutError");
}

export interface RetryInfo {
  attempt: number;
  delay: number;
  error: unknown;
}

export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  {
    attempts = 3,
    baseMs = 250,
    signal,
    onRetry,
    random = Math.random,
  }: {
    attempts?: number;
    baseMs?: number;
    signal?: AbortSignal | undefined;
    onRetry?: (info: RetryInfo) => void;
    random?: () => number;
  } = {},
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (err: unknown) {
      if (attempt >= attempts || !isRetryable(err, signal)) throw err;
      const delay = baseMs * 2 ** (attempt - 1) * (0.5 + random());
      onRetry?.({ attempt, delay, error: err });
      await sleep(delay, signal);
    }
  }
}

// ---------------- маніфест ----------------
export const ManifestItemSchema = z.object({
  id: z.string(),
  type: z.enum(["image", "json", "audio"]),
  url: z.string(),
  optional: z.boolean().optional(),
});
export const ManifestSchema = z.object({
  version: z.literal(1),
  items: z.array(ManifestItemSchema),
});
export type ManifestItem = z.infer<typeof ManifestItemSchema>;
export type Manifest = z.infer<typeof ManifestSchema>;
export type AssetValue = ImageBitmap | AudioBuffer | unknown;

function loaderFor(
  item: ManifestItem,
  audioCtx: BaseAudioContext,
): (opts: FetchOptions) => Promise<AssetValue> {
  switch (item.type) {
    case "image":
      return (opts) => loadImage(item.url, opts);
    case "json":
      return (opts) => fetchJson(item.url, opts);
    case "audio":
      return (opts) => loadAudio(audioCtx, item.url, opts);
  }
}

export interface Progress {
  done: number;
  total: number;
  item: ManifestItem;
  ok: boolean;
  error?: unknown;
}

export interface LoadAllOptions {
  onProgress?: (p: Progress) => void;
  onRetry?: (info: RetryInfo & { item: ManifestItem }) => void;
  signal?: AbortSignal;
  audioCtx: BaseAudioContext;
  timeoutMs?: number;
  sequential?: boolean;
}

export interface LoadAllResult {
  assets: Map<string, AssetValue>;
  failures: { id: string; error: unknown }[];
}

/** Усе одночасно через Promise.all; обов'язкове впало → AssetError; необов'язкове → null. */
export async function loadAll(
  manifest: Manifest,
  { onProgress, onRetry, signal, audioCtx, timeoutMs = 8000, sequential = false }: LoadAllOptions,
): Promise<LoadAllResult> {
  let done = 0;
  const failures: LoadAllResult["failures"] = [];
  const total = manifest.items.length;

  const loadOne = async (item: ManifestItem): Promise<[string, AssetValue]> => {
    const load = loaderFor(item, audioCtx);
    try {
      const value = await withRetry(() => load({ signal, timeoutMs }), {
        signal,
        onRetry: (info) => onRetry?.({ item, ...info }),
      });
      done += 1;
      onProgress?.({ done, total, item, ok: true });
      return [item.id, value];
    } catch (error: unknown) {
      done += 1;
      onProgress?.({ done, total, item, ok: false, error });
      if (item.optional && !signal?.aborted) {
        failures.push({ id: item.id, error });
        return [item.id, null];
      }
      throw new AssetError(item.id, error);
    }
  };

  let entries: [string, AssetValue][];
  if (sequential) {
    entries = [];
    for (const item of manifest.items) entries.push(await loadOne(item));
  } else {
    entries = await Promise.all(manifest.items.map(loadOne));
  }
  return { assets: new Map(entries), failures };
}
