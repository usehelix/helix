interface ServiceResponse {
  service_id: number;
  price_usdc: string;
  quote_id: string;
  deliverable_url: string;
  expires_at: string;
}

interface VerifyRequest {
  tx_id?: unknown;
  service_id?: unknown;
  quote_expires_at?: unknown;
  fail_rate?: unknown;
}

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...CORS_HEADERS },
  });
}

function clampRate(input: unknown, dflt: number): number {
  if (input == null) return dflt;
  const v = typeof input === "number" ? input : parseFloat(String(input));
  if (Number.isNaN(v)) return dflt;
  return Math.max(0, Math.min(1, v));
}

const DEFAULT_TTL_MS = 8_000;
const MAX_TTL_MS = 3_600_000;

function parseTtlMs(raw: string | null): number {
  if (!raw) return DEFAULT_TTL_MS;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TTL_MS;
  return Math.min(n, MAX_TTL_MS);
}

function handleService(url: URL): Response {
  const idStr = url.searchParams.get("id");
  if (!idStr) return json({ error: "missing id" }, 400);
  const serviceId = parseInt(idStr, 10);
  if (Number.isNaN(serviceId)) return json({ error: "invalid id" }, 400);

  const failRate = clampRate(url.searchParams.get("fail_rate"), 0.05);
  if (Math.random() < failRate) {
    return json({ error: "service unavailable" }, 503);
  }

  // ttl_ms query param overrides the default 8s. Used for timing measurement
  // and for tuning the experiment's structural failure window.
  const ttlMs = parseTtlMs(url.searchParams.get("ttl_ms"));

  const body: ServiceResponse = {
    service_id: serviceId,
    price_usdc: "0.001",
    quote_id: crypto.randomUUID(),
    deliverable_url: "/deliverable/" + serviceId,
    expires_at: new Date(Date.now() + ttlMs).toISOString(),
  };
  return json(body);
}

async function handleVerify(req: Request): Promise<Response> {
  let body: VerifyRequest;
  try {
    body = (await req.json()) as VerifyRequest;
  } catch {
    return json({ error: "invalid json" }, 400);
  }

  if (typeof body.tx_id !== "string" || body.tx_id.length === 0) {
    return json({ delivered: false, reason: "invalid_tx" });
  }

  if (typeof body.quote_expires_at !== "string" || body.quote_expires_at.length === 0) {
    return json({ delivered: false, reason: "missing_quote_expiry" });
  }

  const expiry = Date.parse(body.quote_expires_at);
  if (Number.isNaN(expiry)) {
    return json({ delivered: false, reason: "missing_quote_expiry" });
  }

  // stale_quote is now deterministic: only fires when the quote actually expired.
  // No random injection here — callers can learn to verify before expires_at.
  if (Date.now() > expiry) {
    return json({ delivered: false, reason: "stale_quote" });
  }

  return json({
    delivered: true,
    deliverable: "content-" + String(body.service_id),
  });
}

export default {
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    let res: Response;
    if (method === "GET" && path === "/health") {
      res = json({ status: "ok", version: "v0.1" });
    } else if (method === "GET" && path === "/service") {
      res = handleService(url);
    } else if (method === "POST" && path === "/verify") {
      res = await handleVerify(req);
    } else {
      res = json({ error: "not_found" }, 404);
    }

    console.log(`${method} ${path} -> ${res.status}`);
    return res;
  },
};
