# poly_buy

Instant buy of one Polymarket Shares token at a specified price (Node.js + TypeScript).

Implements one function — `buyShare(tokenID, price, shares?)` — that submits a Fill-Or-Kill (FOK) market buy via the official `@polymarket/clob-client-v2` SDK. The order either fills immediately and entirely at no worse than `price`, or is cancelled.

## Setup

```bash
npm install
cp .env.example .env
# edit .env and set PRIVATE_KEY (and optionally FUNDER_ADDRESS)
```

The wallet must hold USDC.e on Polygon and have signed the Polymarket allowances. See [docs.polymarket.com](https://docs.polymarket.com/).

## Usage

Programmatic:

```ts
import { buyShare } from "./src/buy";

// example token from the issue (Up Token of "BTC up/down 15m")
const UP = "102798729471478172396798624073366945217219721319224633719558071203801741630195";

await buyShare(UP, 0.45);          // buy 1 share at price 0.45
await buyShare(UP, 0.45, 10);      // buy 10 shares with 0.45 as the slippage cap
```

CLI:

```bash
npm run buy -- <tokenID> <price> [shares]

# example
npm run buy -- 102798729471478172396798624073366945217219721319224633719558071203801741630195 0.45
```

## Notes

- `price` acts as the worst acceptable execution price (slippage cap), per Polymarket's market-order spec.
- The order type is FOK, so the entire `shares` quantity must be available on the book; otherwise the request is rejected and nothing fills.
- `tickSize` and `negRisk` are fetched from the CLOB for the supplied token automatically.
