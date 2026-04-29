# poly_buy

Limit-order buy of one side of the active 5-minute BTC up/down event on
Polymarket (Node.js + TypeScript).

The script is meant to be launched at the very start of a 5-minute window,
when both YES (Up) and NO (Down) trade around 50¢, so the limit price is
hardcoded to `0.50`.

## Setup

```bash
npm install
cp .env.example .env
# edit .env and set PRIVATE_KEY
```

The wallet must hold USDC.e on Polygon and have signed the Polymarket
allowances. See [docs.polymarket.com](https://docs.polymarket.com/).

## Usage

Programmatic:

```ts
import { buyShare } from "./src/buy";

// 10 YES shares of the active 5-minute BTC event at 0.50.
await buyShare("YES", 10);

// 10 NO shares of the active 5-minute BTC event at 0.50.
await buyShare("NO", 10);
```

CLI:

```bash
npm run buy -- <YES|NO> <shares>

# example: 10 YES shares
npm run buy -- YES 10

# example: 10 NO shares
npm run buy -- NO 10
```

## Notes

- All hosts (`https://clob.polymarket.com`, `https://gamma-api.polymarket.com`)
  and the chain id (137 = Polygon mainnet) are hardcoded in `src/buy.ts`.
- The active 5-minute window is computed locally as `floor(now/300)*300` —
  resolving the event takes a single Gamma API call.
- Order type is **GTD** (Good-Til-Date) with `expiration = endDate - 1s`:
  after the window closes the market stops trading, so any unfilled remainder
  is dropped automatically.
- `shares` is in conditional-token contracts. The current market enforces
  `orderMinSize = 5`; smaller orders are rejected by the CLOB.
