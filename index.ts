import { debug } from 'debug';

import { RequestError, RateLimitError } from './request.ts';
import { now } from './market.ts';
import { performTradeCycle } from './strategy-dumb.ts';

/** interval between trade cycles in seconds */
const TRADE_CYCLE_INTERVAL = 10 * 60 * 1000; // 10 minutes

const log = debug('bot');

async function runTradingLoop(): Promise<never> {
  while (true) {
    const startTime = now();

    try {
      await performTradeCycle();
    } catch (cause) {
      if (cause instanceof RateLimitError) {
        log('cycle failed due to rate limit error');
      } else if (cause instanceof RequestError) {
        log('cycle failed due to request error');
      } else {
        throw cause;
      }
    }

    const endTime = now();

    const elapsedSeconds = endTime - startTime;
    const sleepSeconds = Math.max(100, TRADE_CYCLE_INTERVAL - elapsedSeconds);

    log('cycle done in %dms, sleeping for %ds', elapsedSeconds, Math.floor(sleepSeconds / 1000));

    await new Promise((resolve) => setTimeout(resolve, sleepSeconds));
  }
}

runTradingLoop().catch((cause) => {
  log('fatal error: %s', cause);
  console.error(cause);
  process.exit(1);
});
