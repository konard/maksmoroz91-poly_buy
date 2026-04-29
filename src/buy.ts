// Покупка одной из двух сторон активного 5-минутного BTC-события
// серии "BTC Up or Down 5m" лимитным ордером (issue #15).
//
// Как это работает
// ----------------
// 1) Определяем активное окно. Серия "btc-updown-5m" идёт сеткой по 300 секунд
//    от unix-эпохи (см. events.ts), поэтому слаг активного окна вычисляется
//    локально без сетевых запросов:
//        active = floor(now / 300) * 300
//        slug   = `btc-updown-5m-${active}`
// 2) Резолвим токены. По slug'у запрашиваем Gamma API, оттуда берём
//    `markets[0].clobTokenIds` (массив из 2 строк в порядке `outcomes`,
//    т.е. `[Up, Down]`) и `endDate` окна. YES = Up, NO = Down — это
//    стандартное соответствие для "Up or Down" рынков Polymarket.
// 3) Берём актуальную цену по WebSocket. Подключаемся к публичному market-каналу
//    `wss://ws-subscriptions-clob.polymarket.com/ws/market`, подписываемся на
//    оба asset_ids и ждём первое сообщение `book` для нужной стороны. Это и есть
//    "первая цена для события (YES/NO)" из условия задачи. На BUY-ордере нас
//    интересует лучший ask (по нему нам реально продадут), но если книга пустая
//    с одной стороны — берём середину (mid). Это даёт ориентир для лимита.
// 4) Постим лимит-ордер. Тип — GTD (Good-Til-Date) с истечением в `endDate`
//    окна: лимитник на 5-минутке имеет смысл только до конца окна, после
//    закрытия рынок не торгуется и ордер бесполезен. Размер — `shares`,
//    цена — переданный аргумент `price` (если опущен — берём из WebSocket).
//
// Параметры функции `buyShare(side, shares, price?)`:
//   - side:   "YES" (Up) или "NO" (Down).
//   - shares: количество контрактов; для текущего рынка `orderMinSize = 5`,
//             поэтому это нижняя граница (валидируется на стороне CLOB).
//   - price:  лимит-цена в долях единицы (например 0.45 = 45¢). Если не передан —
//             берётся "первая цена" с WebSocket. Тик у активного окна обычно
//             0.01, цена округляется до тика вниз (для BUY это безопаснее —
//             не повышаем лимит).
//
// Допущения, унаследованные из старого buy.ts (issue #3):
//   - бинарный рынок (`negRisk = false`), 2 исхода;
//   - USDC лежит на самом EOA, прокси/funder не используется
//     (`signatureType = 0`, `funderAddress` не задаём).

import { ClobClient, Side, OrderType } from "@polymarket/clob-client-v2";
import { Wallet } from "@ethersproject/wallet";
// `ws` подтягивается транзитивно через @polymarket/clob-client-v2 (axios → ws),
// поэтому отдельной зависимости не требует. Глобальный WebSocket в Node 20 ещё
// под флагом, поэтому используем именно `ws`.
import WebSocket from "ws";
import "dotenv/config";

import { getActiveSlug } from "./events";

const HOST = process.env.CLOB_HOST || "https://clob.polymarket.com";
const GAMMA_HOST = process.env.GAMMA_HOST || "https://gamma-api.polymarket.com";
const WS_HOST =
  process.env.POLY_WS_HOST || "wss://ws-subscriptions-clob.polymarket.com/ws/market";
const CHAIN_ID = Number(process.env.CHAIN_ID || 137);

// Сколько ждать первое сообщение `book` от WebSocket, прежде чем сдаться.
const WS_FIRST_PRICE_TIMEOUT_MS = Number(process.env.WS_FIRST_PRICE_TIMEOUT_MS || 10_000);

export type Side01 = "YES" | "NO";

/** TickSize-литералы, которые принимает SDK. */
type TickSizeStr = "0.1" | "0.01" | "0.001" | "0.0001";

export interface ActiveEvent {
  slug: string;
  /** Конец 5-минутного окна, unix-секунды UTC. */
  endDateSeconds: number;
  /** Минимальный шаг цены для постановки лимит-ордера. */
  tickSize: TickSizeStr;
  /** Минимальный размер ордера в контрактах. */
  orderMinSize: number;
  /** clobTokenIds в порядке outcomes — [UpToken, DownToken]. */
  tokens: { yes: string; no: string };
}

function toTickSize(raw: unknown): TickSizeStr {
  const allowed: TickSizeStr[] = ["0.1", "0.01", "0.001", "0.0001"];
  const asNumber = Number(raw);
  if (Number.isFinite(asNumber) && asNumber > 0) {
    // toString может дать "0.001" / "0.01" / "0.1" — это и есть формат SDK.
    const s = String(asNumber) as TickSizeStr;
    if (allowed.includes(s)) return s;
  }
  if (typeof raw === "string" && allowed.includes(raw as TickSizeStr)) {
    return raw as TickSizeStr;
  }
  throw new Error(`Unsupported tickSize ${JSON.stringify(raw)}, expected one of ${allowed.join(", ")}`);
}

