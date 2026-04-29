// Тесты для src/buy.ts. Полностью локальные: поднимают свой WS-сервер и
// моки fetch/ClobClient, поэтому не требуют сети, ключей и доступа к Polymarket.
//
// Запуск: `npm test` (под капотом ts-node src/test/buy.test.ts).

import { WebSocketServer } from "ws";
import * as http from "http";
import { AddressInfo } from "net";

// Чтобы тесты не пытались обратиться к реальному Polymarket, выставляем хосты
// до подключения buy.ts (он читает их при импорте).
const wsServer = http.createServer();
const wss = new WebSocketServer({ server: wsServer });

let lastSubscription: any = null;
let bookToSend: { asset_id: string; bids?: any[]; asks?: any[] } | null = null;

wss.on("connection", (sock) => {
  sock.on("message", (raw) => {
    try {
      lastSubscription = JSON.parse(raw.toString());
    } catch {
      lastSubscription = null;
    }
    if (bookToSend) {
      sock.send(JSON.stringify({ event_type: "book", ...bookToSend }));
    }
  });
});

let assertions = 0;
let failed = 0;
function check(name: string, cond: boolean, detail?: string) {
  assertions++;
  if (cond) {
    console.log(`ok - ${name}`);
  } else {
    failed++;
    console.error(`not ok - ${name}${detail ? `: ${detail}` : ""}`);
  }
}

