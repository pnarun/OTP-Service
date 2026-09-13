/**
 * Playground request builder — credential bar fields are the source of truth
 * for appId, apiKey, and brandId on OTP and notify requests.
 */

export interface PlaygroundCredentials {
  appId: string;
  apiKey: string;
  brandId: string;
}

/**
 * Merge credential-bar values into a request JSON body.
 * Always overwrites appId / apiKey / brandId from the form when present.
 * EMAIL /notify includes brandId (backend requires it for Mongo-backed apps).
 */
export function mergePlaygroundCredentials(
  body: string,
  credentials: PlaygroundCredentials,
  path: string,
): string {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const appId = credentials.appId.trim();
    const apiKey = credentials.apiKey.trim();
    const brandId = credentials.brandId.trim();

    if (appId) parsed.appId = appId;
    if (apiKey) parsed.apiKey = apiKey;

    if (brandId && (path.startsWith('/otp') || path.startsWith('/notify'))) {
      parsed.brandId = brandId;
    }

    return JSON.stringify(parsed, null, 2);
  } catch {
    return body;
  }
}

/**
 * Build the outbound request body used by Copy JSON / Copy cURL / Send request.
 */
export function buildPlaygroundRequestBody(
  body: string,
  credentials: PlaygroundCredentials,
  path: string,
): string {
  return mergePlaygroundCredentials(body, credentials, path);
}
