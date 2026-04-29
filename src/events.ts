// Helpers для серии "BTC Up or Down 5m" (см. issue #5).
//
// Polymarket публикует серию 5-минутных бинарных рынков по слагам вида
//   btc-updown-5m-<unix-seconds>
// где <unix-seconds> — это время **начала** 5-минутного окна (eventStartTime)
// в UTC. Проверено на примере из issue:
//   https://polymarket.com/event/btc-updown-5m-1777398300
//   1777398300 = 2026-04-28T17:45:00Z = eventStartTime окна 17:45–17:50 UTC.
// Каждое следующее окно начинается ровно через 300 секунд.
//
// Данные берём из публичного Gamma API (auth не требуется):
//   GET https://gamma-api.polymarket.com/events?slug=<slug>
// Возвращает массив (одно событие) с полем `markets[0]` и в нём:
//   - outcomes:      JSON-строка вида `["Up", "Down"]`
//   - outcomePrices: JSON-строка вида `["1", "0"]` или `["0", "1"]` после
//                    разрешения. Цена "1" у выигравшей стороны, "0" — у проигравшей.
//   - closed:        true, когда рынок закрыт и итог зафиксирован.
//   - umaResolutionStatus: "resolved", когда UMA подтвердила исход. На
//                    5-мин рынках это происходит через десятки секунд после
//                    закрытия, поэтому ориентироваться только на этот флаг
//                    нельзя (см. issue #9) — берём пару closed + финальные
//                    цены ["1","0"]/["0","1"].
// До разрешения outcomePrices содержит текущие котировки рынка
// (например `["0.955", "0.045"]`), такие события мы возвращаем как result=null.
//
// Дополнительно (см. issue #11): запрос `?slug=<slug>` на Gamma API имеет
// агрессивный кэш и может на 1-7+ минут после `endDate` продолжать отдавать
// промежуточные котировки и `closed=false`, тогда как UI Polymarket уже давно
// показывает "Outcome: Up/Down". При этом запрос
// `?series_slug=btc-up-or-down-5m&closed=true&order=startDate&ascending=false`
// возвращает уже разрешённые события свежими (их `outcomePrices` ровно
// `["1","0"]`/`["0","1"]`). Поэтому если slug-запрос показал событие как
// неразрешённое, а его окно уже закончилось, мы добираем актуальные данные
// из series-листинга и используем их.
//
// Ещё один уровень устаревания (issue #13): для самого свежего из
// «прошедших» событий (то, что закончилось буквально 0–2 минуты назад)
// и slug-запрос, и series-листинг ещё не отдают финальные данные —
// listing просто не содержит этот slug, а per-slug по-прежнему `closed=false`
// с промежуточными ценами. UI Polymarket в этот момент уже показывает итог,
// а CLOB API (`https://clob.polymarket.com/last-trade-price?token_id=...`)
// отдаёт «снэпом» цены последних сделок: ~0.99 у победителя и ~0.01 у
// проигравшего. После закрытия окна торговля по этим токенам по сути
// прекращается (выигрышная сторона стремится к 1, проигравшая к 0),
// поэтому `last-trade-price` — самый надёжный источник для добора резолюции.
// Используем это как третий fallback: только для событий, чьё окно уже
// закончилось (`endDate < now`), и только если две стороны разошлись
// явно — победитель ≥ RESOLVE_HIGH_THRESHOLD и проигравший
// ≤ RESOLVE_LOW_THRESHOLD. Иначе оставляем `result=null`.

const SERIES_PREFIX = "btc-updown-5m";
const SERIES_SLUG = "btc-up-or-down-5m";
const STEP_SECONDS = 300; // 5 минут

const GAMMA_HOST = "https://gamma-api.polymarket.com";
const CLOB_HOST = "https://clob.polymarket.com";

// Пороги для CLOB-fallback'а. После закрытия 5-минутного окна цены на
// победившей и проигравшей стороне разъезжаются практически в 1.0/0.0;
// 0.95/0.05 даёт большой запас от любых внутрь-окновых колебаний.
const RESOLVE_HIGH_THRESHOLD = 0.95;
const RESOLVE_LOW_THRESHOLD = 0.05;

export type UpDown = "UP" | "DOWN";

