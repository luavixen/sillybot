import { debug } from 'debug';

const log = debug('bot:request');

/** maximum number of requests per minute */
export const MAXIMUM_REQUESTS_PER_MINUTE = 570;

/** array of js timestamps, one for each request */
let previousRequestTimestamps: number[] = [];

/** returns the number of requests in the last minute */
export function getRequestsInLastMinute(): number {
  const oneMinuteAgo = Date.now() - 60 * 1000;

  // filter out requests older than one minute
  previousRequestTimestamps = previousRequestTimestamps
    .filter((timestamp) => timestamp < oneMinuteAgo);

  return previousRequestTimestamps.length;
}

const requestToken = process.env.TOKEN;
const requestUserAgent = 'luas-awesome-exchange-bot/1337';

/** represents a failed request */
export class RequestError extends Error {
  constructor(message?: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'RequestError';
  }
}

/** represents a failed request due to a rate limit */
export class RateLimitError extends RequestError {
  constructor(message?: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'RateLimitError';
  }
}

function inspect(value: unknown): string {
  return Bun.inspect(value, { depth: 3, compact: true, colors: false });
}

/** sends a request to sillypost.net */
export async function sendRequest(method: string, path: string, init: BunFetchRequestInit): Promise<any> {
  const url = new URL(path, 'https://sillypost.net');

  log(`send ${method} ${url} ${inspect(init)}`);

  // send request
  let response: Response;
  try {
    response = await fetch(url, {
      method: method,
      headers: {
        'Accept': 'application/json, text/plain, */*',
        'Pragma': 'no-cache',
        'Cache-Control': 'no-cache',
        'User-Agent': requestUserAgent,
        'Cookie': `token=${requestToken}`,
      },
      referrer: 'https://sillypost.net/games/sillyexchange',
      mode: 'cors',
      credentials: 'include',
      redirect: 'follow',
      keepalive: true,
      ...init
    });
  } catch (cause) {
    const error = new RequestError(`request failed to ${method} ${url}`, { cause });
    log('%s', error); throw error;
  } finally {
    // save this request time for rate limiting
    previousRequestTimestamps.push(Date.now());
  }

  // parse body
  let body: any;
  try {
    if (response.headers.get('content-length') === '0') {
      await response.body?.cancel();
      body = null;
    } else {
      body = await response.json();
    }
  } catch (cause) {
    const error = new RequestError(`response invalid for ${method} ${url}`, { cause });
    log('%s', error); throw error;
  }

  // handle errors
  if (!response.ok) {
    const message = body?.message || body?.error || inspect(body);

    let error: Error;
    if (response.status === 429) {
      error = new RateLimitError(`rate limit exceeded for ${method} ${url} error: ${message}`);
    } else {
      error = new RequestError(`response ${response.status} for ${method} ${url} error: ${message}`);
    }

    log('%s', error); throw error;
  }

  log(`response ${response.status} body ${inspect(body)}`);

  return body;
}
