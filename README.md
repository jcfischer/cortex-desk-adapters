# cortex-desk-adapters

Source adapters for the [Cortex](https://github.com/the-metafactory/cortex) Desk, Mission Control's landing page. Each adapter is a command that prints one JSON object; Cortex runs it from the stack config and shows what it prints.

| Command | Reads | Prints |
|---|---|---|
| `desk-calendar --exchange` | an Exchange calendar through the `ical` CLI | `events` |
| `desk-calendar --mac [--exclude <calendar>]` | macOS Calendar through the `ical` CLI (legacy: returns nothing under a daemon) | `events` |
| `dist/desk-calendar-mac [--exclude <calendar>] [--include <calendar>] [--days 5]` | macOS Calendar through EventKit (a compiled Swift binary) | `events` |
| `desk-mail --account <name>` | an IMAP mailbox through the `email` CLI | `items` (mail) |

Both wrap CLIs from a personal toolkit. They are examples of the contract as much as tools: copy one and point it at your own calendar or mail tool.

## The contract

A source prints `{ "events"?: [...], "items"?: [...] }` on stdout and exits 0. The types are in [`src/contract.ts`](src/contract.ts).

- An **event** has an `id`, an ISO 8601 `start`, a `title`, and optionally `end`, `allDay`, `location`, `online` and `url`.
- A **mail item** has `kind: "mail"`, the Message-ID as `id`, `from`, `subject`, `receivedAt`, `unread`, and optionally `firstParagraph`, `url` and `account`.
- Links must be `http:`, `https:` or `message:` (Apple Mail). Cortex drops entries that do not match and reports how many it dropped.

`desk-mail` reads message bodies without marking them read, and only for the newest unread messages (`--bodies`, default 15).

## macOS calendars under a daemon

Use `desk-calendar-mac` for macOS calendars. `desk-calendar --mac` is kept only for running by hand from a terminal that already has calendar access; it will not get the per-day splitting or new flags.

macOS grants calendar access per program. A Cortex daemon started by launchd has no grant, so `desk-calendar --mac` (which goes through icalBuddy) returns an empty calendar there. `desk-calendar-mac` reads EventKit itself and re-launches itself as its own responsible process, so the grant belongs to it whoever starts it.

```sh
./mac/build.sh                 # needs the Xcode command line tools
./dist/desk-calendar-mac --days 1   # first run: macOS asks for calendar access; allow it
```

A rebuild changes the binary's signature, so macOS asks again. Without access it exits 3 with a message, and the Desk shows the source as failing. Multi-day all-day events come as one entry per day.

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