export interface PastEvent {
  slug: string;
  startTimestamp: number; // unix seconds (UTC), он же суффикс слага
  startTime: string;      // ISO eventStartTime, для удобства
  resolved: boolean;
  result: UpDown | null;  // null, если ещё не разрешён
}

// Внутреннее представление события, обогащённое данными для CLOB-fallback'а.
// `endDate` нужен, чтобы триггерить fallback только после закрытия окна;
// `clobTokenIds`/`outcomes` — чтобы запросить `last-trade-price` правильной
// стороны и понять, кто выиграл.
interface RawEvent extends PastEvent {
  endDate: number | null;          // unix seconds, null если не пришёл
  clobTokenIds: [string, string] | null;
  outcomes: [string, string] | null;
}

/** Парсит слаг вида `btc-updown-5m-1777398300` и возвращает unix-секунды. */
export function parseSlugTimestamp(slug: string): number {
  const prefix = `${SERIES_PREFIX}-`;
  if (!slug.startsWith(prefix)) {
    throw new Error(`Unexpected slug "${slug}", expected "${prefix}<unix-seconds>"`);
  }
  const ts = Number(slug.slice(prefix.length));
  if (!Number.isFinite(ts) || !Number.isInteger(ts) || ts <= 0) {
    throw new Error(`Cannot parse unix timestamp from slug "${slug}"`);
  }
  return ts;
}

/** Собирает слаг по unix-секундам. */
export function buildSlug(timestamp: number): string {
  return `${SERIES_PREFIX}-${timestamp}`;
}

/**
 * Превращает один Gamma-event (как из `?slug=...`, так и из `?series_slug=...`)
 * в наш `RawEvent`. Логика разрешения:
 *   closed=true И outcomePrices ровно ["1","0"] / ["0","1"] (см. issue #9).
 * До разрешения цены живые (например 0.955 / 0.045) — такие события возвращаем
 * как result=null.
 *
 * Дополнительно подтягиваем `endDate` и `clobTokenIds` для CLOB-fallback'а
 * (см. issue #13).
 */
function toRawEvent(event: any): RawEvent {
  const market = event?.markets?.[0];
  if (!market) {
    throw new Error(`Event "${event?.slug}" has no markets`);
  }
  // outcomes / outcomePrices / clobTokenIds приходят как JSON-строки.
  const outcomes: string[] = JSON.parse(market.outcomes);
  const prices: string[] = JSON.parse(market.outcomePrices);

  const resolved =
    Boolean(event.closed) &&
    prices.filter((p) => p === "1").length === 1 &&
    prices.filter((p) => p === "0").length === 1;

  let result: UpDown | null = null;
  if (resolved) {
    const winnerIdx = prices.indexOf("1");
    const winner = outcomes[winnerIdx];
    if (winner === "Up") result = "UP";
    else if (winner === "Down") result = "DOWN";
    else throw new Error(`Unexpected winning outcome "${winner}" for slug "${event.slug}"`);
  }

  let clobTokenIds: [string, string] | null = null;
  if (typeof market.clobTokenIds === "string") {
    const parsed = JSON.parse(market.clobTokenIds);
    if (Array.isArray(parsed) && parsed.length === 2) {
      clobTokenIds = [String(parsed[0]), String(parsed[1])];
    }
  }

  const endDateRaw = event.endDate ?? market.endDate;
  const endDate = endDateRaw ? Math.floor(new Date(endDateRaw).getTime() / 1000) : null;

  return {
    slug: event.slug,
    startTimestamp: parseSlugTimestamp(event.slug),
    startTime: market.eventStartTime ?? event.startDate,
    resolved,
    result,
    endDate,
    clobTokenIds,
    outcomes: outcomes.length === 2 ? [outcomes[0], outcomes[1]] : null,
  };
}

function toPastEvent(raw: RawEvent): PastEvent {
  return {
    slug: raw.slug,
    startTimestamp: raw.startTimestamp,
    startTime: raw.startTime,
    resolved: raw.resolved,
    result: raw.result,
  };
}

async function fetchEventBySlug(slug: string): Promise<RawEvent> {
  const url = `${GAMMA_HOST}/events?slug=${encodeURIComponent(slug)}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Gamma API ${res.status} ${res.statusText} for slug "${slug}"`);
  }
  const arr = (await res.json()) as any[];
  if (!Array.isArray(arr) || arr.length === 0) {
    throw new Error(`Event not found for slug "${slug}"`);
  }
  return toRawEvent(arr[0]);
}

