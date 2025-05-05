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

const logInfo = debug('bot:strategy');
const logDebug = debug('bot:strategy-debug');

// --- tweakable strategy parameters ---

/** which historical summary to use for baseline calculations */
const LOOKBACK_SUMMARY_KEY: keyof MarketCurrentSummaries = 'summaryLast1d';
/** minimum number of data points required in the lookback summary to proceed with trading */
const MIN_DATA_POINTS_FOR_LOOKBACK = 12; // e.g., 12 * 10 minutes = 2 hours of data for 1d summary
/** standard deviation multiplier for setting buy/sell thresholds (lower = more sensitive) */
const K_FACTOR = 1.0;
/** minimum number of beans to always keep in the wallet */
const MINIMUM_BEAN_RESERVE: Integer = 300;
/** minimum number of shares to always keep */
const MINIMUM_SHARE_RESERVE: Integer = 10;
/** fraction of affordable beans or sellable shares to trade in one cycle (0.0 to 1.0) */
const TRADE_FRACTION = 0.15; // e.g., 15%
/** if standard deviation is zero, use this fixed bean amount difference for thresholds */
const MIN_STD_DEV_THRESHOLD_DIFF: Integer = 5;
/** initial backoff delay in milliseconds when hitting a rate limit */
const INITIAL_BACKOFF_MS: Integer = 30 * 1000; // 30 seconds
/** maximum backoff delay in milliseconds */
const MAX_BACKOFF_MS: Integer = 5 * 60 * 1000; // 5 minutes
/** proactive delay in ms before sending request if near rate limit */
const PROACTIVE_RATE_LIMIT_DELAY_MS: Integer = 1000;
/** number of requests below the limit to trigger proactive delay */
const PROACTIVE_RATE_LIMIT_THRESHOLD = 10;

// --- utility Functions ---

/** clamps a number between a minimum and maximum value */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

/** pauses execution for a specified duration */
async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** represents the calculated thresholds for trading */
interface TradeThresholds {
  buyThreshold: Integer;
  sellThreshold: Integer;

  /** indicates if thresholds could be calculated and are usable */
  isValid: boolean;
}

/**
 * calculates the buy and sell thresholds based on a market summary
 * @param summary the market summary to use
 */
function calculateThresholds(summary: MarketSummary): TradeThresholds {
  const baselineAvg = summary.avgSharePriceBeans;
  const baselineStdDev = summary.stdDevSharePriceBeans;

  let buyThreshold: Integer;
  let sellThreshold: Integer;

  if (baselineStdDev < 1) { // check if effectively zero or very small
    logInfo('standard deviation is near zero, using fixed threshold difference');
    buyThreshold = Math.floor(baselineAvg - MIN_STD_DEV_THRESHOLD_DIFF);
    sellThreshold = Math.floor(baselineAvg + MIN_STD_DEV_THRESHOLD_DIFF);
  } else {
    buyThreshold = Math.floor(baselineAvg - K_FACTOR * baselineStdDev);
    sellThreshold = Math.floor(baselineAvg + K_FACTOR * baselineStdDev);
  }

  // ensure buyThreshold is at least 1 bean
  buyThreshold = Math.max(1, buyThreshold);

  // ensure thresholds haven't crossed or are too close
  if (buyThreshold >= sellThreshold) {
    logInfo(`thresholds invalid or crossed: buy=${buyThreshold}, sell=${sellThreshold} - holding`);
    return { buyThreshold, sellThreshold, isValid: false };
  } else {
    return { buyThreshold, sellThreshold, isValid: true };
  }
}

/**
 * executes a buy or sell trade, handling chunking for large orders and rate limits
 * @param actionType 'buy' or 'sell'
 * @param totalShares total number of shares to trade
 * @param initialPrice share price at the time the decision to trade was made
 * @returns true if the entire trade completed successfully, false otherwise
 */
