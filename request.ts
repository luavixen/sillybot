
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

/** sends a request to sillypost.net */
export async function sendRequest(method: string, path: string, init: BunFetchRequestInit): Promise<any> {
  const url = new URL(path, 'https://sillypost.net');

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
    throw new RequestError(`request failed to ${method} ${url}`, { cause });
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
    throw new RequestError(`response invalid for ${method} ${url}`, { cause });
  }

  // handle errors
  if (!response.ok) {
    const message = body?.message || body?.error || Bun.inspect(body, { depth: 3, compact: true, colors: false });
    if (response.status === 429) {
      throw new RateLimitError(`rate limit exceeded for ${method} ${url} error: ${message}`);
    } else {
      throw new RequestError(`response ${response.status} for ${method} ${url} error: ${message}`);
    }
  }

  return body;
}
