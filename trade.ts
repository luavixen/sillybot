import { debug } from 'debug';

import {
  MAXIMUM_REQUESTS_PER_MINUTE,
  getRequestsInLastMinute,
  RequestError, RateLimitError,
} from './request.ts';

import {
  MAXIMUM_SHARES_PER_ACTION,
  type Integer, isInteger, toInteger,
  now,
  fetchCurrentSharePrice,
  getCurrentSharePrice,
  getCurrentShareOwnedCount,
  getCurrentWalletBeans,
  type HistoryRow,
  type TradeRow,
  buyShares,
  sellShares,
  getLatestHistory,
  synchronizeStateAndUpdateHistory,
  type MarketSummary,
  compileMarketSummary,
  type MarketCurrentSummaries,
  compileMarketCurrentSummaries,
} from './market.ts';

const logInfo = debug('bot:trade');
const logDebug = debug('bot:trade:debug');

/** initial backoff delay in milliseconds when hitting a rate limit */
const INITIAL_BACKOFF_MS: Integer = 30 * 1000; // 30 seconds
/** maximum backoff delay in milliseconds */
const MAX_BACKOFF_MS: Integer = 5 * 60 * 1000; // 5 minutes
/** proactive delay in ms before sending request if near rate limit */
const PROACTIVE_RATE_LIMIT_DELAY_MS: Integer = 1000;
/** number of requests below the limit to trigger proactive delay */
const PROACTIVE_RATE_LIMIT_THRESHOLD = 5;

/** pauses execution for a specified duration */
async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** represents the result of executeTrade */
export interface TradeResult {
  /** the action taken, either 'buy' or 'sell' */
  actionType: 'buy' | 'sell';

  /** the number of shares to trade */
  totalShares: Integer;
  /** the number of shares that failed to be traded */
  remainingShares: Integer;

  /** the price at which the trade was executed */
  initialPrice: Integer;
  /** the price at the end of the trade */
  finalPrice: Integer;

  /** did the trade complete successfully? will still be false for partial trades */
  tradeCompleted: boolean;
}

/**
 * executes a buy or sell trade, handling chunking for large orders and rate limits
 * @param actionType 'buy' or 'sell'
 * @param totalShares total number of shares to trade
 * @param initialPrice share price at the time the decision to trade was made
 */
export async function executeTrade(
  actionType: 'buy' | 'sell',
  totalShares: Integer,
  initialPrice: Integer,
): Promise<TradeResult> {
  logInfo(`executing ${actionType} order for ${totalShares} shares (price ${initialPrice})`);

  let remainingShares = totalShares;
  let currentBackoff = INITIAL_BACKOFF_MS;
  let tradeCompleted = false;

  while (remainingShares > 0) {
    // proactive rate limit check
    const requestsLastMinute = getRequestsInLastMinute();
    if (requestsLastMinute >= MAXIMUM_REQUESTS_PER_MINUTE - PROACTIVE_RATE_LIMIT_THRESHOLD) {
      logInfo(`nearing rate limit (${requestsLastMinute} requests), pausing proactively for ${PROACTIVE_RATE_LIMIT_DELAY_MS}ms`);
      await sleep(PROACTIVE_RATE_LIMIT_DELAY_MS);
    }

    const chunkSize = Math.min(remainingShares, MAXIMUM_SHARES_PER_ACTION);

    try {
      logDebug(`attempting to ${actionType} chunk of ${chunkSize} shares (remaining: ${remainingShares - chunkSize})`);

      if (actionType === 'buy') {
        await buyShares(chunkSize);
      } else {
        await sellShares(chunkSize);
      }

      remainingShares -= chunkSize;
      currentBackoff = INITIAL_BACKOFF_MS; // reset backoff on success

      logDebug(`successfully ${actionType === 'buy' ? 'bought' : 'sold'} chunk of ${chunkSize} shares`);

      // small delay between chunks to be nice to the server/rate limiter
      if (remainingShares > 0) {
        await sleep(50); // 0.05 second delay
      }
    } catch (cause) {
      if (cause instanceof RateLimitError) {
        logInfo(`rate limit hit during ${actionType} chunk, backing off for ${currentBackoff / 1000}s`);

        await sleep(currentBackoff);

        currentBackoff = Math.min(currentBackoff * 2, MAX_BACKOFF_MS); // exponential backoff

        logInfo('re-synchronizing state after rate limit backoff...');

        let newState: HistoryRow;
        try {
          // we only really need the price to check if we should continue the trade
          // no need to call full synchronizeStateAndUpdateHistory which uses 3 requests
          const newPrice = await fetchCurrentSharePrice();
          if (newPrice !== initialPrice) {
            logInfo(`price changed to ${newPrice} (was ${initialPrice}) after rate limit, aborting trade`);
            tradeCompleted = false;
            break;
          } else {
            logInfo('price remains stable, retrying chunk');
            // loop continues, will retry the same chunk
          }
        } catch (syncCause) {
          logInfo(`error during post-rate-limit synchronization, aborting trade: %s`, syncCause);
          if (syncCause instanceof RequestError) {
            // handle nested request errors? maybe?
          }
          tradeCompleted = false;
          break; // exit the loop
        }
      } else if (cause instanceof RequestError) {
        logInfo(`request error during trade execution: %s`, cause);
        tradeCompleted = false;
        break; // exit the loop
      } else {
        logInfo('fatal error during trade execution: %s', cause);
        throw cause;
      }
    }
  }

  if (remainingShares === 0) {
    tradeCompleted = true;
    logInfo(`completed ${actionType} order for ${totalShares} shares`);
  } else {
    logInfo(`trade incomplete, ${remainingShares} shares remaining`);
  }

  const result: TradeResult = {
    actionType,
    totalShares,
    remainingShares,
    initialPrice,
    finalPrice: await getCurrentSharePrice(),
    tradeCompleted,
  };

  return result;
}
