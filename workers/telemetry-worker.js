/**
 * Cloudflare Worker: Helix Telemetry + Gene Registry Cloud
 *
 * Telemetry (KV-backed, legacy):
 *   POST /v1/event  — record repair events
 *   GET  /v1/repair — lookup best repair strategy from KV genemap
 *
 * Gene Registry Cloud (D1-backed):
 *   GET  /v1/capsules?code=&category=&platform=  — pull best capsule for an error
 *   POST /v1/capsules                            — push a capsule from local Gene Map
 *   GET  /v1/stats                               — registry health + counters
 */

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
const JSON_HEADERS = { 'Content-Type': 'application/json', ...CORS };

const BASELINE = {
  'auth_401':        { strategy: 'token_refresh',    confidence: 0.75, description: 'Refresh OAuth token via connector login flow' },
  'auth_403':        { strategy: 'scope_missing',    confidence: 0.80, description: 'Inform user to re-grant required permissions' },
  'auth_expired':    { strategy: 'token_refresh',    confidence: 0.90, description: 'Token expired — trigger re-auth immediately' },
  'rate_429':        { strategy: 'retry_after_30s',  confidence: 0.85, description: 'Wait 30s and retry the exact same request' },
  'rate_quota':      { strategy: 'retry_after_60s',  confidence: 0.70, description: 'Quota exceeded — wait 60s before retry' },
  'rate_limit':      { strategy: 'retry_after_30s',  confidence: 0.85, description: 'Rate limited — wait 30s and retry' },
  'loop_detected':   { strategy: 'force_execute',    confidence: 0.95, description: 'Stop text responses — call a tool immediately' },
  'timeout':         { strategy: 'retry_after_5s',   confidence: 0.80, description: 'Wait 5s and retry once silently' },
  'session_error':   { strategy: 'retry_after_5s',   confidence: 0.75, description: 'Session dropped — retry after brief pause' },
  'session_lost':    { strategy: 'retry_after_5s',   confidence: 0.75, description: 'Session dropped — retry after brief pause' },
  'silent_failure':  { strategy: 'verify_and_retry', confidence: 0.85, description: 'Verify outcome then retry if unconfirmed' },
  'task_chain':      { strategy: 'auto_proceed',     confidence: 0.80, description: 'Proceed to next step without confirmation' },
  'task_incomplete': { strategy: 'auto_proceed',     confidence: 0.80, description: 'Proceed to next step without confirmation' },
  'auth_error':      { strategy: 'token_refresh',    confidence: 0.80, description: 'Classify auth error and attempt re-auth' },
  'role_drift':      { strategy: 'delegate_to_specialist', confidence: 0.90, description: 'Orchestrator executing directly — delegate via sessions_spawn' },
  'behavioral_7a':   { strategy: 'execute_immediately',    confidence: 0.85, description: 'Silent abandonment — stop describing, execute now' },
  'behavioral_7b':   { strategy: 'spawn_verification',     confidence: 0.88, description: 'Unverified completion — spawn verification sub-agent' },
};

// ── Genemap schema helpers ──────────────────────────────────────────────
//
// Backward-compatible read of legacy `genemap:*` entries that don't yet
// have a `strategies` field. We attribute the existing aggregate counts
// (total/success) to whichever `best_strategy` was last recorded so no
// signal is lost. New writes start populating per-strategy stats from
// this point forward, and `best_strategy` is recomputed every event.
function upgradeGenemap(gm, fallbackStrategy) {
  if (!gm) {
    return { total: 0, success: 0, strategies: {}, best_strategy: fallbackStrategy || 'none', description: '' };
  }
  if (!gm.strategies) {
    const legacy = (gm.best_strategy && gm.best_strategy !== 'none') ? gm.best_strategy : (fallbackStrategy || 'unknown');
    gm.strategies = { [legacy]: { total: gm.total || 0, success: gm.success || 0 } };
  }
  if (!gm.description) gm.description = '';
  return gm;
}

// Pick best_strategy: highest success_rate among strategies with ≥3 samples.
// Cold-start fallback: highest absolute success count if nothing has 3+ yet.
function recomputeBestStrategy(gm) {
  const entries = Object.entries(gm.strategies || {});
  if (entries.length === 0) return gm.best_strategy || 'none';
  const eligible = entries.filter(([, s]) => (s.total || 0) >= 3);
  if (eligible.length > 0) {
    eligible.sort((a, b) => (b[1].success / b[1].total) - (a[1].success / a[1].total));
    return eligible[0][0];
  }
  entries.sort((a, b) => (b[1].success || 0) - (a[1].success || 0));
  return entries[0][0];
}