async function executeTrade(
  actionType: 'buy' | 'sell',
  totalShares: Integer,
  initialPrice: Integer
): Promise<boolean> {
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
      currentBackoff = INITIAL_BACKOFF_MS; // Reset backoff on success

      logDebug(`successfully ${actionType === 'buy' ? 'bought' : 'sold'} chunk of ${chunkSize} shares`);

      // Small delay between chunks to be nice to the server/rate limiter
      if (remainingShares > 0) {
        await sleep(300); // 0.3 second delay
      }
    } catch (cause) {
      if (cause instanceof RateLimitError) {
        logInfo(`rate limit hit during ${actionType} chunk, backing off for ${currentBackoff / 1000}s`);

        await sleep(currentBackoff);

        currentBackoff = Math.min(currentBackoff * 2, MAX_BACKOFF_MS); // exponential backoff

        logInfo('re-synchronizing state after rate limit backoff...');

        let newState: HistoryRow;
        try {
          // we only *really* need the price to check if we should continue the trade
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

  return tradeCompleted;
}

// --- main trading cycle logic ---

export async function performTradeCycle(): Promise<void> {
  logInfo('--- new trade cycle - %s ---', new Date().toISOString());

  let currentState: HistoryRow;
  let currentSummaries: MarketCurrentSummaries;

  try {
    // 1. synchronize and get data
    // this potentially uses 3 requests if cache is empty
    currentState = await synchronizeStateAndUpdateHistory();
    currentSummaries = compileMarketCurrentSummaries();
  } catch (cause) {
    if (cause instanceof RateLimitError) {
      logInfo('rate limit hit during synchronization, skipping cycle :<');
      // no need to backoff here, the main loop sleep will handle delay
      return;
    } else if (cause instanceof RequestError) {
      logInfo('request error during synchronization: %s', cause);
      throw cause;
    } else {
      logInfo('fatal error during synchronization: %s', cause);
      throw cause;
    }
  }

  const currentPrice = currentState.sharePriceBeans;
  const ownedShares = currentState.shareOwnedCount;
  const walletBeans = currentState.walletBeans;

  logInfo(`current state: price=${currentPrice}, owned=${ownedShares}, wallet=${walletBeans}`);

  // 2. select lookback summary and check if enough data
  const lookbackSummary = currentSummaries[LOOKBACK_SUMMARY_KEY];
  logInfo(`using lookback: ${LOOKBACK_SUMMARY_KEY} (${lookbackSummary.entryCount} entries)`);

  if (lookbackSummary.entryCount < MIN_DATA_POINTS_FOR_LOOKBACK) {
    logInfo(`insufficient data points (${lookbackSummary.entryCount} < ${MIN_DATA_POINTS_FOR_LOOKBACK}) in lookback period - holding`);
    return;
  }

  // 3. calculate thresholds
  const { buyThreshold, sellThreshold, isValid: thresholdsValid } = calculateThresholds(lookbackSummary);

  if (!thresholdsValid) {
    // log message handled within calculateThresholds
    return;
  }

  logInfo(`calculated thresholds: buy=${buyThreshold}, sell=${sellThreshold}`);

  // 4. decision making
  let actionType: 'buy' | 'sell' | 'hold' = 'hold';
  let totalSharesToTrade: Integer = 0;

  // check buy condition
  if (currentPrice < buyThreshold) {
    const maxAffordableBasedOnBeans = Math.floor((walletBeans - MINIMUM_BEAN_RESERVE) / currentPrice);

    if (maxAffordableBasedOnBeans <= 0) {
      logInfo(`price (${currentPrice}) is below buy threshold (${buyThreshold}), but cannot afford shares or below bean reserve`);
    } else {
      const desiredBuyAmount = Math.floor(maxAffordableBasedOnBeans * TRADE_FRACTION);

      // clamp between 1 and max affordable (don't need MAXIMUM_SHARES_PER_ACTION here, executeTrade handles that)
      totalSharesToTrade = clamp(desiredBuyAmount, 1, maxAffordableBasedOnBeans);

      if (totalSharesToTrade > 0) {
        actionType = 'buy';
        logInfo(`price (${currentPrice}) is below buy threshold (${buyThreshold}), planning to buy ${totalSharesToTrade} shares`);
      } else {
        logInfo(`price (${currentPrice}) is below buy threshold (${buyThreshold}), but calculated buy amount is zero`);
      }
    }
  }
  // check sell condition (only if not buying)
  else if (currentPrice > sellThreshold) {
    const maxSellableBasedOnReserve = ownedShares - MINIMUM_SHARE_RESERVE;

    if (maxSellableBasedOnReserve <= 0) {
      logInfo(`price (${currentPrice}) is above sell threshold (${sellThreshold}), but not enough shares to sell or below share reserve`);
    } else {
      const desiredSellAmount = Math.floor(maxSellableBasedOnReserve * TRADE_FRACTION);

       // clamp between 1 and max sellable (don't need MAXIMUM_SHARES_PER_ACTION here, executeTrade handles that)
      totalSharesToTrade = clamp(desiredSellAmount, 1, maxSellableBasedOnReserve);

      if (totalSharesToTrade > 0) {
        actionType = 'sell';
        logInfo(`price (${currentPrice}) is above sell threshold (${sellThreshold}), planning to sell ${totalSharesToTrade} shares`);
      } else {
        logInfo(`price (${currentPrice}) is above sell threshold (${sellThreshold}), but calculated sell amount is zero`);
      }
    }
  }
  // hold condition
  else {
    logInfo(`price (${currentPrice}) is within thresholds buy=${buyThreshold}, sell=${sellThreshold} - holding`);
    actionType = 'hold';
  }

  // 5. execute trade (if decided)
  if ((actionType === 'buy' || actionType === 'sell') && totalSharesToTrade > 0) {
    const success = await executeTrade(actionType, totalSharesToTrade, currentPrice);
    if (success) {
      logInfo(`trade successful for ${actionType} ${totalSharesToTrade} shares`);
    } else {
      logInfo(`trade failed or was aborted for ${actionType} ${totalSharesToTrade} shares`);
    }
  }
}
