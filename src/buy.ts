// Покупка одной из двух сторон активного 5-минутного BTC up/down события
// Polymarket лимитным ордером.
//
// Скрипт запускается в самом начале 5-минутного окна, когда YES и NO стоят
// примерно по 50¢, поэтому лимит-цена жёстко 0.50.
//
// Хосты и WebSocket прописаны в коде. Из окружения берётся только
// `PRIVATE_KEY` — приватный ключ EOA с USDC, которым подписываем ордер.

import { ClobClient, Side, OrderType } from "@polymarket/clob-client-v2";
import { Wallet } from "@ethersproject/wallet";
import "dotenv/config";

const CLOB_HOST = "https://clob.polymarket.com";
const GAMMA_HOST = "https://gamma-api.polymarket.com";
const CHAIN_ID = 137;

const STEP_SECONDS = 300;
const LIMIT_PRICE = 0.5;
const TICK_SIZE = "0.01" as const;

export type Side01 = "YES" | "NO";

function getActiveSlug(nowMs: number = Date.now()): string {
  const windowStart = Math.floor(nowMs / 1000 / STEP_SECONDS) * STEP_SECONDS;
  return `btc-updown-5m-${windowStart}`;
}

async function fetchActiveEvent() {
  const slug = getActiveSlug();
  const res = await fetch(`${GAMMA_HOST}/events?slug=${encodeURIComponent(slug)}`);
  if (!res.ok) throw new Error(`Gamma ${res.status} for slug "${slug}"`);
  const arr = (await res.json()) as any[];
  const market = arr?.[0]?.markets?.[0];
  if (!market) throw new Error(`Active event not found for slug "${slug}"`);

  const outcomes: string[] = JSON.parse(market.outcomes);
  const tokenIds: string[] = JSON.parse(market.clobTokenIds);
  const upIdx = outcomes.findIndex((o) => o.toLowerCase() === "up");
  const downIdx = outcomes.findIndex((o) => o.toLowerCase() === "down");
  if (upIdx === -1 || downIdx === -1) {
    throw new Error(`Outcomes are not Up/Down: ${JSON.stringify(outcomes)}`);
  }

  const endDateRaw = market.endDate ?? arr[0].endDate;
  const expiration = Math.floor(new Date(endDateRaw).getTime() / 1000) - 1;

  return {
    yes: String(tokenIds[upIdx]),
    no: String(tokenIds[downIdx]),
    expiration,
  };
}

export async function buyShare(side: Side01, shares: number) {
  if (side !== "YES" && side !== "NO") {
    throw new Error(`Invalid side "${side}", expected "YES" or "NO"`);
  }
  if (!Number.isFinite(shares) || shares <= 0) {
    throw new Error(`Invalid shares=${shares}, must be a positive number`);
  }

  const event = await fetchActiveEvent();
  const tokenID = side === "YES" ? event.yes : event.no;

  const signer = new Wallet(process.env.PRIVATE_KEY as string);
  const bootstrap = new ClobClient({ host: CLOB_HOST, chain: CHAIN_ID, signer });
  const creds = await bootstrap.createOrDeriveApiKey();
  const client = new ClobClient({
    host: CLOB_HOST,
    chain: CHAIN_ID,
    signer,
    creds,
    signatureType: 0,
  });

  return client.createAndPostOrder(
    {
      tokenID,
      price: LIMIT_PRICE,
      size: shares,
      side: Side.BUY,
      expiration: event.expiration,
    },
    { tickSize: TICK_SIZE, negRisk: false },
    OrderType.GTD,
  );
}

if (require.main === module) {
  const [sideArg, sharesArg] = process.argv.slice(2);
  if (!sideArg || !sharesArg) {
    console.error("Usage: ts-node src/buy.ts <YES|NO> <shares>");
    process.exit(1);
  }
  buyShare(sideArg.toUpperCase() as Side01, Number(sharesArg))
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
