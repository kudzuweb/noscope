#!/usr/bin/env bash
# Round 3 mechanism checks (BUILD-PLAN.md R3-0), run 2026-09-15 on Claude Code 2.1.272.
# resume.sh: a resumed headless call takes its own --json-schema and reports its own usage.
# agents.sh: subagent usage in the parent envelope and transcripts; --agents honored on --resume.
# Compaction is not run live: DISABLE_COMPACT=1 disables all compaction per the env-vars
# docs page, and model-config says a session with auto-compaction off stops with the
# context-limit error. Run from this directory; resume.sh prints one JSON line per call,
# agents.sh adds the subagent transcript sums and each subagent's .meta.json.
set -euo pipefail
D="$(cd "$(dirname "$0")" && pwd)"
cd "$D"
./resume.sh
./agents.sh
