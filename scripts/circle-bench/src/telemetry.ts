const TELEMETRY_URL = process.env.TELEMETRY_URL?.trim() || undefined;
const EXPERIMENT_ID = process.env.EXPERIMENT_ID ?? "circle-sprint-v0";

const TELEMETRY_TIMEOUT_MS = 5_000;

export interface HopEvent {
  experiment_id: string;
  workflow_id: string;
  hop_index: number;
  mode: "bare" | "helix";
  outcome: "success" | "failure";
  tx_hash?: string;
  failure_reason?: string;
  duration_ms: number;
  timestamp: string;
}

type EmitInput = Omit<HopEvent, "experiment_id" | "timestamp">;

export function emitHopEvent(event: EmitInput): void {
  if (!TELEMETRY_URL) return;
  const payload: HopEvent = {
    experiment_id: EXPERIMENT_ID,
    timestamp: new Date().toISOString(),
    ...event,
  };
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const url = `${TELEMETRY_URL}/?event=${encoded}`;

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TELEMETRY_TIMEOUT_MS);
  t.unref?.();

  fetch(url, { method: "GET", signal: ctrl.signal })
    .catch(() => {})
    .finally(() => clearTimeout(t));
}