// Apply one event (strategy `ra`, success `ok`) to an in-memory genemap.
function applyEvent(gm, ra, ok) {
  gm.total = (gm.total || 0) + 1;
  if (ok) gm.success = (gm.success || 0) + 1;
  if (ra && ra !== 'none') {
    if (!gm.strategies[ra]) gm.strategies[ra] = { total: 0, success: 0 };
    gm.strategies[ra].total += 1;
    if (ok) gm.strategies[ra].success += 1;
  }
  gm.best_strategy = recomputeBestStrategy(gm);
  return gm;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    // ── GET /v1/capsules — pull best capsule for an error ──
    if (url.pathname === '/v1/capsules' && request.method === 'GET') {
      const code = url.searchParams.get('code');
      if (!code) {
        return new Response(JSON.stringify({ error: 'code is required' }), { status: 400, headers: JSON_HEADERS });
      }
      const category = url.searchParams.get('category');
      const platform = url.searchParams.get('platform');
      try {
        let row;
        if (category && platform) {
          row = await env.GENE_REGISTRY.prepare(
            `SELECT failure_code, category, platform, strategy, q_value, success_count, total_count, avg_repair_ms, capsule_schema_version
             FROM capsules WHERE failure_code = ? AND category = ? AND platform = ?
             ORDER BY q_value DESC LIMIT 1`
          ).bind(code, category, platform).first();
        } else if (category) {
          row = await env.GENE_REGISTRY.prepare(
            `SELECT failure_code, category, platform, strategy, q_value, success_count, total_count, avg_repair_ms, capsule_schema_version
             FROM capsules WHERE failure_code = ? AND category = ?
             ORDER BY q_value DESC LIMIT 1`
          ).bind(code, category).first();
        } else if (platform) {
          row = await env.GENE_REGISTRY.prepare(
            `SELECT failure_code, category, platform, strategy, q_value, success_count, total_count, avg_repair_ms, capsule_schema_version
             FROM capsules WHERE failure_code = ? AND platform = ?
             ORDER BY q_value DESC LIMIT 1`
          ).bind(code, platform).first();
        } else {
          row = await env.GENE_REGISTRY.prepare(
            `SELECT failure_code, category, platform, strategy, q_value, success_count, total_count, avg_repair_ms, capsule_schema_version
             FROM capsules WHERE failure_code = ?
             ORDER BY q_value DESC LIMIT 1`
          ).bind(code).first();
        }
        if (!row) {
          // Observability: log every miss so we know which capsules agents
          // are asking for that we don't have yet (= candidates for seeding).
          console.log(JSON.stringify({ event: 'capsule_get_miss', code, category, platform }));
        }
        return new Response(JSON.stringify({ found: !!row, capsule: row ?? null }), { headers: JSON_HEADERS });
      } catch (err) {
        return new Response(JSON.stringify({ error: 'registry_error', message: String(err && err.message || err) }), { status: 500, headers: JSON_HEADERS });
      }
    }

    // ── POST /v1/capsules — push a capsule from local Gene Map ──
    if (url.pathname === '/v1/capsules' && request.method === 'POST') {
      // Fail-closed auth: REGISTRY_WRITE_KEY must be configured in the worker
      // env, and the request must present a matching x-registry-key header.
      // GET /v1/capsules and /v1/stats remain public on purpose.
      if (!env.REGISTRY_WRITE_KEY) {
        console.log(JSON.stringify({ event: 'capsule_post_misconfigured' }));
        return new Response(JSON.stringify({ error: 'registry_misconfigured' }), { status: 503, headers: JSON_HEADERS });
      }
      const provided = request.headers.get('x-registry-key');
      if (provided !== env.REGISTRY_WRITE_KEY) {
        console.log(JSON.stringify({ event: 'capsule_post_unauthorized' }));
        return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: JSON_HEADERS });
      }

      try {
        const body = await request.json();
        const { failure_code, strategy } = body;
        if (!failure_code || !strategy) {
          return new Response(JSON.stringify({ error: 'failure_code and strategy are required' }), { status: 400, headers: JSON_HEADERS });
        }
        const category = body.category ?? 'generic';
        const platform = body.platform ?? 'generic';
        const q_value = typeof body.q_value === 'number' ? body.q_value : 0.5;
        const success_count = body.success_count ?? 0;
        const total_count = body.total_count ?? 0;
        const avg_repair_ms = body.avg_repair_ms ?? null;
        const agent_id = body.agent_id ?? null;
        const sdk_version = body.sdk_version ?? null;
        const chain_id = body.chain_id ?? null;
        const capsule_schema_version = body.capsule_schema_version ?? 1;

        // Upsert: keep highest q_value seen, sum counts, average repair-ms.
        await env.GENE_REGISTRY.prepare(
          `INSERT INTO capsules
             (failure_code, category, platform, strategy, q_value,
              success_count, total_count, avg_repair_ms, capsule_schema_version,
              agent_id, sdk_version, chain_id, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
           ON CONFLICT(failure_code, category, platform, strategy) DO UPDATE SET
             q_value = CASE WHEN excluded.q_value > q_value THEN excluded.q_value ELSE q_value END,
             success_count = success_count + excluded.success_count,
             total_count = total_count + excluded.total_count,
             avg_repair_ms = CASE
               WHEN avg_repair_ms IS NULL THEN excluded.avg_repair_ms
               WHEN excluded.avg_repair_ms IS NULL THEN avg_repair_ms
               ELSE (avg_repair_ms + excluded.avg_repair_ms) / 2
             END,
             capsule_schema_version = MAX(capsule_schema_version, excluded.capsule_schema_version),
             agent_id = COALESCE(excluded.agent_id, agent_id),
             sdk_version = COALESCE(excluded.sdk_version, sdk_version),
             chain_id = COALESCE(excluded.chain_id, chain_id),
             updated_at = datetime('now')`
        ).bind(failure_code, category, platform, strategy, q_value,
               success_count, total_count, avg_repair_ms, capsule_schema_version,
               agent_id, sdk_version, chain_id).run();

        // Increment cumulative repairs counter. Capsule/agent counts are
        // computed live in GET /v1/stats — see comment on registry_stats.
        await env.GENE_REGISTRY.prepare(
          `UPDATE registry_stats SET
             total_repairs = total_repairs + ?,
             last_updated = datetime('now')
           WHERE id = 1`
        ).bind(success_count).run();

        // Observability: log every accepted POST. agent_id may be null —
        // log explicit "anonymous" so it's filterable.
        console.log(JSON.stringify({
          event: 'capsule_post_ok',
          failure_code, category, platform, strategy,
          agent_id: agent_id ?? 'anonymous',
          q_value, success_count, total_count,
          sdk_version, chain_id,
        }));

        return new Response(JSON.stringify({ ok: true }), { headers: JSON_HEADERS });
      } catch (err) {
        console.log(JSON.stringify({ event: 'capsule_post_error', message: String(err && err.message || err) }));
        return new Response(JSON.stringify({ error: 'registry_error', message: String(err && err.message || err) }), { status: 500, headers: JSON_HEADERS });
      }
    }

    // ── GET /v1/stats — registry health counters ──
    // capsules and agents are LIVE counts so they stay correct under
    // deletes/cleanup. repairs is cumulative (incremented on every POST).
    if (url.pathname === '/v1/stats' && request.method === 'GET') {
      try {
        const counts = await env.GENE_REGISTRY.prepare(
          `SELECT
             (SELECT COUNT(*) FROM capsules) AS capsules,
             (SELECT COUNT(DISTINCT agent_id) FROM capsules WHERE agent_id IS NOT NULL) AS agents`
        ).first();
        const stats = await env.GENE_REGISTRY.prepare(
          `SELECT total_repairs, last_updated FROM registry_stats WHERE id = 1`
        ).first();
        const top = await env.GENE_REGISTRY.prepare(
          `SELECT failure_code AS code, SUM(total_count) AS count
             FROM capsules
            GROUP BY failure_code
            ORDER BY count DESC LIMIT 5`
        ).all();
        return new Response(JSON.stringify({
          capsules: counts?.capsules ?? 0,
          agents: counts?.agents ?? 0,
          repairs: stats?.total_repairs ?? 0,
          last_updated: stats?.last_updated ?? null,
          top_errors: top?.results ?? [],
        }), { headers: JSON_HEADERS });
      } catch (err) {
        return new Response(JSON.stringify({ error: 'registry_error', message: String(err && err.message || err) }), { status: 500, headers: JSON_HEADERS });
      }
    }

    // ── GET /v1/repair — Gene Map strategy lookup ──
    if (url.pathname === '/v1/repair' && request.method === 'GET') {
      const ec = url.searchParams.get('ec') || 'unknown';
      const platform = url.searchParams.get('platform') || 'unknown';

      // Try aggregated data from KV
      const kvKey = `genemap:${platform}:${ec}`;
      let geneData = null;
      try {
        const stored = await env.HELIX_TELEMETRY.get(kvKey, 'json');
        if (stored && stored.total > 3) geneData = stored;
      } catch {}

      const baseline = BASELINE[ec] || { strategy: 'log_and_inform', confidence: 0.50, description: 'Log the error and inform user with details' };

      let response;
      if (geneData) {
        // Confidence is the success rate of the *chosen* best_strategy,
        // not the overall genemap aggregate. Falls back to the aggregate
        // for legacy entries that haven't been upgraded yet.
        const best = geneData.best_strategy;
        const stratStats = geneData.strategies && geneData.strategies[best];
        const successRate = (stratStats && stratStats.total > 0)
          ? (stratStats.success / stratStats.total)
          : (geneData.success / geneData.total);
        response = { strategy: best, confidence: parseFloat(successRate.toFixed(2)), based_on: geneData.total, description: geneData.description || baseline.description, source: 'gene_map', platform, ec };
      } else {
        response = { strategy: baseline.strategy, confidence: baseline.confidence, based_on: 0, description: baseline.description, source: 'baseline', platform, ec };
      }

      return new Response(JSON.stringify(response), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache', ...CORS } });
    }

    // ── GET /v1/event?ec=&p=&ok=&src= — simple query param version ──
    if (url.pathname === '/v1/event' && request.method === 'GET') {
      try {
        const ec = url.searchParams.get('ec') || 'unknown';
        const ok = url.searchParams.get('ok') !== 'false';
        const src = url.searchParams.get('src') || 'unknown';
        const p = parseInt(url.searchParams.get('p') || '0');
        const ra = url.searchParams.get('ra') || 'none';
        const date = new Date().toISOString().slice(0, 10);

        const key = `vial_repair:${date}:${ec}:${ra}:${ok}`;
        const existing = await env.HELIX_TELEMETRY.get(key);
        await env.HELIX_TELEMETRY.put(key, String((parseInt(existing || '0')) + 1), { expirationTtl: 86400 * 90 });

        const platform = src.includes('clawdi') ? 'clawdi' : src;
        const gmKey = `genemap:${platform}:${ec}`;
        const stored = await env.HELIX_TELEMETRY.get(gmKey, 'json');
        const gm = upgradeGenemap(stored, ra);
        applyEvent(gm, ra, ok);
        await env.HELIX_TELEMETRY.put(gmKey, JSON.stringify(gm));

        return new Response('ok', { status: 200, headers: CORS });
      } catch { return new Response('error', { status: 500, headers: CORS }); }
    }

    // ── POST /v1/event — record repair event ──
    if (url.pathname === '/v1/event' && request.method === 'POST') {
      try {
        const body = await request.json();
        if (!body.e || !body.ec) return new Response('Invalid payload: e and ec required', { status: 400 });

        const date = new Date().toISOString().slice(0, 10);
        const ra = body.ra ?? 'none';
        const ok = body.ok !== undefined ? body.ok : 'unknown';

        // Store daily counter
        const key = `${body.e}:${date}:${body.ec}:${ra}:${ok}`;
        const existing = await env.HELIX_TELEMETRY.get(key);
        await env.HELIX_TELEMETRY.put(key, String((parseInt(existing || '0')) + 1), { expirationTtl: 60 * 60 * 24 * 90 });

        // Store session activity
        if (body.s) {
          await env.HELIX_TELEMETRY.put(`session:${date}:${body.s}`, '1', { expirationTtl: 60 * 60 * 24 * 2 });
        }

        // Aggregate into Gene Map (for /v1/repair lookups)
        if (body.e === 'vial_repair' || body.e === 'repair') {
          const platform = body.src || body.pl || 'unknown';
          const gmKey = `genemap:${platform}:${body.ec}`;
          try {
            const stored = await env.HELIX_TELEMETRY.get(gmKey, 'json');
            const gm = upgradeGenemap(stored, ra);
            const eventOk = body.ok === true || body.ok === 1;
            applyEvent(gm, ra, eventOk);
            await env.HELIX_TELEMETRY.put(gmKey, JSON.stringify(gm));
          } catch {}
        }

        return new Response('ok', { status: 200, headers: CORS });
      } catch { return new Response('Error', { status: 500 }); }
    }

    return new Response('Not found', { status: 404, headers: CORS });
  },
};
