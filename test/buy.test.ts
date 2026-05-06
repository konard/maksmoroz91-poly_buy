// Минимальный набор проверок для `src/buy.ts` после миграции на viem signer
// (issue #25). Запуск: `npm test`. Тесты намеренно не делают сетевых запросов
// и не подписывают реальных ордеров — мы только убеждаемся что:
//
//   1. Локальная валидация аргументов `buyShare` отбрасывает неверный side и
//      непозитивные/нечисловые `shares` ДО любого сетевого вызова. Это страхует
//      нас от того, что миграция signer'а случайно поломала вход функции.
//   2. `getClient()` собирается из viem-`WalletClient` (а не ethers Wallet) —
//      проверяем, что переданный в `ClobClient` signer выглядит как viem
//      WalletClient (`signTypedData` есть, `_signTypedData` отсутствует).
//
// Используем встроенный `node:test` чтобы не тащить дополнительный фреймворк.

import { strict as assert } from "node:assert";
import { test } from "node:test";
import Module from "node:module";

// --- shared mock state for ClobClient ----------------------------------------

interface CapturedConfig {
  host: string;
  chain: number;
  signer: any;
  creds?: unknown;
  signatureType?: number;
}

const captured: { configs: CapturedConfig[] } = { configs: [] };

class FakeClobClient {
  config: CapturedConfig;
  constructor(config: CapturedConfig) {
    this.config = config;
    captured.configs.push(config);
  }
  async createOrDeriveApiKey() {
    return { key: "k", secret: "s", passphrase: "p" };
  }
  async createAndPostOrder() {
    return { success: true };
  }
}

// Подменяем `@polymarket/clob-client-v2` через резолвер модулей Node, чтобы
// `import` в `src/buy.ts` выдавал нам мок. Делаем это ДО первого `require`
// модуля под тестом.
const originalResolve = (Module as any)._resolveFilename;
const originalLoad = (Module as any)._load;

(Module as any)._load = function patchedLoad(
  request: string,
  parent: unknown,
  isMain: boolean,
) {
  if (request === "@polymarket/clob-client-v2") {
    return {
      ClobClient: FakeClobClient,
      Side: { BUY: "BUY", SELL: "SELL" },
      OrderType: { GTC: "GTC", GTD: "GTD", FOK: "FOK", FAK: "FAK" },
    };
  }
  return originalLoad.apply(this, [request, parent, isMain]);
};

// Гарантируем, что `getClient()` не упадёт на отсутствии PRIVATE_KEY.
// Используем заведомо валидный (но фейковый) ключ для viem.
process.env.PRIVATE_KEY =
  "0x0123456789012345678901234567890123456789012345678901234567890123";

// Импортируем модуль под тестом ПОСЛЕ установки моков и env.
// Используем `require` вместо `import` чтобы порядок был детерминирован.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { buyShare } = require("../src/buy") as typeof import("../src/buy");

test("buyShare rejects invalid side", async () => {
  await assert.rejects(
    () => buyShare("MAYBE" as any, 5),
    /Invalid side "MAYBE"/,
  );
});

test("buyShare rejects non-positive shares", async () => {
  await assert.rejects(() => buyShare("YES", 0), /Invalid shares=0/);
  await assert.rejects(() => buyShare("YES", -1), /Invalid shares=-1/);
  await assert.rejects(() => buyShare("YES", NaN), /Invalid shares=NaN/);
});

test("getClient builds a viem WalletClient (not ethers Wallet)", async () => {
  // Триггерим инициализацию клиента через полный путь `buyShare`. Чтобы не
  // лезть в реальный Gamma API, мокаем `fetch` валидным ответом события.
  // Дальше в коде создаётся bootstrap ClobClient (попадает в `captured`) и,
  // после `createOrDeriveApiKey`, fully-authenticated клиент.
  const realFetch = (global as any).fetch;
  (global as any).fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => [
      {
        endDate: "2099-01-01T00:00:00Z",
        markets: [
          {
            outcomes: JSON.stringify(["Up", "Down"]),
            clobTokenIds: JSON.stringify(["111", "222"]),
            endDate: "2099-01-01T00:00:00Z",
          },
        ],
      },
    ],
  });

  try {
    await buyShare("YES", 5).catch(() => undefined);
  } finally {
    (global as any).fetch = realFetch;
  }

  assert.ok(
    captured.configs.length >= 1,
    "expected at least one ClobClient instantiation",
  );
  const signer = captured.configs[0].signer;
  // viem WalletClient: имеет camelCase `signTypedData`.
  assert.equal(
    typeof signer.signTypedData,
    "function",
    "signer should expose viem signTypedData",
  );
  // ethers v5 Wallet: имеет underscore `_signTypedData`. Его быть не должно.
  assert.equal(
    typeof signer._signTypedData,
    "undefined",
    "signer should NOT expose ethers _signTypedData",
  );
  // viem WalletClient несёт `account` с адресом; ethers Wallet — нет.
  assert.ok(signer.account, "viem WalletClient should expose `account`");
  assert.equal(typeof signer.account.address, "string");
});

test("ClobClient is constructed without funderAddress (EOA defaults to signer)", async () => {
  // Для standalone EOA (signatureType: 0) `funderAddress` опционален — пакет
  // в этом случае использует адрес самого signer'а (см. `createOrder` →
  // `funderAddress === undefined ? eoaSignerAddress : funderAddress`).
  const second = captured.configs.find((c) => c.creds);
  assert.ok(second, "expected fully-authenticated ClobClient to be created");
  assert.equal((second as any).funderAddress, undefined);
  assert.equal(second.signatureType, 0);
});

// Восстанавливаем загрузчик после прогона.
test.after(() => {
  (Module as any)._load = originalLoad;
  (Module as any)._resolveFilename = originalResolve;
});
