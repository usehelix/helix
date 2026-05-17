#!/usr/bin/env bash
# transfer-queue.sh — chain: wait for shared N=50 → isolated N=50 →
#                            analyze-transfer → classify-transferability → final summary
# Continues past individual step failures; produces output/overnight-transfer-summary.txt.
set +e
cd "$(dirname "$0")"

LOG="output/transfer-queue.log"
mkdir -p output
: > "$LOG"

ts() { date '+%Y-%m-%d %H:%M:%S'; }
log() { echo "[$(ts)] $*" >> "$LOG"; }

wait_for_log_done() {
  local logfile=$1
  local label=$2
  local marker=${3:-"=== Transfer Summary ==="}
  local max_wait=${4:-10800}  # 3 hours
  local elapsed=0
  while [[ $elapsed -lt $max_wait ]]; do
    if [[ -f "$logfile" ]] && grep -qE "$marker" "$logfile" 2>/dev/null; then
      log "$label completed (marker '$marker' detected)"
      return 0
    fi
    sleep 30
    elapsed=$((elapsed + 30))
  done
  log "$label TIMED OUT after ${max_wait}s — proceeding anyway"
  return 2
}

log "transfer queue started, pid=$$"

# ── Step 1: wait for shared N=50 (already running in background) ──
log "step 1: waiting for shared N=50 (output/transfer-shared-N50.log)"
wait_for_log_done "output/transfer-shared-N50.log" "shared N=50"

# ── Step 2: run isolated N=50 (synchronous) ──
log "step 2: starting isolated N=50 → output/transfer-isolated-N50.log"
npm run bench -- --experiment=transfer --transfer-mode=isolated \
  --n-agents=50 --n-hops=10 --ttl-ms=5000 \
  --think-delay-range=3000,9000 --fail-rate=0 \
  > output/transfer-isolated-N50.log 2>&1
log "step 2: isolated N=50 npm exit=$?"

# ── Step 3: analyze-transfer ──
log "step 3: running analyze-transfer → output/transfer-summary.txt"
npx tsx --env-file=.env src/analyze-transfer.ts > /dev/null 2>>"$LOG"
log "step 3: analyze-transfer exit=$?"

# ── Step 4: classify-transferability ──
log "step 4: running classify-transferability → output/transferability-classification.txt"
npx tsx --env-file=.env src/classify-transferability.ts > /dev/null 2>>"$LOG"
log "step 4: classify-transferability exit=$?"

# ── Step 5: aggregate overnight-transfer-summary.txt ──
log "step 5: writing output/overnight-transfer-summary.txt"
{
  echo "Overnight Transfer Experiment Summary — $(ts)"
  echo "======================================================================"
  echo
  echo "## Part B — Transfer analysis (analyze-transfer)"
  echo
  if [[ -f output/transfer-summary.txt ]]; then
    cat output/transfer-summary.txt
  else
    echo "  STATUS: INCOMPLETE — analyze step did not produce output/transfer-summary.txt"
  fi
  echo
  echo
  echo "======================================================================"
  echo "## Part C — Failure transferability classification (classify-transferability)"
  echo
  if [[ -f output/transferability-classification.txt ]]; then
    cat output/transferability-classification.txt
  else
    echo "  STATUS: INCOMPLETE — classify step did not produce output/transferability-classification.txt"
  fi
} > output/overnight-transfer-summary.txt
log "step 5: summary aggregation done"

log "ALL DONE"
