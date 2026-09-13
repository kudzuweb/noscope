#!/usr/bin/env bash
# Verifies that Claude Code's --tools filter leaves MCP tools alone in headless mode.
# Run from this directory. Each line should end in ECHO:ping.
set -euo pipefail
D="$(cd "$(dirname "$0")" && pwd)"
printf '{"mcpServers":{"noscope":{"command":"node","args":["%s/server.mjs"]}}}\n' "$D" > "$D/mcp.json"
P='Call the echo tool with text "ping" and reply with exactly what it returned. If no echo tool is available to you, reply with exactly NO ECHO TOOL.'
run(){ label="$1"; shift; claude -p "$P" --output-format json --no-session-persistence --model claude-haiku-4-5 \
  --system-prompt "Do exactly what the instruction says." --setting-sources "" --disable-slash-commands \
  --exclude-dynamic-system-prompt-sections --mcp-config "$D/mcp.json" --strict-mcp-config \
  --allowedTools "mcp__noscope__echo" "$@" | jq -c --arg l "$label" '{test:$l, result:.result, turns:.num_turns, ctx:(.usage.input_tokens+.usage.cache_creation_input_tokens+.usage.cache_read_input_tokens)}'; }
run "no --tools flag"
run "--tools empty" --tools ""
run "--tools Read" --tools "Read"
run "--tools mcp__noscope__echo" --tools "mcp__noscope__echo"
