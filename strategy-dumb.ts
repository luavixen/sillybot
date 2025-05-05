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

const log = debug('bot:strategy-dumb');

interface TradeDecision {
  actionType: 'buy' | 'sell' | 'hold';
  shareCount: Integer;
}

function createTradeDecision(
  actionType: 'buy' | 'sell' | 'hold',
  shareCountFractional: number,
): TradeDecision {
  const shareCount = toInteger(shareCountFractional);
  if (shareCount <= 0) {
    return { actionType: 'hold', shareCount: 0 };
  } else {
    return { actionType, shareCount };
  }
}

function decideNextTrade(
  priceBeans: Integer,
  ownedCount: Integer,
  walletBeans: Integer,
): TradeDecision {
  const maximumShareBuyCount = Math.floor(walletBeans / priceBeans);

  if (maximumShareBuyCount > 0) {

    if (priceBeans <= 40) {
      return createTradeDecision('buy', maximumShareBuyCount * 0.95);
    }

    if (priceBeans <= 65) {
      return createTradeDecision('buy', maximumShareBuyCount * 0.8);
    }

    if (priceBeans <= 80) {
      return createTradeDecision('buy', maximumShareBuyCount * 0.5);
    }

    if (priceBeans <= 95) {
      return createTradeDecision('buy', maximumShareBuyCount * 0.25);
    }

    if (priceBeans <= 100) {
      return createTradeDecision('buy', maximumShareBuyCount * 0.05);
    }

  }

  if (ownedCount > 0) {

    if (priceBeans >= 150) {
      return createTradeDecision('sell', ownedCount * 0.99);
    }

    if (priceBeans >= 140) {
      return createTradeDecision('sell', ownedCount * 0.95);
    }

    if (priceBeans >= 130) {
      return createTradeDecision('sell', ownedCount * 0.80);
    }

    if (priceBeans >= 120) {
      return createTradeDecision('sell', ownedCount * 0.70);
    }

    if (priceBeans >= 110) {
      return createTradeDecision('sell', ownedCount * 0.25);
    }

    if (priceBeans >= 100) {
      return createTradeDecision('sell', ownedCount * 0.1);
    }

  }

  return createTradeDecision('hold', 0);
}

export async function performTradeCycle(): Promise<void> {

  log('--- new trade cycle - %s ---', new Date().toISOString());

  let currentState: HistoryRow | null = null;

  for (let i = 0; i < 3; i++) {
    try {
      currentState = await synchronizeStateAndUpdateHistory();
      break;
    } catch (cause) {
      if (cause instanceof RateLimitError) {
        log('rate limit hit during sync, retrying...');
        await new Promise((resolve) => setTimeout(resolve, 60 * 1000));
        return;
      } else if (cause instanceof RequestError) {
        log('request error during sync: %s', cause);
        throw cause;
      } else {
        log('fatal error during sync: %s', cause);
        throw cause;
      }
    }
  }
  if (currentState == null) {
    log('failed to sync after 3 attempts, aborting cycle');
    return;
  }

  const sharePriceBeans = currentState.sharePriceBeans;
  const shareOwnedCount = currentState.shareOwnedCount;
  const walletBeans = currentState.walletBeans;

  log(`current state: price=${sharePriceBeans}, owned=${shareOwnedCount}, wallet=${walletBeans}`);

  const decision = decideNextTrade(
    sharePriceBeans,
    shareOwnedCount,
    walletBeans,
  );

  if (decision.actionType === 'hold') {
    log('holding, no action taken');
    return;
  }

  log('decided to %s %d shares', decision.actionType, decision.shareCount);

  const result = await executeTrade(
    decision.actionType,
    decision.shareCount,
    currentState.sharePriceBeans,
  );

  if (result.tradeCompleted) {
    log('trade completed successfully!');
  } else {
    log('trade incomplete, %d shares remaining', result.remainingShares);
  }

}
