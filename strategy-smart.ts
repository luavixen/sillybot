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

import {
  type TradeResult,
  executeTrade,
} from './trade.ts';

const log = debug('bot:strategy-smart');

/** which historical summary to use for baseline calculations */
const LOOKBACK_SUMMARY_KEY: keyof MarketCurrentSummaries = 'summaryLast1d';
/** minimum number of data points required in the lookback summary to proceed with trading */
const MIN_DATA_POINTS_FOR_LOOKBACK = 12; // e.g., 12 * 10 minutes = 2 hours of data for 1d summary
/** standard deviation multiplier for setting buy/sell thresholds (lower = more sensitive) */
const K_FACTOR = 1.0;
/** minimum number of beans to always keep in the wallet */
const MINIMUM_BEAN_RESERVE: Integer = 180;
/** minimum number of shares to always keep */
const MINIMUM_SHARE_RESERVE: Integer = 3;
/** fraction of affordable beans or sellable shares to trade in one cycle (0.0 to 1.0) */
const TRADE_FRACTION = 0.75; // e.g., 15%
/** if standard deviation is zero, use this fixed bean amount difference for thresholds */
const MIN_STD_DEV_THRESHOLD_DIFF: Integer = 5;

/** clamps a number between a minimum and maximum value */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
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
    log('standard deviation is near zero, using fixed threshold difference');
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
    log(`thresholds invalid or crossed: buy=${buyThreshold}, sell=${sellThreshold} - holding`);
    return { buyThreshold, sellThreshold, isValid: false };
  } else {
    return { buyThreshold, sellThreshold, isValid: true };
  }
}

// --- main trading cycle logic ---

export async function performTradeCycleSmart(): Promise<void> {
  log('--- new trade cycle - %s ---', new Date().toISOString());

  let currentState: HistoryRow;
  let currentSummaries: MarketCurrentSummaries;

  try {
    // 1. synchronize and get data
    // this potentially uses 3 requests if cache is empty
    currentState = await synchronizeStateAndUpdateHistory();
    currentSummaries = compileMarketCurrentSummaries();
  } catch (cause) {
    if (cause instanceof RateLimitError) {
      log('rate limit hit during synchronization, skipping cycle :<');
      // no need to backoff here, the main loop sleep will handle delay
      return;
    } else if (cause instanceof RequestError) {
      log('request error during synchronization: %s', cause);
      throw cause;
    } else {
      log('fatal error during synchronization: %s', cause);
      throw cause;
    }
  }

  const currentPrice = currentState.sharePriceBeans;
  const ownedShares = currentState.shareOwnedCount;
  const walletBeans = currentState.walletBeans;

  log(`current state: price=${currentPrice}, owned=${ownedShares}, wallet=${walletBeans}`);

  // 2. select lookback summary and check if enough data
  const lookbackSummary = currentSummaries[LOOKBACK_SUMMARY_KEY];
  log(`using lookback: ${LOOKBACK_SUMMARY_KEY} (${lookbackSummary.entryCount} entries)`);

  if (lookbackSummary.entryCount < MIN_DATA_POINTS_FOR_LOOKBACK) {
    log(`insufficient data points (${lookbackSummary.entryCount} < ${MIN_DATA_POINTS_FOR_LOOKBACK}) in lookback period - holding`);
    return;
  }

  // 3. calculate thresholds
  const { buyThreshold, sellThreshold, isValid: thresholdsValid } = calculateThresholds(lookbackSummary);

  if (!thresholdsValid) {
    // log message handled within calculateThresholds
    return;
  }

  log(`calculated thresholds: buy=${buyThreshold}, sell=${sellThreshold}`);

  // 4. decision making
  let actionType: 'buy' | 'sell' | 'hold' = 'hold';
  let totalSharesToTrade: Integer = 0;

  // check buy condition
  if (currentPrice < buyThreshold) {
    const maxAffordableBasedOnBeans = Math.floor((walletBeans - MINIMUM_BEAN_RESERVE) / currentPrice);

    if (maxAffordableBasedOnBeans <= 0) {
      log(`price (${currentPrice}) is below buy threshold (${buyThreshold}), but cannot afford shares or below bean reserve`);
    } else {
      const desiredBuyAmount = Math.floor(maxAffordableBasedOnBeans * TRADE_FRACTION);

      // clamp between 1 and max affordable (don't need MAXIMUM_SHARES_PER_ACTION here, executeTrade handles that)
      totalSharesToTrade = clamp(desiredBuyAmount, 1, maxAffordableBasedOnBeans);

      if (totalSharesToTrade > 0) {
        actionType = 'buy';
        log(`price (${currentPrice}) is below buy threshold (${buyThreshold}), planning to buy ${totalSharesToTrade} shares`);
      } else {
        log(`price (${currentPrice}) is below buy threshold (${buyThreshold}), but calculated buy amount is zero`);
      }
    }
  }
  // check sell condition (only if not buying)
  else if (currentPrice > sellThreshold) {
    const maxSellableBasedOnReserve = ownedShares - MINIMUM_SHARE_RESERVE;

    if (maxSellableBasedOnReserve <= 0) {
      log(`price (${currentPrice}) is above sell threshold (${sellThreshold}), but not enough shares to sell or below share reserve`);
    } else {
      const desiredSellAmount = Math.floor(maxSellableBasedOnReserve * TRADE_FRACTION);

       // clamp between 1 and max sellable (don't need MAXIMUM_SHARES_PER_ACTION here, executeTrade handles that)
      totalSharesToTrade = clamp(desiredSellAmount, 1, maxSellableBasedOnReserve);

      if (totalSharesToTrade > 0) {
        actionType = 'sell';
        log(`price (${currentPrice}) is above sell threshold (${sellThreshold}), planning to sell ${totalSharesToTrade} shares`);
      } else {
        log(`price (${currentPrice}) is above sell threshold (${sellThreshold}), but calculated sell amount is zero`);
      }
    }
  }
  // hold condition
  else {
    log(`price (${currentPrice}) is within thresholds buy=${buyThreshold}, sell=${sellThreshold} - holding`);
    actionType = 'hold';
  }

  // 5. execute trade (if decided)
  if ((actionType === 'buy' || actionType === 'sell') && totalSharesToTrade > 0) {
    const success = await executeTrade(actionType, totalSharesToTrade, currentPrice);
    if (success) {
      log(`trade successful for ${actionType} ${totalSharesToTrade} shares`);
    } else {
      log(`trade failed or was aborted for ${actionType} ${totalSharesToTrade} shares`);
    }
  }
}
