# Parser routing

`desk-parse --routing-config /path/to/routing.json` uses Ranger's public version 1 `select-substrate` CLI. Ranger owns quota readings and selection policy. The parser owns provider invocation and proposal validation. It creates no work item and executes no proposal.

## Configuration

The JSON configuration opts providers into the adapter. Ranger must also enable them in `selection.substrates`.

```json
{
  "version": 1,
  "ranger": { "command": "ranger", "config": "/path/to/ranger.yaml" },
  "timeoutMs": 25000,
  "permitted": ["claude", "codex", "pi"],
  "providers": {
    "claude": { "command": "claude", "model": "haiku" },
    "codex": { "command": "pi", "model": "gpt-6.1-sol" },
    "pi": { "command": "pi", "provider": "local-provider", "model": "local-model" }
  }
}
```

Paths, models, and provider availability belong to the operator's configuration. Omit an adapter to exclude it. `timeoutMs` is a positive integer up to 300000. Cortex's parser-command timeout must allow this deadline plus process startup. Configuration input is limited to 64 KiB and five seconds. The request deadline starts when the parser starts and covers stdin, capability checks, selection, provider execution, and fallback. Stdin is limited to 64 KiB. Each command's combined stdout and stderr is limited to 256 KiB.

The `codex` adapter uses **Pi's `openai-codex` transport** with Codex subscription credentials. Its command must be the Pi CLI, rather than `codex exec`. This provides an enforceable empty tool allowlist. Read-only Codex sandbox permissions alone do not meet that contract. The separate `pi` fallback uses its configured provider and model. `anthropic` and `openai-codex` are reserved for the strong providers and cannot be configured as the Pi fallback.

## Permissions and fallback

The usual stdin request remains `{text, now, timeZone, kinds, maps}`. An optional `routing` field narrows provider permissions:

```json
{"routing":{"permitted":["pi"]}}
```

This field accompanies the usual request fields. An empty list permits no provider. Invalid restrictions fail closed. The parser intersects request restrictions with configured `permitted` providers and reports parser-capable configured adapters to Ranger. Future Cortex area policy can supply this restriction before selection.

Each configured, permitted executable must advertise the required isolation flags in `--help`. Missing executables or flags exclude the adapter with a reason. Claude receives `--tools ""`, an empty strict MCP configuration, no session persistence, no slash commands, and no user or project settings sources. Pi receives `--no-tools`, `--no-extensions`, `--no-mcp`, `--no-skills`, `--no-prompt-templates`, `--no-context-files`, and `--no-session`. Provider, model, and output mode are fixed arguments. Configuration cannot add tool permissions or arbitrary provider arguments.

Every selected provider receives the same prompt. A structured quota error adds that provider to `attempted` and asks Ranger again. Each provider runs at most once. Completed malformed proposals, authentication failures, unexpected tool calls, and timeouts stop the request. Arbitrary error text does not trigger fallback. The adapter checks provider completion envelopes before validating proposal JSON. A deadline or output overflow terminates the command's process group on Unix.

## Output

Successful output retains the existing proposal or `none` shape and adds `routing`:

```json
{
  "kind": "note",
  "fields": { "text": "Example" },
  "routing": {
    "version": 1,
    "kind": "selected",
    "provider": "codex",
    "reason": "most-headroom",
    "candidates": [],
    "attempted": ["claude", "codex"],
    "fallbackReasons": [{ "provider": "claude", "reason": "quota-exhausted" }],
    "capabilityExclusions": []
  }
}
```

`candidates` contains Ranger's actual provider reasons. It has one entry per provider for a selection. The empty list above abbreviates that diagnostic data. The parser preserves these reasons rather than implementing its own quota policy.

Unavailable output exits zero and retains the legacy refusal shape:

```json
{"kind":"none","reason":"Parser unavailable: no-eligible-substrate","routing":{"version":1,"kind":"unavailable","reason":"no-eligible-substrate","attempted":[],"candidates":[],"fallbackReasons":[],"capabilityExclusions":[]}}
```

Unavailable reasons include Ranger's `no-eligible-substrate` and `integration-unavailable`, selector validation failures, missing integration commands, provider failures, deadline expiry, and input or output limits. `capabilityExclusions` explains adapters rejected before selection. Existing Cortex consumers accept the proposal or refusal and ignore the added metadata. Provider visibility and actionable unavailable handling are the separate command-bar integration slice, Cortex issue 2907. Confirmation remains a separate create request.

Without `--routing-config`, the existing `--model` and `--claude` arguments and output contract remain supported.
