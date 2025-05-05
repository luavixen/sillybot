import { Database, Statement } from 'bun:sqlite';
import { sendRequest } from './request.ts';

// maximum number of shares that can be bought or sold in a single action
export const MAXIMUM_SHARES_PER_ACTION = 200;
// maximum number of requests per minute
export const MAXIMUM_REQUESTS_PER_MINUTE = 550;

/** represents a 53-bit JavaScript integer */
export type Integer = number;

/** checks if a value is a valid Integer */
export function isInteger(value: unknown): value is Integer {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

/** converts a value into an Integer, rounding if needed, throwing an error if invalid */
export function toInteger(value: unknown): Integer {
  if (typeof value === 'number') {
    if (Number.isSafeInteger(value)) {
      return value;
    }
    if (Number.isFinite(value)) {
      const parsed = Math.floor(value);
      if (Number.isSafeInteger(parsed)) {
        return parsed;
      }
    }
    throw new TypeError(`toInteger number value is not a valid integer: ${value}`);
  }
  if (typeof value === 'string') {
    const parsed = parseFloat(value);
    if (Number.isFinite(parsed)) {
      return toInteger(parsed);
    } else {
      throw new TypeError(`toInteger string value is not a valid integer: ${value}`);
    }
  }
  throw new TypeError(`toInteger value is not a number or string, instead ${typeof value}`);
}

function inspectInvalidResponse(value: unknown): string {
  return Bun.inspect(value, { depth: 5, compact: true, colors: false });
}

/** fetches the current price of a silly share, uses one request */
async function fetchCurrentSharePrice(): Promise<Integer> {
  const result = await sendRequest('POST', '/games/sillyexchange', {});
  if ('price' in result && isInteger(result.price)) {
    return result.price;
  } else {
    throw new Error('fetchCurrentSharePrice invalid response: ' + inspectInvalidResponse(result));
  }
}

/** fetches the current number of silly shares that the bot owns, uses one request */
async function fetchCurrentShareOwnedCount(): Promise<Integer> {
  const result = await sendRequest('POST', '/games/sillyexchange/owned', {});
  if (isInteger(result)) {
    return result;
  } else {
    throw new Error('fetchCurrentShareOwnedCount invalid response: ' + inspectInvalidResponse(result));
  }
}

/** fetches the current number of beans in the bot's wallet, uses one request */
async function fetchCurrentWalletBeans(): Promise<Integer> {
  const result = await sendRequest('GET', 'https://sillypost.net/beans', {});
  if (isInteger(result)) {
    return result;
  } else {
    throw new Error('fetchCurrentWalletBeans invalid response: ' + inspectInvalidResponse(result));
  }
}

/** returns the current timestamp, the number of milliseconds since 1970 as an integer */
export function now(): Integer {
  return Math.floor(Date.now());
}

/** represents a locally-cached copy of the state of the market, to save on requests */
interface MarketCache {
  sharePriceBeans: Integer | null;
  shareOwnedCount: Integer | null;
  walletBeans: Integer | null;

  /** the timestamp of the last sync with the server, or null if never synced */
  lastSyncTimestamp: Integer | null;
}

/** current locally-cached state in memory */
const cachedState: MarketCache = {
  sharePriceBeans: null,
  shareOwnedCount: null,
  walletBeans: null,
  lastSyncTimestamp: null,
};

/** creates a cached getter for a specific key in the local cache */
function createCachedGetterFunction(key: keyof MarketCache, fetchValue: () => Promise<Integer>): () => Promise<Integer> {
  return async function () {
    let value = cachedState[key];
    if (value == null) {
      value = await fetchValue();
      cachedState[key] = value;
    }
    return value;
  };
}

/** gets the current price of a silly share */
export const getCurrentSharePrice = createCachedGetterFunction('sharePriceBeans', fetchCurrentSharePrice);

/** gets the current number of silly shares that the bot owns */
export const getCurrentShareOwnedCount = createCachedGetterFunction('shareOwnedCount', fetchCurrentShareOwnedCount);

/** gets the current number of beans in the bot's wallet */
export const getCurrentWalletBeans = createCachedGetterFunction('walletBeans', fetchCurrentWalletBeans);

/** local SQLite database for keeping track of the market */
export const db = new Database('./market.sqlite');

db.exec(`
PRAGMA foreign_keys = on;
PRAGMA busy_timeout = 5000;

-- market history entries
-- a new entry is created every time the share price changes
CREATE TABLE IF NOT EXISTS history (
  timestamp INTEGER NOT NULL,
  sharePriceBeans INTEGER NOT NULL,
  shareOwnedCount INTEGER NOT NULL,
  walletBeans INTEGER NOT NULL,
  PRIMARY KEY (timestamp)
) STRICT;

-- trade history entries
-- a new entry is created every time the bot buys or sells shares
CREATE TABLE IF NOT EXISTS trade (
  timestamp INTEGER NOT NULL,
  sharePriceBeans INTEGER NOT NULL,
  shareOwnedCount INTEGER NOT NULL,
  shareBoughtCount INTEGER NOT NULL,
  shareSoldCount INTEGER NOT NULL,
  walletOldBeans INTEGER NOT NULL,
  walletNewBeans INTEGER NOT NULL,
  PRIMARY KEY (timestamp)
) STRICT;
`);

/**
 * a row in the history table
 * represents the state of the market at a given time
 */
export interface HistoryRow {
  timestamp: Integer;
  sharePriceBeans: Integer;
  shareOwnedCount: Integer;
  walletBeans: Integer;
}

/**
 * a row in the trade table
 * represents a trade made by the bot
 */
export interface TradeRow {
  timestamp: Integer;

  /** the price of a share in beans at the time of the trade */
  sharePriceBeans: Integer;
  /** the number of shares owned by the bot right before the trade */
  shareOwnedCount: Integer;

  /** the number of shares bought in the trade, 0 if any were sold */
  shareBoughtCount: Integer;
  /** the number of shares sold in the trade, 0 if any were bought */
  shareSoldCount: Integer;

  /** the number of beans in the wallet before the trade */
  walletOldBeans: Integer;
  /** the number of beans in the wallet after the trade */
  walletNewBeans: Integer;
}

const queryInsertHistory = db.query(`
  INSERT INTO history (
    timestamp,
    sharePriceBeans,
    shareOwnedCount,
    walletBeans
  ) VALUES (?, ?, ?, ?)
`);

/** inserts a new history row */
export function insertHistory(row: HistoryRow): void {
  queryInsertHistory.run(
    row.timestamp,
    row.sharePriceBeans,
    row.shareOwnedCount,
    row.walletBeans,
  );
}

const queryInsertTrade = db.query(`
  INSERT INTO trade (
    timestamp,
    sharePriceBeans,
    shareOwnedCount,
    shareBoughtCount,
    shareSoldCount,
    walletOldBeans,
    walletNewBeans
  ) VALUES (?, ?, ?, ?, ?, ?, ?)
`);

/** inserts a new trade row */
export function insertTrade(row: TradeRow): void {
  queryInsertTrade.run(
    row.timestamp,
    row.sharePriceBeans,
    row.shareOwnedCount,
    row.shareBoughtCount,
    row.shareSoldCount,
    row.walletOldBeans,
    row.walletNewBeans,
  );
}

/** buys the given number of shares at the current market price, maximum 200 shares at once */
export async function buyShares(shareCount: Integer): Promise<TradeRow> {
  if (!isInteger(shareCount) || shareCount < 0 || shareCount > MAXIMUM_SHARES_PER_ACTION) {
    throw new Error(`invalid share count: ${shareCount}`);
  }

  const walletOldBeans = await getCurrentWalletBeans();
  const sharePriceBeans = await getCurrentSharePrice();

  if (shareCount * sharePriceBeans > walletOldBeans) {
    throw new Error(`not enough beans in wallet to buy ${shareCount} shares`);
  }

  const shareOwnedCount = await getCurrentShareOwnedCount();

  await sendRequest('POST', `/games/sillyexchange/buy/${shareCount}`, {});

  // update the cached state
  cachedState.shareOwnedCount! += shareCount;
  cachedState.walletBeans! -= shareCount * sharePriceBeans;

  const walletNewBeans = await getCurrentWalletBeans();

  const row: TradeRow = {
    timestamp: now(),
    sharePriceBeans,
    shareOwnedCount,
    shareBoughtCount: shareCount,
    shareSoldCount: 0,
    walletOldBeans,
    walletNewBeans,
  };

  insertTrade(row);

  return row;
}

/** sells the given number of shares at the current market price, maximum 200 shares at once */
export async function sellShares(shareCount: Integer): Promise<TradeRow> {
  if (!isInteger(shareCount) || shareCount < 0 || shareCount > MAXIMUM_SHARES_PER_ACTION) {
    throw new Error(`invalid share count: ${shareCount}`);
  }

  const walletOldBeans = await getCurrentWalletBeans();

  const shareOwnedCount = await getCurrentShareOwnedCount();
  const sharePriceBeans = await getCurrentSharePrice();

  await sendRequest('POST', `/games/sillyexchange/sell/${shareCount}`, {});

  // update the cached state
  cachedState.shareOwnedCount! -= shareCount;
  cachedState.walletBeans! += shareCount * sharePriceBeans;

  const walletNewBeans = await getCurrentWalletBeans();

  const row: TradeRow = {
    timestamp: now(),
    sharePriceBeans,
    shareOwnedCount,
    shareBoughtCount: 0,
    shareSoldCount: shareCount,
    walletOldBeans,
    walletNewBeans,
  };

  insertTrade(row);

  return row;
}

const querySelectLatestHistory = db.query(`
  SELECT * FROM history ORDER BY timestamp DESC LIMIT 1
`);

/** returns the latest history row, or null if the table is empty */
export function getLatestHistory(): HistoryRow | null {
  const row = querySelectLatestHistory.get();
  if (row != null) {
    return row as HistoryRow;
  } else {
    return null;
  }
}

/**
 * fetches the current state of the market from the server and updates the local cache
 * if the price has changed, a new history row is created
 * @returns the latest history row
 */
export async function synchronizeStateAndUpdateHistory(): Promise<HistoryRow> {
  const sharePriceBeans = await fetchCurrentSharePrice();
  const shareOwnedCount = await fetchCurrentShareOwnedCount();
  const walletBeans = await fetchCurrentWalletBeans();

  // update the cached state
  cachedState.sharePriceBeans = sharePriceBeans;
  cachedState.shareOwnedCount = shareOwnedCount;
  cachedState.walletBeans = walletBeans;
  cachedState.lastSyncTimestamp = now();

  const rowPrevious = getLatestHistory();

  if (rowPrevious != null && rowPrevious.sharePriceBeans === sharePriceBeans) {
    return rowPrevious;
  }

  const rowCurrent: HistoryRow = {
    timestamp: now(),
    sharePriceBeans,
    shareOwnedCount,
    walletBeans,
  };

  insertHistory(rowCurrent);

  return rowCurrent;
}

/** represents the state of the market over a defined period of time */
export interface MarketSummary {
  periodStart: Integer;
  periodEnd: Integer;

  /** the number of entries used to prepare this summary */
  entryCount: number;

  /** the minimum price of a share during this period */
  minSharePriceBeans: Integer;
  /** the maximum price of a share during this period */
  maxSharePriceBeans: Integer;
  /** the average price of a share during this period */
  avgSharePriceBeans: number;
  /** the standard deviation of the share price during this period */
  stdDevSharePriceBeans: number;
}

/** calculates the standard deviation of a set of numbers */
function calculateStdDev(numbers: number[], avg: number): number {
  const count = numbers.length;
  if (count < 2) {
    // standard deviation requires at least 2 data points
    return 0;
  }
  const variance = numbers.reduce((sum, value) => sum + Math.pow(value - avg, 2), 0) / (count - 1); // sample variance
  return Math.sqrt(variance);
}

const querySelectPricesInPeriod: Statement<{ sharePriceBeans: Integer }, [{ $start: Integer, $end: Integer }]> = db.query(`
  SELECT sharePriceBeans
  FROM history
  WHERE timestamp >= $start AND timestamp <= $end
  ORDER BY timestamp ASC -- order doesn't strictly matter but can be useful
`);

/** compiles a market summary for the given period */
export function compileMarketSummary(periodStart: Integer, periodEnd: Integer): MarketSummary {
  const priceRows = querySelectPricesInPeriod.all({
    $start: periodStart,
    $end: periodEnd,
  });

  const entryCount = priceRows.length;

  let minSharePriceBeans: Integer = 0;
  let maxSharePriceBeans: Integer = 0;
  let avgSharePriceBeans: number = 0;
  let stdDevSharePriceBeans: number = 0;

  if (entryCount > 0) {
    const prices = priceRows.map(row => row.sharePriceBeans);

    minSharePriceBeans = Math.min(...prices);
    maxSharePriceBeans = Math.max(...prices);

    const sum = prices.reduce((acc, price) => acc + price, 0);

    avgSharePriceBeans = sum / entryCount;

    stdDevSharePriceBeans = calculateStdDev(prices, avgSharePriceBeans);
  }

  const summary: MarketSummary = {
    periodStart,
    periodEnd,
    entryCount,
    minSharePriceBeans,
    maxSharePriceBeans,
    avgSharePriceBeans,
    stdDevSharePriceBeans,
  };

  return summary;
}

/** contains summaries of the state of the market over different lengths of time relative to now */
export interface MarketCurrentSummaries {
  summaryLast1h: MarketSummary;
  summaryLast12h: MarketSummary;
  summaryLast1d: MarketSummary;
  summaryLast1w: MarketSummary;
}

/** compiles a list of market summaries over different lengths of time relative to now */
export function compileMarketCurrentSummaries(): MarketCurrentSummaries {
  const nowTime = now();

  const duration1h = 60 * 60 * 1000;
  const duration12h = 12 * duration1h;
  const duration1d = 24 * duration1h;
  const duration1w = 7 * duration1d;

  const summaries: MarketCurrentSummaries = {
    summaryLast1h: compileMarketSummary(nowTime - duration1h, nowTime),
    summaryLast12h: compileMarketSummary(nowTime - duration12h, nowTime),
    summaryLast1d: compileMarketSummary(nowTime - duration1d, nowTime),
    summaryLast1w: compileMarketSummary(nowTime - duration1w, nowTime),
  };

  return summaries;
}
