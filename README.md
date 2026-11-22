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

## Background memory review

To enable background review, set `RESPIRE_CODEX_PATH` to the absolute path of a compatible Codex executable and restart Antigravity. Use a Codex installation that can run `app-server` with your existing account and configuration. When enabled, the completed turn's user text and available response evidence are sent to the provider configured in Codex for review. Leave the variable unset to keep background review off.

The Antigravity Stop hook hands off eligible turns to a separate process and returns before review. Codex opens an ephemeral thread with a restricted memory tool. The tool uses the local Respire Runtime RPC and checks matching records, the selected parent and the written entry. Normal chat stays in Antigravity. Background review will leave a fact pending if the existing entry needs an update or a suitable parent cannot be established.

Local outcomes and verified memory IDs are recorded under `~/.gemini/config/respire-antigravity/archive`. The archive status files contain no conversation text.
