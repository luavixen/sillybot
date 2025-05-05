import { debug } from 'debug';
import {
  MAXIMUM_SHARES_PER_ACTION,
  MAXIMUM_REQUESTS_PER_MINUTE,
  type Integer, isInteger, toInteger,
  now,
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

const log = debug('bot');


async function trade() {

  const state = await synchronizeStateAndUpdateHistory();

  log('%O', state);

  const summaries = compileMarketCurrentSummaries();

  log('%O', summaries);

  // let's Buy a Share
  log('%O', await buyShares(1));

  log('%o', { walletBeans: await getCurrentWalletBeans() });

  // let's Sell a Share

  log('%O', await sellShares(1));

  log('%o', { walletBeans: await getCurrentWalletBeans() });

  // TODO: actual trade logic

}

trade();
