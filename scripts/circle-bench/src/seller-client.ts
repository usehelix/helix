const SELLER_URL = process.env.SELLER_URL;
if (!SELLER_URL) throw new Error("Missing SELLER_URL in .env");

const TIMEOUT_MS = 30_000;

export interface ServiceQuote {
  service_id: number;
  price_usdc: string;
  quote_id: string;
  deliverable_url: string;
  expires_at: string;
}

export interface VerifyResponse {
  delivered: boolean;
  reason?: string;
  deliverable?: string;
}

export class SellerError extends Error {
  constructor(
    message: string,
    public step: "discover" | "verify",
    public cause?: unknown,
  ) {
    super(message);
    this.name = "SellerError";
  }
}

async function fetchWithTimeout(url: string, init: RequestInit = {}): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

export async function discoverService(
  serviceId: number,
  failRate: number,
  ttlMs?: number,
): Promise<ServiceQuote> {
  const params = new URLSearchParams({
    id: String(serviceId),
    fail_rate: String(failRate),
  });
  if (ttlMs !== undefined) params.set("ttl_ms", String(ttlMs));
  const url = `${SELLER_URL}/service?${params.toString()}`;
  let res: Response;
  try {
    res = await fetchWithTimeout(url);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new SellerError(`discover request failed: ${msg}`, "discover", e);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new SellerError(`discover ${res.status}: ${body.slice(0, 200)}`, "discover");
  }
  return (await res.json()) as ServiceQuote;
}

export async function verifyDelivery(
  txId: string,
  serviceId: number,
  quoteExpiresAt: string,
): Promise<VerifyResponse> {
  const url = `${SELLER_URL}/verify`;
  let res: Response;
  try {
    res = await fetchWithTimeout(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        tx_id: txId,
        service_id: serviceId,
        quote_expires_at: quoteExpiresAt,
      }),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new SellerError(`verify request failed: ${msg}`, "verify", e);
  }
  if (res.status >= 500) {
    const body = await res.text().catch(() => "");
    throw new SellerError(`verify ${res.status}: ${body.slice(0, 200)}`, "verify");
  }
  return (await res.json()) as VerifyResponse;
}
