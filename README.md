# poly_buy

Instant buy of one Polymarket Shares token at a specified price (Node.js + TypeScript).

Implements one function — `buyShare(tokenID, price, shares?, orderType?)` — that submits a market buy
via the official `@polymarket/clob-client-v2` SDK. By default the order type is **FAK** (Fill-And-Kill):
the order fills as much as the book allows at no worse than `price`, and the unfilled remainder is
cancelled. Pass `OrderType.FOK` as the fourth argument for an all-or-nothing fill instead.

Assumptions baked in (per issue #3):
- Markets are always **binary (2 outcomes)**, so `negRisk` is hard-coded to `false`.
- USDC is held on the **EOA itself**, no proxy/Safe/funder address is used (`signatureType = 0`, no `funderAddress`).

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
import { OrderType } from "@polymarket/clob-client-v2";

// example token from the issue (Up Token of "BTC up/down 15m")
const UP = "102798729471478172396798624073366945217219721319224633719558071203801741630195";

await buyShare(UP, 0.45);                          // FAK buy of 1 share, max 0.45 per share
await buyShare(UP, 0.45, 10);                      // FAK buy targeting 10 shares
await buyShare(UP, 0.45, 10, OrderType.FOK);       // all-or-nothing
```

CLI:

```bash
npm run buy -- <tokenID> <price> [shares]

# example
npm run buy -- 102798729471478172396798624073366945217219721319224633719558071203801741630195 0.45
```

## Notes

- `price` acts as the worst acceptable execution price (slippage cap), per Polymarket's market-order spec.
- For BUY market orders Polymarket interprets `amount` as **USDC dollars to spend**, not shares. The
  function therefore submits `amount = price * shares` so that, in the worst case (every share fills
  exactly at `price`), the budget yields the requested number of shares; if the book is better than
  `price`, the same USDC budget buys at least as many shares.
- Market orders in Polymarket CLOB only accept `OrderType.FOK` or `OrderType.FAK`. Default is FAK
  because FOK requires the full size to be fillable at `≤ price` in one shot or the order is rejected.
- `tickSize` is fetched from the CLOB for the supplied token automatically.