async function main() {
  await new Promise<void>((res) => wsServer.listen(0, "127.0.0.1", () => res()));
  const port = (wsServer.address() as AddressInfo).port;
  process.env.POLY_WS_HOST = `ws://127.0.0.1:${port}`;
  process.env.WS_FIRST_PRICE_TIMEOUT_MS = "2000";
  // Не дать buyShare случайно полезть в реальный CLOB.
  process.env.PRIVATE_KEY =
    "0x" + "11".repeat(32);

  // Импортируем после установки env.
  const { buyShare, fetchFirstPriceFromWs, fetchActiveBtcEvent } = await import(
    "../src/buy"
  );

  // ---- 1) fetchFirstPriceFromWs: best ask из первого book ----
  bookToSend = {
    asset_id: "TOKEN_A",
    asks: [{ price: "0.55", size: "100" }, { price: "0.54", size: "30" }],
    bids: [{ price: "0.50", size: "20" }, { price: "0.49", size: "60" }],
  };
  const p1 = await fetchFirstPriceFromWs("TOKEN_A", "TOKEN_B", 2000);
  check("fetchFirstPriceFromWs returns best ask", Math.abs(p1 - 0.54) < 1e-9, `got ${p1}`);
  check(
    "subscribed with both assets and type=market",
    lastSubscription?.type === "market" &&
      Array.isArray(lastSubscription?.assets_ids) &&
      lastSubscription.assets_ids.includes("TOKEN_A") &&
      lastSubscription.assets_ids.includes("TOKEN_B"),
    JSON.stringify(lastSubscription),
  );

  // ---- 2) fetchFirstPriceFromWs: пустые asks → best bid ----
  bookToSend = {
    asset_id: "TOKEN_A",
    asks: [],
    bids: [{ price: "0.30", size: "10" }, { price: "0.32", size: "5" }],
  };
  const p2 = await fetchFirstPriceFromWs("TOKEN_A", "TOKEN_B", 2000);
  check("fetchFirstPriceFromWs falls back to best bid", Math.abs(p2 - 0.32) < 1e-9, `got ${p2}`);

  // ---- 3) fetchFirstPriceFromWs: пустая книга → ошибка ----
  bookToSend = { asset_id: "TOKEN_A", asks: [], bids: [] };
  let threw = false;
  try {
    await fetchFirstPriceFromWs("TOKEN_A", "TOKEN_B", 1000);
  } catch (e: any) {
    threw = /no usable price/i.test(String(e?.message ?? e));
  }
  check("fetchFirstPriceFromWs throws on empty book", threw);

  // ---- 4) fetchFirstPriceFromWs: timeout, если не пришёл book ----
  bookToSend = null;
  threw = false;
  const t0 = Date.now();
  try {
    await fetchFirstPriceFromWs("TOKEN_A", "TOKEN_B", 300);
  } catch (e: any) {
    threw = /timed out/i.test(String(e?.message ?? e));
  }
  const elapsed = Date.now() - t0;
  check(
    "fetchFirstPriceFromWs respects timeout",
    threw && elapsed >= 250 && elapsed < 1500,
    `elapsed=${elapsed}ms`,
  );

  // ---- 5) fetchActiveBtcEvent: парсит ответ Gamma и отдаёт YES/NO токены ----
  const activeSlug = (await import("../src/events")).getActiveSlug();
  const fakeGamma = [
    {
      slug: activeSlug,
      endDate: "2099-01-01T00:00:00Z",
      markets: [
        {
          outcomes: '["Up", "Down"]',
          clobTokenIds: '["TOKEN_UP","TOKEN_DOWN"]',
          orderPriceMinTickSize: 0.01,
          orderMinSize: 5,
          endDate: "2099-01-01T00:00:00Z",
        },
      ],
    },
  ];
  const origFetch = globalThis.fetch;
  (globalThis as any).fetch = async (url: string) => {
    if (typeof url === "string" && url.includes(`slug=${encodeURIComponent(activeSlug)}`)) {
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => fakeGamma,
      } as any;
    }
    return { ok: false, status: 404, statusText: "Not Found", json: async () => [] } as any;
  };
  const ev = await fetchActiveBtcEvent();
  check("fetchActiveBtcEvent parses YES = Up token", ev.tokens.yes === "TOKEN_UP");
  check("fetchActiveBtcEvent parses NO = Down token", ev.tokens.no === "TOKEN_DOWN");
  check("fetchActiveBtcEvent reads tickSize", ev.tickSize === "0.01");
  check("fetchActiveBtcEvent reads orderMinSize", ev.orderMinSize === 5);

  // Если outcomes пришли в обратном порядке — сопоставление YES/NO
  // должно остаться корректным.
  fakeGamma[0].markets[0].outcomes = '["Down", "Up"]';
  fakeGamma[0].markets[0].clobTokenIds = '["TOKEN_DOWN","TOKEN_UP"]';
  const ev2 = await fetchActiveBtcEvent();
  check(
    "fetchActiveBtcEvent maps YES/NO regardless of outcomes order",
    ev2.tokens.yes === "TOKEN_UP" && ev2.tokens.no === "TOKEN_DOWN",
    JSON.stringify(ev2.tokens),
  );

  // ---- 6) buyShare: невалидные аргументы рантайма ----
  threw = false;
  try {
    await buyShare("MAYBE" as any, 10, 0.45);
  } catch (e: any) {
    threw = /Invalid side/i.test(String(e?.message ?? e));
  }
  check("buyShare rejects invalid side", threw);

  threw = false;
  try {
    await buyShare("YES", -1, 0.45);
  } catch (e: any) {
    threw = /Invalid shares/i.test(String(e?.message ?? e));
  }
  check("buyShare rejects non-positive shares", threw);

  threw = false;
  try {
    await buyShare("YES", 10, 1.5);
  } catch (e: any) {
    threw = /Invalid price/i.test(String(e?.message ?? e));
  }
  check("buyShare rejects price >= 1", threw);

  // shares ниже orderMinSize.
  fakeGamma[0].markets[0].outcomes = '["Up", "Down"]';
  fakeGamma[0].markets[0].clobTokenIds = '["TOKEN_UP","TOKEN_DOWN"]';
  threw = false;
  try {
    await buyShare("YES", 1, 0.45);
  } catch (e: any) {
    threw = /below market orderMinSize/i.test(String(e?.message ?? e));
  }
  check("buyShare rejects shares below orderMinSize", threw);

  (globalThis as any).fetch = origFetch;

  // ---- финал ----
  await new Promise<void>((res) => wsServer.close(() => res()));
  console.log(`\n${assertions - failed}/${assertions} checks passed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error("test runner crashed:", e);
  process.exit(1);
});
