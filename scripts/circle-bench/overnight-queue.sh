#!/usr/bin/env bash
# overnight-queue.sh — chain helix-run-005 (already running) → bare-run-006 → helix-run-007 → summary
# Continues past individual run failures; produces output/overnight-summary.txt at the end.
set +e
cd "$(dirname "$0")"

LOG="output/overnight-queue.log"
mkdir -p output
: > "$LOG"

ts() { date '+%Y-%m-%d %H:%M:%S'; }
log() { echo "[$(ts)] $*" >> "$LOG"; }

# Wait until a run's tee log shows the "Manifest : ..." line that marks success.
# 2-hour timeout per run — well above the ~70-min worst case.
wait_for_log_done() {
  local logfile=$1
  local label=$2
  local max_wait=${3:-7200}
  local elapsed=0
  while [[ $elapsed -lt $max_wait ]]; do
    if [[ -f "$logfile" ]] && grep -qE "^Manifest" "$logfile" 2>/dev/null; then
      log "$label completed (Manifest line detected)"
      return 0
    fi
    sleep 30
    elapsed=$((elapsed + 30))
  done
  log "$label TIMED OUT after ${max_wait}s — proceeding anyway"
  return 2
}

log "overnight queue started, pid=$$"

# ── Wait for #2 (helix fail=0.05) which is already running in background ──
log "waiting for #2 helix-run-005.log"
wait_for_log_done "output/helix-run-005.log" "#2"

# ── #3: bare fail-rate=0 ──
log "starting #3 bare fail-rate=0 → bare-run-006.log"
npm run bench:bare -- \
  --n-workflows=50 --n-hops=10 --fail-rate=0 \
  --ttl-ms=5000 --think-delay-range=3000,9000 \
  > output/bare-run-006.log 2>&1
log "#3 npm exit=$?"

# ── #4: helix fail-rate=0, cold-start Gene Map ──
log "removing output/helix-genes.db for #4 cold start"
rm -f output/helix-genes.db
log "starting #4 helix fail-rate=0 → helix-run-007.log"
npm run bench:helix -- \
  --n-workflows=50 --n-hops=10 --fail-rate=0 \
  --ttl-ms=5000 --think-delay-range=3000,9000 \
  > output/helix-run-007.log 2>&1
log "#4 npm exit=$?"

# ── Summary ──
log "generating output/overnight-summary.txt"
node summary.cjs > output/overnight-summary.txt 2>&1
log "summary exit=$?"

log "ALL DONE"
