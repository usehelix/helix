/**
 * vialos-mock-seller — Cloudflare Worker for Exp D (10-hop agent commerce).
 *
 * Endpoints:
 *   GET  /health            → { ok: true, fail_rate }
 *   GET  /item?fail_rate=R  → 503 with prob R, else item + payment quote
 *   POST /item?fail_rate=R  → 503 with prob R, else delivery confirmation
 *
 * fail_rate is a per-request probability (default 0.05). Injection uses
 * Math.random() per request — no seeding, no cooldown.
 */
export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const failRate = parseFloat(url.searchParams.get("fail_rate") ?? "0.05");

    const corsHeaders: Record<string, string> = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (url.pathname === "/health") {
      return Response.json(
        { ok: true, fail_rate: failRate },
        { headers: corsHeaders },
      );
    }

    // Failure injection — applied to /item only, not /health
    if (url.pathname === "/item" && Math.random() < failRate) {
      return Response.json(
        { error: "seller_timeout", code: "ETIMEOUT" },
        { status: 503, headers: corsHeaders },
      );
    }

    if (url.pathname === "/item" && request.method === "GET") {
      return Response.json(
        {
          item: { id: `item-${Date.now()}`, price_usdc: "0.001" },
          payment: { amount: "0.001", currency: "USDC" },
        },
        { headers: corsHeaders },
      );
    }

    if (url.pathname === "/item" && request.method === "POST") {
      return Response.json(
        { success: true, item: { content: "DATA_UNIT" } },
        { headers: corsHeaders },
      );
    }

    return Response.json({ error: "not_found" }, { status: 404, headers: corsHeaders });
  },
};
