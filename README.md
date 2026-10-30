# cortex-desk-adapters

Source adapters for the [Cortex](https://github.com/the-metafactory/cortex) Desk, Mission Control's landing page. Each adapter is a command that prints one JSON object; Cortex runs it from the stack config and shows what it prints.

| Command | Reads | Prints |
|---|---|---|
| `desk-calendar --exchange` | an Exchange calendar through the `ical` CLI | `events` |
| `desk-calendar --mac [--exclude <calendar>]` | macOS Calendar through the `ical` CLI | `events` |
| `desk-mail --account <name>` | an IMAP mailbox through the `email` CLI | `items` (mail) |

Both wrap CLIs from a personal toolkit. They are examples of the contract as much as tools: copy one and point it at your own calendar or mail tool.

## The contract

A source prints `{ "events"?: [...], "items"?: [...] }` on stdout and exits 0. The types are in [`src/contract.ts`](src/contract.ts).

- An **event** has an `id`, an ISO 8601 `start`, a `title`, and optionally `end`, `allDay`, `location`, `online` and `url`.
- A **mail item** has `kind: "mail"`, the Message-ID as `id`, `from`, `subject`, `receivedAt`, `unread`, and optionally `firstParagraph`, `url` and `account`.
- Links must be `http:`, `https:` or `message:` (Apple Mail). Cortex drops entries that do not match and reports how many it dropped.

`desk-mail` reads message bodies without marking them read, and only for the newest unread messages (`--bodies`, default 15).

## Use it in Cortex

Install with `bun install`, then list the commands under `mc.desk.sources` in the stack config:

```yaml
mc:
  desk:
    sources:
      - id: work-calendar
        command: [/path/to/cortex-desk-adapters/bin/desk-calendar.ts, --exchange]
        area: work
      - id: work-mail
        command: [/path/to/cortex-desk-adapters/bin/desk-mail.ts, --account, work]
        area: work
        everySeconds: 300
        timeoutSeconds: 60
```

Cortex runs each command without a shell, at most once per `everySeconds` (default 300), and kills it after `timeoutSeconds` (default 30).

## Develop

```sh
bun install
bun test
bunx tsc --noEmit
```
