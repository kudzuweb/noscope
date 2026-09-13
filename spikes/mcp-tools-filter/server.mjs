import { createInterface } from "node:readline";
const rl = createInterface({ input: process.stdin });
const send = (o) => process.stdout.write(JSON.stringify(o) + "\n");
rl.on("line", (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  const { id, method, params } = m;
  if (method === "initialize") send({ jsonrpc: "2.0", id, result: { protocolVersion: params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "noscope-test", version: "0.0.1" } } });
  else if (method === "tools/list") send({ jsonrpc: "2.0", id, result: { tools: [{ name: "echo", description: "Echo the text back, prefixed with ECHO:", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }] } });
  else if (method === "tools/call") send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "ECHO:" + (params?.arguments?.text ?? "") }] } });
  else if (method === "ping") send({ jsonrpc: "2.0", id, result: {} });
  else if (id !== undefined) send({ jsonrpc: "2.0", id, error: { code: -32601, message: "no such method " + method } });
});
