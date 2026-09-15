#!/usr/bin/env bash
# Checks 4 and 5: subagent usage in the parent envelope; --agents honored on --resume.
set -euo pipefail
FLAGS=(--output-format json --model claude-haiku-4-5 --setting-sources "" --disable-slash-commands --exclude-dynamic-system-prompt-sections --tools "Agent" --allowedTools "Agent")
AGENTS='{"pinger":{"description":"Replies PONG","prompt":"Reply with exactly the word PONG and nothing else.","model":"haiku","tools":[]}}'
S='{"type":"object","properties":{"agentReply":{"type":"string"},"usedAgent":{"type":"boolean"}},"required":["agentReply","usedAgent"]}'
P='Use the Agent tool to run the subagent type "pinger" with the prompt "go". Put its reply in agentReply and set usedAgent true. If no such agent type exists, set usedAgent false and say so in agentReply.'
echo "== check 4: fresh call with --agents"
c=$(claude -p "$P" "${FLAGS[@]}" --agents "$AGENTS" --json-schema "$S" < /dev/null)
jq -c '{session_id, structured_output, num_turns, usage:{in:.usage.input_tokens, cw:.usage.cache_creation_input_tokens, cr:.usage.cache_read_input_tokens, out:.usage.output_tokens}, cost:.total_cost_usd, subagent_stats, modelUsage: (.modelUsage | with_entries(.value |= {in:.inputTokens, cw:.cacheCreationInputTokens, cr:.cacheReadInputTokens, out:.outputTokens, cost:.costUSD}))}' <<<"$c"
sid=$(jq -r .session_id <<<"$c")
d=~/.claude/projects/$(pwd | sed 's#/#-#g')/$sid/subagents
echo "subagent transcripts: $(ls "$d" 2>/dev/null | tr '\n' ' ')"
for m in "$d"/*.meta.json; do echo "$m: $(cat "$m")"; done
for f in "$d"/*.jsonl; do python3 - "$f" <<'PY'
import json,sys
tot={"in":0,"cw":0,"cr":0,"out":0}
for line in open(sys.argv[1]):
    o=json.loads(line); u=(o.get("message") or {}).get("usage")
    if u and o.get("type")=="assistant":
        tot["in"]+=u.get("input_tokens",0); tot["cw"]+=u.get("cache_creation_input_tokens",0); tot["cr"]+=u.get("cache_read_input_tokens",0); tot["out"]+=u.get("output_tokens",0)
print("subagent transcript usage summed over assistant messages:",tot)
PY
done
echo "== check 5: fresh call without --agents, then resume with --agents"
c1=$(claude -p 'Reply with the word ready.' "${FLAGS[@]}" --json-schema '{"type":"object","properties":{"ok":{"type":"string"}},"required":["ok"]}' < /dev/null)
sid2=$(jq -r .session_id <<<"$c1")
c2=$(claude -p "$P" "${FLAGS[@]}" --resume "$sid2" --agents "$AGENTS" --json-schema "$S" < /dev/null)
jq -c '{session_id, structured_output, num_turns, subagent_stats}' <<<"$c2"
