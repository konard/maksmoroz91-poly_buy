import { ClobClient, Side, OrderType } from "@polymarket/clob-client-v2";
import { Wallet } from "@ethersproject/wallet";
import "dotenv/config";

const HOST = process.env.CLOB_HOST || "https://clob.polymarket.com";
const CHAIN_ID = Number(process.env.CHAIN_ID || 137);

export async function buyShare(tokenID: string, price: number, shares: number = 1) {
  const signer = new Wallet(process.env.PRIVATE_KEY as string);
  const funderAddress = process.env.FUNDER_ADDRESS || signer.address;

  const bootstrap = new ClobClient({ host: HOST, chain: CHAIN_ID, signer });
  const creds = await bootstrap.createOrDeriveApiKey();

  const client = new ClobClient({
    host: HOST,
    chain: CHAIN_ID,
    signer,
    creds,
    signatureType: 0,
    funderAddress,
  });

  const tickSize = await client.getTickSize(tokenID);
  const negRisk = await client.getNegRisk(tokenID);

  return client.createAndPostMarketOrder(
    {
      tokenID,
      price,
      amount: price * shares,
      side: Side.BUY,
    },
    { tickSize, negRisk },
    OrderType.FOK,
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
