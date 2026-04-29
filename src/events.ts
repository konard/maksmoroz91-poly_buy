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
//   - closed / umaResolutionStatus: признаки того, что событие уже разрешено.
// До разрешения outcomePrices содержит текущие котировки рынка
// (например `["0.955", "0.045"]`), такие события мы возвращаем как result=null.

const SERIES_PREFIX = "btc-updown-5m";
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
  const event = arr[0];
  const market = event.markets?.[0];
  if (!market) {
    throw new Error(`Event "${slug}" has no markets`);
  }

  // outcomes / outcomePrices приходят как JSON-строки внутри JSON.
  const outcomes: string[] = JSON.parse(market.outcomes);
  const prices: string[] = JSON.parse(market.outcomePrices);

  // Признак "событие разрешено и можно достоверно сказать UP/DOWN":
  // closed=true И в ценах ровно одна "1" (вторая "0"). До разрешения цены
  // живые (например 0.955 / 0.045), поэтому сравниваем строго со строкой "1".
  const resolved =
    Boolean(event.closed) &&
    market.umaResolutionStatus === "resolved" &&
    prices.filter((p) => p === "1").length === 1;

  let result: UpDown | null = null;
  if (resolved) {
    const winnerIdx = prices.indexOf("1");
    const winner = outcomes[winnerIdx];
    if (winner === "Up") result = "UP";
    else if (winner === "Down") result = "DOWN";
    else throw new Error(`Unexpected winning outcome "${winner}" for slug "${slug}"`);
  }

  return {
    slug,
    startTimestamp: parseSlugTimestamp(slug),
    startTime: market.eventStartTime ?? event.startDate,
    resolved,
    result,
  };
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
 * Запросы к Gamma API делаются параллельно (Promise.all) — 4 события за один
 * заход быстрее, чем последовательно, и порядок гарантирован Promise.all.
 */
export async function getPastFiveMinuteEvents(slug: string): Promise<PastEvent[]> {
  const currentTs = parseSlugTimestamp(slug);
  const slugs = [1, 2, 3, 4].map((i) => buildSlug(currentTs - i * STEP_SECONDS));
  return Promise.all(slugs.map(fetchEventBySlug));
}

if (require.main === module) {
  const slug = process.argv[2];
  if (!slug) {
    console.error("Usage: ts-node src/events.ts <slug>");
    console.error("Example: ts-node src/events.ts btc-updown-5m-1777398300");
    process.exit(1);
  }
  getPastFiveMinuteEvents(slug)
    .then((events) => {
      console.log(JSON.stringify(events, null, 2));
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
