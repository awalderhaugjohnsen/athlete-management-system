#!/usr/bin/env bash
# Fly.io worker entrypoint. Replaces the three macOS LaunchAgents
# (com.ams.process-queue, com.ams.sync-kpis, com.ams.sync-history — see
# ../process_queue.sh, ../sync_kpis.sh, ../sync_history.sh) with three loops in one
# persistent container, so processing no longer depends on a laptop being awake.
#
# Deliberately no `set -e`: a single failed iteration in one loop must not take
# down the other two, and must not kill the container (Fly would then just restart
# it into the same failure). Each loop swallows its own command's failure and
# retries on the next interval, matching the LaunchAgents' behavior today.

set -uo pipefail

CONFIG="/app/my_training_config.yaml"

log() {
  printf '[%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1"
}

queue_loop() {
  while true; do
    pending='[]'
    if [ -n "${SUPABASE_URL:-}" ] && [ -n "${SUPABASE_SERVICE_ROLE_KEY:-}" ]; then
      pending=$(curl -sf --max-time 10 \
        "$SUPABASE_URL/rest/v1/replan_jobs?status=eq.pending&select=id&limit=1" \
        -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
        -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" 2>/dev/null || echo '[]')
    fi
    if [ "$pending" != "[]" ]; then
      log "queue: pending job found, running --queue"
      pixi run python cli/ams.py --queue "$CONFIG" || log "queue: run failed, will retry next interval"
    fi
    sleep 90
  done
}

kpi_loop() {
  while true; do
    pixi run python cli/ams.py --sync-kpis "$CONFIG" || log "sync-kpis: run failed, will retry next interval"
    sleep 1800
  done
}

history_loop() {
  while true; do
    pixi run python cli/ams.py --sync-history "$CONFIG" || log "sync-history: run failed, will retry next interval"
    sleep 86400
  done
}

log "worker starting: queue poll every 90s, KPI sync every 30m, history sync every 24h"

queue_loop &
kpi_loop &
history_loop &

# If any loop's own `while true` somehow exits (a bash crash, not a command
# failure — those are caught above), fail the container fast so Fly restarts it
# clean, rather than silently limping along with one of the three loops gone.
wait -n
log "a worker loop exited unexpectedly — exiting so Fly restarts the container"
exit 1
