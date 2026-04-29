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

const SERIES_PREFIX = "btc-updown-5m";
const SERIES_SLUG = "btc-up-or-down-5m";
const STEP_SECONDS = 300; // 5 минут

const GAMMA_HOST = process.env.GAMMA_HOST || "https://gamma-api.polymarket.com";

export type UpDown = "UP" | "DOWN";

export interface PastEvent {
  slug: string;
  startTimestamp: number; // unix seconds (UTC), он же суффикс слага
  startTime: string;      // ISO eventStartTime, для удобства
  resolved: boolean;
  result: UpDown | null;  // null, если ещё не разрешён
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
 * в наш `PastEvent`. Логика разрешения:
 *   closed=true И outcomePrices ровно ["1","0"] / ["0","1"] (см. issue #9).
 * До разрешения цены живые (например 0.955 / 0.045) — такие события возвращаем
 * как result=null.
 */
function toPastEvent(event: any): PastEvent {
  const market = event?.markets?.[0];
  if (!market) {
    throw new Error(`Event "${event?.slug}" has no markets`);
  }
  // outcomes / outcomePrices приходят как JSON-строки внутри JSON.
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

  return {
    slug: event.slug,
    startTimestamp: parseSlugTimestamp(event.slug),
    startTime: market.eventStartTime ?? event.startDate,
    resolved,
    result,
  };
}

async function fetchEventBySlug(slug: string): Promise<PastEvent> {
  const url = `${GAMMA_HOST}/events?slug=${encodeURIComponent(slug)}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Gamma API ${res.status} ${res.statusText} for slug "${slug}"`);
  }
  const arr = (await res.json()) as any[];
  if (!Array.isArray(arr) || arr.length === 0) {
    throw new Error(`Event not found for slug "${slug}"`);
  }
  return toPastEvent(arr[0]);
}

/**
 * Берём последние `limit` уже разрешённых событий серии через `series_slug`.
 * Этот эндпоинт, в отличие от `?slug=<slug>`, отдаёт свежие данные сразу после
 * закрытия 5-минутного окна (см. issue #11): outcomePrices здесь уже
 * `["1","0"]`/`["0","1"]` буквально через секунды после `endDate`, тогда как
 * slug-запрос ещё несколько минут возвращает промежуточные котировки и
 * `closed=false`. Используем как fallback для добора недостающих результатов.
 */
async function fetchRecentResolvedEvents(limit: number): Promise<PastEvent[]> {
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
    .map(toPastEvent);
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
 * Параллельно с пер-слаг-запросами тянем listing разрешённых событий серии
 * через `?series_slug=...&closed=true` — он отдаёт свежие данные сразу после
 * закрытия окна, тогда как `?slug=<slug>` залипает в кэше на минуты (issue
 * #11). Если slug-запрос показал событие как ещё не разрешённое, но в
 * series-listing-е оно уже разрешено, берём данные оттуда.
 */
export async function getPastFiveMinuteEvents(slug: string): Promise<PastEvent[]> {
  const currentTs = parseSlugTimestamp(slug);
  const slugs = [1, 2, 3, 4].map((i) => buildSlug(currentTs - i * STEP_SECONDS));
  const [perSlug, recentResolved] = await Promise.all([
    Promise.all(slugs.map(fetchEventBySlug)),
    fetchRecentResolvedEvents(20).catch(() => [] as PastEvent[]),
  ]);
  const resolvedByTs = new Map<number, PastEvent>();
  for (const e of recentResolved) {
    if (e.resolved) resolvedByTs.set(e.startTimestamp, e);
  }
  return perSlug.map((e) => {
    if (e.resolved) return e;
    const fresh = resolvedByTs.get(e.startTimestamp);
    return fresh ?? e;
  });
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
  return getPastFiveMinuteEvents(getActiveSlug(nowMs));
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