/**
 * Берём последние `limit` уже разрешённых событий серии через `series_slug`.
 * Этот эндпоинт, в отличие от `?slug=<slug>`, отдаёт свежие данные сразу после
 * закрытия 5-минутного окна (см. issue #11): outcomePrices здесь уже
 * `["1","0"]`/`["0","1"]` буквально через секунды после `endDate`, тогда как
 * slug-запрос ещё несколько минут возвращает промежуточные котировки и
 * `closed=false`. Используем как fallback для добора недостающих результатов.
 */
async function fetchRecentResolvedEvents(limit: number): Promise<RawEvent[]> {
  const url =
    `${GAMMA_HOST}/events?series_slug=${encodeURIComponent(SERIES_SLUG)}` +
    `&closed=true&order=startDate&ascending=false&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Gamma API ${res.status} ${res.statusText} for series "${SERIES_SLUG}"`);
  }
  const arr = (await res.json()) as any[];
  if (!Array.isArray(arr)) return [];
  // На странице могут попасться события из других подсерий — фильтруем по
  // префиксу слага, чтобы не споткнуться при разборе timestamp-а.
  return arr
    .filter((e) => typeof e?.slug === "string" && e.slug.startsWith(`${SERIES_PREFIX}-`))
    .map(toRawEvent);
}

/**
 * CLOB-fallback (issue #13): для события, которое уже завершилось, но Gamma
 * ещё не отдала финальные данные ни через slug, ни через series-листинг,
 * берём `last-trade-price` каждой стороны на CLOB. После закрытия окна
 * победитель торгуется около 1.0, проигравший — около 0.0; промежуточные
 * значения означают, что окно ещё не закрылось / не отстоялось, и мы
 * не делаем выводов.
 *
 * Возвращает обновлённый PastEvent (с `resolved=true` и нужным `result`),
 * либо исходное событие, если данных недостаточно. Любая сетевая или
 * парсерная ошибка приводит к возврату исходного события — fallback
 * не должен валить общий запрос.
 */
async function resolveViaClob(raw: RawEvent, nowSeconds: number): Promise<PastEvent> {
  if (raw.resolved) return toPastEvent(raw);
  if (!raw.endDate || raw.endDate > nowSeconds) return toPastEvent(raw);
  if (!raw.clobTokenIds || !raw.outcomes) return toPastEvent(raw);

  try {
    const [upTok, downTok] = raw.clobTokenIds;
    const [pUp, pDown] = await Promise.all([
      fetchLastTradePrice(upTok),
      fetchLastTradePrice(downTok),
    ]);
    if (pUp === null || pDown === null) return toPastEvent(raw);

    const winnerIdx =
      pUp >= RESOLVE_HIGH_THRESHOLD && pDown <= RESOLVE_LOW_THRESHOLD
        ? 0
        : pDown >= RESOLVE_HIGH_THRESHOLD && pUp <= RESOLVE_LOW_THRESHOLD
          ? 1
          : -1;
    if (winnerIdx === -1) return toPastEvent(raw);

    const winner = raw.outcomes[winnerIdx];
    let result: UpDown | null = null;
    if (winner === "Up") result = "UP";
    else if (winner === "Down") result = "DOWN";
    if (!result) return toPastEvent(raw);

    return { ...toPastEvent(raw), resolved: true, result };
  } catch {
    return toPastEvent(raw);
  }
}

