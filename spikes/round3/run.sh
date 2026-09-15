#!/usr/bin/env bash
# Round 3 mechanism checks (BUILD-PLAN.md R3-0), run 2026-09-15 on Claude Code 2.1.272.
# resume.sh: a resumed headless call takes its own --json-schema and reports its own usage.
# agents.sh: subagent usage in the parent envelope and transcripts; --agents honored on --resume.
# Compaction is not run live: DISABLE_COMPACT in the environment disables it per
# code.claude.com/docs/en/model-config, and the session then errors at the context limit.
# Run from this directory; each script prints one JSON line per call.
set -euo pipefail
D="$(cd "$(dirname "$0")" && pwd)"
cd "$D"
./resume.sh
./agents.sh
