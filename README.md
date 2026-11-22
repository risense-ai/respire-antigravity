# Respire for Antigravity

An Antigravity plugin that recalls memory before the first model invocation and handles explicit save requests in a JavaScript hook. It calls the local Respire Runtime directly over scoped HTTP RPC.

## Install

Requires Antigravity with native command hooks, Node.js 22 or newer on the Antigravity process PATH, and a running, unlocked Respire Runtime supporting RPC v1. The default address is `127.0.0.1:15169`. Set `RSRS_RPC_PORT` before starting Antigravity if your Runtime uses a different port.

Install from the GitHub source with Antigravity's plugin manager:

```sh
agy plugin install https://github.com/risense-ai/respire-antigravity
```

For a workspace-only install, put the plugin directory in `.agents/plugins/respire-antigravity`. Start a new conversation after installation. The `agy` command above is an Antigravity installer. Memory operations use the already-running Respire Runtime.

## Use

- Normal messages recall relevant memory bodies before the model runs.
- Use `/nomem your message` or `#nomem your message` to skip recall for that message.
- Use `记：[parent=<ID>] 正文` or `remember: [parent=<ID>] fact` for an explicit save. The hook audits the candidate and parent, checks the written entry, then displays its receipt in the conversation. Expand the **Hook Json PreInvocation** card to read it. If the outcome is unknown, check the library before resubmitting.

The plugin stores operation claims and receipts under `~/.gemini/config/respire-antigravity/operations` to prevent a replay from writing again. The initial release targets Antigravity on Windows. Other host surfaces require separate acceptance.