interface BookLevel {
  price: string;
  size: string;
}

interface BookMessage {
  event_type: "book";
  asset_id: string;
  bids?: BookLevel[];
  asks?: BookLevel[];
}

/**
 * Резолвим активное 5-минутное событие BTC: его slug, окончание окна,
 * токен-ID для YES (Up) и NO (Down). Тики и orderMinSize получаем из того
 * же ответа Gamma API, чтобы не делать лишних запросов.
 */
export async function fetchActiveBtcEvent(nowMs: number = Date.now()): Promise<ActiveEvent> {
  const slug = getActiveSlug(nowMs);
  const url = `${GAMMA_HOST}/events?slug=${encodeURIComponent(slug)}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Gamma API ${res.status} ${res.statusText} for active slug "${slug}"`);
  }
  const arr = (await res.json()) as any[];
  if (!Array.isArray(arr) || arr.length === 0) {
    throw new Error(`Active event not found for slug "${slug}"`);
  }
  const event = arr[0];
  const market = event?.markets?.[0];
  if (!market) {
    throw new Error(`Active event "${slug}" has no markets`);
  }

  const outcomes: string[] = JSON.parse(market.outcomes);
  const tokenIds: string[] = JSON.parse(market.clobTokenIds);
  if (outcomes.length !== 2 || tokenIds.length !== 2) {
    throw new Error(`Active event "${slug}" is not a binary market`);
  }
  // Полагаемся на то, что Polymarket ставит "Up" первым, "Down" вторым.
  // Если порядок вдруг поменяется — явно мапим по имени, чтобы не перепутать.
  const upIdx = outcomes.findIndex((o) => o.toLowerCase() === "up");
  const downIdx = outcomes.findIndex((o) => o.toLowerCase() === "down");
  if (upIdx === -1 || downIdx === -1) {
    throw new Error(`Active event "${slug}" outcomes are not Up/Down: ${JSON.stringify(outcomes)}`);
  }

  const endDateRaw = market.endDate ?? event.endDate;
  if (!endDateRaw) {
    throw new Error(`Active event "${slug}" has no endDate`);
  }
  const endDateSeconds = Math.floor(new Date(endDateRaw).getTime() / 1000);

  const tickSize = toTickSize(market.orderPriceMinTickSize ?? 0.01);
  const orderMinSize = Number(market.orderMinSize ?? 5);

  return {
    slug,
    endDateSeconds,
    tickSize,
    orderMinSize,
    tokens: { yes: String(tokenIds[upIdx]), no: String(tokenIds[downIdx]) },
  };
}

/**
 * Открывает WebSocket к market-каналу Polymarket, подписывается на оба токена
 * события и возвращает первую цену для запрошенной стороны.
 *
 * Что значит "первая цена":
 *   После подписки сервер сразу шлёт `event_type: "book"` — снэпшот стакана.
 *   Для BUY-ордера ориентир — лучший `ask` (минимальная цена продавца, по
 *   которой реально купить). Если на этой стороне `asks` пуст, используем
 *   лучший `bid` — он же мажорная котировка стороны. Если вообще ничего нет,
 *   падаем с понятной ошибкой, чтобы caller знал, что цены ещё нет.
 */
export async function fetchFirstPriceFromWs(
  assetId: string,
  pairAssetId: string,
  timeoutMs: number = WS_FIRST_PRICE_TIMEOUT_MS,
): Promise<number> {
  const ws = new WebSocket(WS_HOST);

  return await new Promise<number>((resolve, reject) => {
    let settled = false;
    const finish = (err: Error | null, value?: number) => {
      if (settled) return;
      settled = true;
      try {
        ws.close();
      } catch {
        // ignore
      }
      if (err) reject(err);
      else resolve(value as number);
    };

    const timer = setTimeout(
      () =>
        finish(
          new Error(
            `Timed out waiting for first book on asset_id=${assetId} after ${timeoutMs}ms`,
          ),
        ),
      timeoutMs,
    );

    ws.on("open", () => {
      ws.send(
        JSON.stringify({
          assets_ids: [assetId, pairAssetId],
          type: "market",
        }),
      );
    });

    ws.on("error", (err: Error) => {
      clearTimeout(timer);
      finish(new Error(`WebSocket error: ${err?.message ?? "unknown"}`));
    });

    ws.on("message", (data: WebSocket.RawData) => {
      // Polymarket иногда шлёт массивы сообщений, иногда — одиночные объекты.
      let payload: unknown;
      try {
        payload = JSON.parse(data.toString());
      } catch {
        return;
      }
      const msgs: any[] = Array.isArray(payload) ? payload : [payload];
      for (const msg of msgs) {
        if (msg?.event_type !== "book") continue;
        if (msg.asset_id !== assetId) continue;
        const book = msg as BookMessage;
        const asks = Array.isArray(book.asks) ? book.asks.map((a) => Number(a.price)) : [];
        const bids = Array.isArray(book.bids) ? book.bids.map((b) => Number(b.price)) : [];
        const bestAsk = asks.length ? Math.min(...asks) : null;
        const bestBid = bids.length ? Math.max(...bids) : null;
        const price = bestAsk ?? bestBid;
        if (price !== null && Number.isFinite(price) && price > 0) {
          clearTimeout(timer);
          finish(null, price);
          return;
        }
        // Книга пустая — вернём ошибку, лимит-цену придётся передать вручную.
        clearTimeout(timer);
        finish(
          new Error(
            `First book for asset_id=${assetId} has no usable price ` +
              `(asks=${asks.length}, bids=${bids.length})`,
          ),
        );
        return;
      }
    });
  });
}

