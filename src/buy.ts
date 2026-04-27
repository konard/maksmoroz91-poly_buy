import { ClobClient, Side, OrderType } from "@polymarket/clob-client-v2";
import { Wallet } from "@ethersproject/wallet";
import "dotenv/config";

// Хост CLOB и chainId Polygon. Значения по умолчанию — продакшн Polymarket.
const HOST = process.env.CLOB_HOST || "https://clob.polymarket.com";
const CHAIN_ID = Number(process.env.CHAIN_ID || 137);

/**
 * Мгновенная покупка `shares` штук токена `tokenID` по цене не хуже `price`.
 *
 * Аргументы:
 *  - tokenID: ERC1155 conditional-token ID (одна из двух сторон бинарного рынка).
 *  - price:   "потолок" цены за одну долю в долях единицы (например 0.45 = 45¢).
 *             Это НЕ целевая цена исполнения, а максимально допустимая (slippage cap).
 *  - shares:  сколько долей купить (по умолчанию 1).
 *
 * Почему такие решения (см. issue #3):
 *
 *  1) `amount: price * shares`, а НЕ `shares`.
 *     В Polymarket CLOB у market-ордера поле `amount` для BUY — это сумма в USDC,
 *     которую мы готовы потратить, а не количество долей. Для SELL, наоборот, это
 *     количество долей. Это явно прописано и в документации, и в типах SDK
 *     (UserMarketOrderV2.amount: "BUY orders: $$$ Amount to buy / SELL orders: Shares to sell").
 *     Поэтому, чтобы купить ровно `shares` штук по цене не хуже `price`, мы выделяем
 *     бюджет `price * shares` USDC: при цене ровно `price` его хватит на `shares` долей,
 *     а если книга даёт лучше — купим ту же или меньшую сумму USDC, но столько же или больше долей.
 *
 *  2) `negRisk: false` зашит жёстко.
 *     В задаче оговорено, что у нас ВСЕГДА только 2 исхода (обычный YES/NO рынок).
 *     Negative-risk рынки — это многоисходные рынки Polymarket, нам они не встречаются,
 *     поэтому лишний сетевой запрос `getNegRisk(tokenID)` убран.
 *
 *  3) Никакого `funderAddress`.
 *     По условию задачи USDC лежит на самом EOA-кошельке, прокси/funder не используется.
 *     Поэтому `signatureType = EOA (0)` и `funderAddress` явно не задаём — SDK сам
 *     возьмёт адрес подписанта.
 *
 *  4) Тип ордера — FAK (Fill-And-Kill), с возможностью переключить в FOK.
 *     Market-ордер в Polymarket поддерживает только FOK или FAK (см. типы SDK
 *     и docs.polymarket.com). Различие:
 *       FOK — либо полностью исполняется по цене ≤ price, либо отменяется целиком;
 *       FAK — исполняется на сколько хватает книги по цене ≤ price, остаток отменяется.
 *     Для «купить как можно ближе к нужному количеству, но не дороже price»
 *     корректнее FAK: FOK требует, чтобы вся запрашиваемая сумма была доступна
 *     по подходящей цене одним залпом, иначе ордер отменяется и мы не покупаем
 *     ничего. FAK сразу заберёт всё, что доступно, и остановится. По умолчанию
 *     поэтому FAK; при желании можно явно передать `OrderType.FOK`.
 */
export async function buyShare(
  tokenID: string,
  price: number,
  shares: number = 1,
  orderType: OrderType.FOK | OrderType.FAK = OrderType.FAK,
) {
  const signer = new Wallet(process.env.PRIVATE_KEY as string);

  // Bootstrap-клиент нужен только чтобы получить L2 API-ключ из подписи EOA.
  const bootstrap = new ClobClient({ host: HOST, chain: CHAIN_ID, signer });
  const creds = await bootstrap.createOrDeriveApiKey();

  // Рабочий клиент: signatureType = EOA (0), funder не задаём.
  const client = new ClobClient({
    host: HOST,
    chain: CHAIN_ID,
    signer,
    creds,
    signatureType: 0,
  });

  // tickSize у разных рынков разный (0.01, 0.001, …) — берём из CLOB.
  const tickSize = await client.getTickSize(tokenID);

  return client.createAndPostMarketOrder(
    {
      tokenID,
      price,
      // BUY: amount — это бюджет в USDC. См. пункт (1) выше.
      amount: price * shares,
      side: Side.BUY,
    },
    { tickSize, negRisk: false },
    orderType,
  );
}

if (require.main === module) {
  const [tokenID, priceArg, sharesArg] = process.argv.slice(2);
  if (!tokenID || !priceArg) {
    console.error("Usage: ts-node src/buy.ts <tokenID> <price> [shares]");
    process.exit(1);
  }
  buyShare(tokenID, Number(priceArg), sharesArg ? Number(sharesArg) : 1)
    .then((r) => {
      console.log(JSON.stringify(r, null, 2));
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