async function fetchLastTradePrice(tokenId: string): Promise<number | null> {
  const url = `${CLOB_HOST}/last-trade-price?token_id=${encodeURIComponent(tokenId)}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const body = (await res.json()) as { price?: string | number };
  if (body?.price === undefined || body?.price === null) return null;
  const n = Number(body.price);
  return Number.isFinite(n) ? n : null;
}

/**
 * Возвращает 4 предыдущих 5-минутных события относительно `slug`.
 *
 * Аргументы:
 *  - slug: слаг текущего события, например `btc-updown-5m-1777398300`.
 *
 * Результат: массив из 4 элементов от самого свежего (slug - 300s) к самому
 * старому (slug - 1200s). Для каждого события указано, разрешено ли оно
 * (`resolved`) и каков исход (`result`: "UP" | "DOWN" | null, если ещё нет).
 *
 * Используем три источника, в порядке убывания «дешевизны»:
 *   1. `?slug=<slug>` per-event (issue #5).
 *   2. `?series_slug=...&closed=true` listing — добор для slug'ов, чьи Gamma-
 *      кэши ещё не обновились (issue #11).
 *   3. CLOB `/last-trade-price` — добор для самого свежего из «прошедших»
 *      событий, которое ещё не попало даже в series-листинг (issue #13).
 *      После закрытия окна цены последних сделок снапятся к 1/0, что и
 *      даёт исход.
 */
export async function getPastFiveMinuteEvents(
  slug: string,
  nowMs: number = Date.now(),
): Promise<PastEvent[]> {
  const nowSeconds = Math.floor(nowMs / 1000);
  const currentTs = parseSlugTimestamp(slug);
  const slugs = [1, 2, 3, 4].map((i) => buildSlug(currentTs - i * STEP_SECONDS));
  const [perSlug, recentResolved] = await Promise.all([
    Promise.all(slugs.map(fetchEventBySlug)),
    fetchRecentResolvedEvents(20).catch(() => [] as RawEvent[]),
  ]);
  const resolvedByTs = new Map<number, RawEvent>();
  for (const e of recentResolved) {
    if (e.resolved) resolvedByTs.set(e.startTimestamp, e);
  }
  // Шаг 1+2: предпочесть свежие данные из series-листинга, если per-slug
  // ещё не разрешён.
  const merged: RawEvent[] = perSlug.map((e) => {
    if (e.resolved) return e;
    return resolvedByTs.get(e.startTimestamp) ?? e;
  });
  // Шаг 3: для всё ещё не разрешённых событий, чьё окно уже закончилось,
  // пробуем CLOB last-trade-price. Параллельно, чтобы не растягивать запрос.
  return Promise.all(merged.map((e) => resolveViaClob(e, nowSeconds)));
}

/**
 * Слаг активного 5-минутного события — то есть того, чьё окно 5 минут
 * содержит текущий момент. Серия идёт сеткой по `STEP_SECONDS` от unix-эпохи,
 * поэтому слаг можно вычислить локально, без запроса в Gamma API:
 *   floor(now / 300) * 300
 * Это и есть `eventStartTime` (unix-секунды UTC) активного окна, что мы и
 * используем как суффикс слага.
 *
 * Аргумент `nowMs` нужен для тестов / фиксированной точки во времени;
 * по умолчанию берётся `Date.now()`.
 */
export function getActiveSlug(nowMs: number = Date.now()): string {
  const nowSeconds = Math.floor(nowMs / 1000);
  const windowStart = Math.floor(nowSeconds / STEP_SECONDS) * STEP_SECONDS;
  return buildSlug(windowStart);
}

/**
 * Возвращает 4 предыдущих 5-минутных события относительно текущего активного.
 *
 * Это тонкая обёртка над `getPastFiveMinuteEvents`: вычисляет слаг активного
 * окна (`getActiveSlug`) и берёт 4 события перед ним. Удобно, когда вызывающей
 * стороне не нужно самой следить за текущим временем — например, в стратегии,
 * которая в момент входа в активное окно хочет посмотреть, как разрешились
 * последние 4 события серии.
 *
 * Результат, как и у `getPastFiveMinuteEvents`, упорядочен от самого свежего
 * (active - 5 мин) к самому старому (active - 20 мин).
 */
export async function getPastFiveMinuteEventsFromActive(
  nowMs: number = Date.now(),
): Promise<PastEvent[]> {
  return getPastFiveMinuteEvents(getActiveSlug(nowMs), nowMs);
}

if (require.main === module) {
  // Без аргумента — берём активное (текущее) 5-минутное окно и возвращаем
  // 4 события до него. С аргументом — поведение как раньше: 4 события до
  // переданного слага.
  const slug = process.argv[2];
  const events = slug ? getPastFiveMinuteEvents(slug) : getPastFiveMinuteEventsFromActive();
  events
    .then((evs) => {
      console.log(JSON.stringify(evs, null, 2));
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