/** Округление вниз до ближайшего тика — безопасно для BUY-лимита. */
function roundDownToTick(price: number, tickSize: TickSizeStr): number {
  const t = Number(tickSize);
  if (!Number.isFinite(price) || !Number.isFinite(t) || t <= 0) {
    return price;
  }
  // Считаем в «тиках», чтобы избежать накопленной плавающей ошибки.
  const ticks = Math.floor(price / t + 1e-9);
  // Сохраняем разумное число знаков после запятой исходя из величины тика.
  const decimals = Math.max(0, Math.ceil(-Math.log10(t)));
  return Number((ticks * t).toFixed(decimals));
}

/**
 * Главная функция: лимит-покупка указанной стороны активного 5-минутного
 * BTC-события. Возвращает ответ CLOB на постановку ордера.
 *
 * Аргументы:
 *   - side:   "YES" (Up) или "NO" (Down).
 *   - shares: количество контрактов (учитывая `orderMinSize` рынка, обычно 5).
 *   - price:  лимит-цена; если не передан — берём первую цену с WebSocket.
 */
export async function buyShare(side: Side01, shares: number, price?: number) {
  if (side !== "YES" && side !== "NO") {
    throw new Error(`Invalid side "${side}", expected "YES" or "NO"`);
  }
  if (!Number.isFinite(shares) || shares <= 0) {
    throw new Error(`Invalid shares=${shares}, must be a positive number`);
  }

  const event = await fetchActiveBtcEvent();
  const tokenID = side === "YES" ? event.tokens.yes : event.tokens.no;
  const pairTokenID = side === "YES" ? event.tokens.no : event.tokens.yes;

  let limitPrice: number;
  if (price === undefined || price === null) {
    limitPrice = await fetchFirstPriceFromWs(tokenID, pairTokenID);
  } else {
    if (!Number.isFinite(price) || price <= 0 || price >= 1) {
      throw new Error(`Invalid price=${price}, must be in (0, 1)`);
    }
    limitPrice = price;
  }
  // CLOB отвергает цены не кратные tickSize. Округляем вниз — для BUY это
  // означает «не дороже, чем просили».
  limitPrice = roundDownToTick(limitPrice, event.tickSize);
  if (limitPrice <= 0) {
    throw new Error(
      `Computed limit price ${limitPrice} is non-positive after tick rounding (tick=${event.tickSize})`,
    );
  }

  if (shares < event.orderMinSize) {
    throw new Error(
      `shares=${shares} is below market orderMinSize=${event.orderMinSize}`,
    );
  }

  const signer = new Wallet(process.env.PRIVATE_KEY as string);

  const bootstrap = new ClobClient({ host: HOST, chain: CHAIN_ID, signer });
  const creds = await bootstrap.createOrDeriveApiKey();

  const client = new ClobClient({
    host: HOST,
    chain: CHAIN_ID,
    signer,
    creds,
    signatureType: 0,
  });

  // GTD до конца окна: после закрытия рынок не торгуется, висящий лимит
  // бесполезен. Минимально безопасный лаг (-1с) — не упрёмся в погрешности
  // часов CLOB.
  const expiration = Math.max(event.endDateSeconds - 1, Math.floor(Date.now() / 1000) + 1);

  return client.createAndPostOrder(
    {
      tokenID,
      price: limitPrice,
      size: shares,
      side: Side.BUY,
      expiration,
    },
    { tickSize: event.tickSize, negRisk: false },
    OrderType.GTD,
  );
}

if (require.main === module) {
  const [sideArg, sharesArg, priceArg] = process.argv.slice(2);
  if (!sideArg || !sharesArg) {
    console.error("Usage: ts-node src/buy.ts <YES|NO> <shares> [price]");
    process.exit(1);
  }
  const side = sideArg.toUpperCase() as Side01;
  const shares = Number(sharesArg);
  const price = priceArg !== undefined ? Number(priceArg) : undefined;
  buyShare(side, shares, price)
    .then((r) => {
      console.log(JSON.stringify(r, null, 2));
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
