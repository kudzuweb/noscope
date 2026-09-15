#!/usr/bin/env bash
# Checks 1 and 2: a resumed headless call takes its own --json-schema and reports its own usage.
set -euo pipefail
FLAGS=(--output-format json --model claude-haiku-4-5 --setting-sources "" --disable-slash-commands --exclude-dynamic-system-prompt-sections --tools "")
S1='{"type":"object","properties":{"word":{"type":"string"}},"required":["word"]}'
S2='{"type":"object","properties":{"remembered":{"type":"string"},"count":{"type":"integer"}},"required":["remembered","count"]}'
S3='{"type":"object","properties":{"all":{"type":"array","items":{"type":"string"}}},"required":["all"]}'
c1=$(claude -p 'Remember the word "pelican". Reply with it as the structured output.' "${FLAGS[@]}" --json-schema "$S1")
sid=$(jq -r .session_id <<<"$c1")
echo "call1: $(jq -c '{session_id, structured_output, num_turns, usage:{in:.usage.input_tokens, cw:.usage.cache_creation_input_tokens, cr:.usage.cache_read_input_tokens, out:.usage.output_tokens}, cost:.total_cost_usd}' <<<"$c1")"
c2=$(claude -p 'Now remember "walrus" too. Reply with the first word you were told as remembered and the number of words you now hold as count.' "${FLAGS[@]}" --resume "$sid" --json-schema "$S2")
echo "call2: $(jq -c '{session_id, structured_output, num_turns, usage:{in:.usage.input_tokens, cw:.usage.cache_creation_input_tokens, cr:.usage.cache_read_input_tokens, out:.usage.output_tokens}, cost:.total_cost_usd}' <<<"$c2")"
c3=$(claude -p 'List every word you were told to remember, in order.' "${FLAGS[@]}" --resume "$sid" --json-schema "$S3")
echo "call3: $(jq -c '{session_id, structured_output, num_turns, usage:{in:.usage.input_tokens, cw:.usage.cache_creation_input_tokens, cr:.usage.cache_read_input_tokens, out:.usage.output_tokens}, cost:.total_cost_usd}' <<<"$c3")"
echo "envelope keys: $(jq -c 'keys' <<<"$c3")"
