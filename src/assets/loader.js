/**
 * Конвеєр завантаження ресурсів (Лаба 3).
 *
 * Кожен завантажувач приймає AbortSignal: скасування — це не метод промісу, а сигнал,
 * який передається вниз до fetch(). Таймаут — теж сигнал (AbortSignal.timeout).
 */

/** HTTP-помилка зі статусом — щоб withRetry міг відрізнити 4xx від 5xx. */
export class HttpError extends Error {
  constructor(url, status) {
    super(`HTTP ${status} for ${url}`);
    this.name = "HttpError";
    this.url = url;
    this.status = status;
  }
}

/** Об'єднує сигнал виклику з таймаутом. */
function withTimeout(signal, ms) {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/**
 * fetch, що перевіряє response.ok. Сам fetch НЕ відхиляє проміс на 404/500 —
 * для нього це успішна HTTP-відповідь. Відхилення буває лише на мережеву помилку чи abort.
 */
export async function fetchChecked(url, { signal, timeoutMs = 8000 } = {}) {
  const response = await fetch(url, { signal: withTimeout(signal, timeoutMs) });
  if (!response.ok) throw new HttpError(url, response.status);
  return response;
}

export async function fetchJson(url, opts) {
  const response = await fetchChecked(url, opts);
  // Другий крок читання тіла: заголовки вже прийшли, а тіло ще стрімиться
  return response.json(); // SyntaxError на зіпсованому JSON
}

export function loadJson(url, opts) {
  return fetchJson(url, opts);
}

/**
 * Зображення через fetch → Blob → createImageBitmap (а не new Image()),
 * бо так працюють і AbortSignal, і перевірка статусу, і декодування поза головним потоком.
 */
export async function loadImage(url, opts) {
  const response = await fetchChecked(url, opts);
  const blob = await response.blob();
  return createImageBitmap(blob);
}

/** Звук: завантажити байти й декодувати в AudioBuffer (працює й поки контекст «suspended»). */
export async function loadAudio(ctx, url, opts) {
  const response = await fetchChecked(url, opts);
  const bytes = await response.arrayBuffer();
  return ctx.decodeAudioData(bytes);
}

/** Пауза, яку можна перервати сигналом. */
export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const id = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(id);
      reject(signal.reason);
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Чи має сенс повторювати? 4xx — ні (запит неправильний), abort — ні, JSON — ні. */
export function isRetryable(err, signal) {
  if (signal?.aborted) return false;
  if (err instanceof HttpError)
    return err.status >= 500 || err.status === 408 || err.status === 429;
  if (err instanceof SyntaxError) return false;
  // TypeError від fetch (мережа) або TimeoutError від AbortSignal.timeout — так
  return err?.name === "TypeError" || err?.name === "TimeoutError";
}

/**
 * Повтор з експоненційною затримкою і «джитером»:
 * затримка = baseMs · 2^(спроба-1) · випадково [0.5, 1.5).
 * Джитер потрібен, щоб тисяча клієнтів після збою сервера не повторювали запити синхронно.
 */
export async function withRetry(
  fn,
  { attempts = 3, baseMs = 250, signal, onRetry, random = Math.random } = {},
) {
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      if (attempt === attempts || !isRetryable(err, signal)) throw err;
      const delay = baseMs * 2 ** (attempt - 1) * (0.5 + random());
      onRetry?.({ attempt, delay, error: err });
      await sleep(delay, signal);
    }
  }
  throw lastErr;
}

function loaderFor(item, audioCtx) {
  switch (item.type) {
    case "image":
      return (opts) => loadImage(item.url, opts);
    case "json":
      return (opts) => loadJson(item.url, opts);
    case "audio":
      return (opts) => loadAudio(audioCtx, item.url, opts);
    default:
      throw new TypeError(`Unknown asset type: ${item.type}`);
  }
}

/**
 * Завантажує всі ресурси маніфесту ОДНОЧАСНО через Promise.all.
 * Обов'язковий ресурс, що впав, відхиляє весь loadAll (Promise.all — «все або нічого»).
 * Необов'язковий — ловиться всередині, і замість нього в результат іде null.
 *
 * @returns {Promise<{assets: Map<string, unknown>, failures: Array<{id, error}>}>}
 */
export async function loadAll(
  manifest,
  { onProgress, onRetry, signal, audioCtx, timeoutMs = 8000, sequential = false } = {},
) {
  const items = manifest.items;
  let done = 0;
  const failures = [];

  const report = (item, ok, error) => {
    done += 1;
    onProgress?.({ done, total: items.length, item, ok, error });
  };

  const loadOne = async (item) => {
    const load = loaderFor(item, audioCtx);
    try {
      const value = await withRetry((_attempt) => load({ signal, timeoutMs }), {
        signal,
        onRetry: (info) => onRetry?.({ item, ...info }),
      });
      report(item, true);
      return [item.id, value];
    } catch (error) {
      report(item, false, error);
      if (item.optional && !signal?.aborted) {
        failures.push({ id: item.id, error });
        return [item.id, null];
      }
      error.assetId = item.id;
      throw error;
    }
  };

  let entries;
  if (sequential) {
    // ЛИШЕ для вимірювання (README): чекаємо кожен ресурс по черзі
    entries = [];
    for (const item of items) entries.push(await loadOne(item));
  } else {
    entries = await Promise.all(items.map(loadOne));
  }
  return { assets: new Map(entries), failures };
}
