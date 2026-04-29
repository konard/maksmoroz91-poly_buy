# poly_buy

Limit-order buy of one side of the **active 5-minute BTC up/down event** on
Polymarket (Node.js + TypeScript).

Implements one function — `buyShare(side, shares, price?)` — that:

1. Resolves the currently active `btc-updown-5m-<unix>` event from the Gamma API.
2. Picks the YES (Up) or NO (Down) `clobTokenIds` for the requested `side`.
3. If `price` is omitted, opens a WebSocket to the public Polymarket market channel
   (`wss://ws-subscriptions-clob.polymarket.com/ws/market`), subscribes to the
   event's two assets and uses the first `book` snapshot's best ask (best bid
   as fallback) as the limit price.
4. Submits a **limit order** (`OrderType.GTD`) via the official
   `@polymarket/clob-client-v2` SDK with `expiration = endDate` of the 5-minute
   window — after the window closes the market stops trading, so a hanging
   limit is useless and is auto-cancelled.

Assumptions baked in (per issue #3):
- Markets are always **binary (2 outcomes)**, so `negRisk` is hard-coded to `false`.
- USDC is held on the **EOA itself**, no proxy/Safe/funder address is used (`signatureType = 0`, no `funderAddress`).
- YES = Up, NO = Down (the `outcomes` order from Gamma is `["Up","Down"]` for this series).

## Setup

```bash
npm install
cp .env.example .env
# edit .env and set PRIVATE_KEY
```

The wallet must hold USDC.e on Polygon and have signed the Polymarket allowances. See [docs.polymarket.com](https://docs.polymarket.com/).

## Usage

Programmatic:

```ts
import { buyShare } from "./src/buy";

// 10 YES shares of the active 5-minute BTC event, limit price taken from
// the first WebSocket book snapshot.
await buyShare("YES", 10);

// 10 NO shares with an explicit limit price (45¢).
await buyShare("NO", 10, 0.45);
```

CLI:

```bash
npm run buy -- <YES|NO> <shares> [price]

# example: 10 YES shares with limit auto-detected from WebSocket
npm run buy -- YES 10

# example: 10 NO shares at 0.45 limit
npm run buy -- NO 10 0.45
```

## Notes

- **Limit price.** `price` is the maximum price per share you are willing to pay
  (in dollars per contract, e.g. `0.45 = 45¢`). It is rounded **down** to the
  market's `tickSize` (typically `0.01` for the 5-minute series) — so the actual
  limit is never higher than what you asked for.
- **WebSocket "first price".** When `price` is omitted, the function opens a
  WebSocket subscription to the market channel for both `assets_ids` of the
  event and waits for the first `event_type: "book"` message for the requested
  side. It uses `min(asks.price)` (best ask) when available, falling back to
  `max(bids.price)` (best bid). Times out after `WS_FIRST_PRICE_TIMEOUT_MS`
  (default 10s) if the book never arrives.
- **GTD expiration.** The order expires at the event's `endDate` minus 1 second
  (Polymarket's `OrderType.GTD`). After the 5-minute window closes the market
  stops accepting orders, so any unfilled remainder is dropped automatically.
- **`shares`** is in conditional-token contracts. The current market enforces
  `orderMinSize = 5` — passing fewer is rejected up-front before the round-trip.
- The active slug is computed locally as `floor(now/300)*300` (see `events.ts`),
  so resolving the active event is a single Gamma API call.
- Past-event helpers from issue #5/#7/#9/#11/#13 live in `src/events.ts` and are
  unchanged.
