# cortex-desk-adapters

Source adapters for the [Cortex](https://github.com/the-metafactory/cortex) Desk, Mission Control's landing page. Each adapter is a command that prints one JSON object; Cortex runs it from the stack config and shows what it prints.

The Desk also runs commands to create things the person confirms in its command bar; see [Writers](#writers).

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
./mac/build.sh                 # needs the Xcode command line tools; ./mac/build.sh <dir> builds elsewhere
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

## Writers

The Desk's command bar turns typed text into a proposal card. When the person confirms it, Cortex runs the **writer** configured for that kind, and an optional **parser** reads the text first. Both are commands, like sources. The types are in [`src/contract.ts`](src/contract.ts).

| Command | Kind | Creates |
|---|---|---|
| `dist/desk-calendar-mac --create [--calendar <name>]` | `calendar` | an event in macOS Calendar, through EventKit |
| `dist/desk-reminders-mac [--list <name>]` | `reminder` | a reminder with an alarm in Apple Reminders, through EventKit |
| `desk-task [--map <ref>]... [--autonomy approve] [--kind research] [--soma soma]` | `task` | a node on a work-graph map, through `soma graph add` |
| `desk-goal [--soma soma]` | `goal` | a draft Soma goal, through `soma goal add` |
| `desk-note-tana [--target <nodeId>]` | `note` | a plain node in Tana, through the Tana Input API |
| `desk-parse [--model haiku] [--claude claude]` | (parser) | nothing; prints a proposal |

### The writer contract

Cortex runs the writer without a shell, writes one JSON object to its stdin, closes stdin and waits up to 30 s.

- Input: `{ "kind": "calendar" | "task" | "goal" | "note" | "reminder", "fields": { ... }, "requestId": "<8–64 of [A-Za-z0-9_-]>" }` (`DeskWriteInput`; `DeskWriteRequest` is the same without the id). The request id is the same for every retry of one confirmed card, so a writer uses it to add nothing on a retry whose first try already wrote. A malformed request id is refused.
  - `calendar`: `title`, ISO 8601 `start`, and optionally `end`, `allDay`, `location`, `notes`.
  - `task`: `title`, `map` (a work-graph root ref such as `the-metafactory/cortex#2770`) and optionally `details`.
  - `goal`: `wording`.
  - `note`: `text`.
  - `reminder`: `text` and ISO 8601 `due`.
- Success: exit 0 and print one object `{ "id": string, "url"?: string, "message"?: string }`. The `message` is one plain sentence for the person; a `url` must be `http:` or `https:`.
- Refusal or failure: exit non-zero. The last line of stderr is shown to the person, so it is one plain sentence.

A writer refuses a request of a kind it does not handle, or whose fields fail its checks, and then creates nothing.

Notes and reminders need no writer: without one, Cortex keeps them on the Desk (Keep in mind, and the timeline for a reminder). With `writers.note` or `writers.reminder` set, Cortex sends them to that command and keeps nothing itself, so the Desk neither shows nor pushes them; the person's own tool does.

### The parser contract

Cortex may run a parser before it builds the card. Its stdin gets `{ "text", "now" (ISO 8601), "timeZone" (IANA), "kinds", "maps": [{ "ref", "label" }] }`; `kinds` is a subset of `reminder`, `note`, `task`, `goal` and `calendar`. It prints one object: `{ "kind", "fields" }` with the fields above, or `{ "kind": "none", "reason" }`. Cortex validates the answer and falls back to its own rules parser on any failure, so a parser may fail loudly.

### The commands

- **`desk-calendar-mac --create`** reads the request after its relaunch, so a refused request never touches the calendar. It refuses a request without a request id. It saves to the default calendar for new events, or to `--calendar <name>` (an unknown or read-only calendar is refused), with span `.thisEvent`, and puts `desk:request <requestId>` as the last line of the event's notes. Before saving, it looks in the target calendar from the day before the start to a day after the end for an event whose notes hold that line; if it finds one, it saves nothing and reports that event as already there. The `id` is the event's `eventIdentifier`. An event without `end` lasts an hour; an all-day event without `end` lasts one day. It uses the same calendar grant as reading (full access).
- **`desk-reminders-mac`** is a separate binary with its own signature, so its Reminders grant and the calendar grant of `desk-calendar-mac` never disturb each other. Build it with `./mac/build-reminders.sh`, which builds nothing else. Like `desk-calendar-mac`, it re-launches itself with responsibility disclaimed and reads the request only after that, and it checks the whole request before any Reminders access. It refuses a request without a request id, without `text`, or whose `due` is not an ISO 8601 date and time. It saves to the default Reminders list, or to `--list <name>` (an unknown or read-only list is refused with exit 4). The reminder gets the text as its title, a due date, an alarm at the due time, and `desk:request <requestId>` as the last line of its notes. Before saving, it looks through the target list (open reminders, and those completed in the last seven days) for a reminder whose notes end with that line; if it finds one, it saves nothing and reports that reminder as already there. The `id` is the reminder's `calendarItemIdentifier`. Without full Reminders access it exits 3. The first run asks for access, so run it once by hand and allow it before Cortex uses it:

  ```sh
  ./mac/build-reminders.sh
  echo '{"kind":"reminder","fields":{"text":"Try the Desk reminder writer","due":"2026-11-02T09:00:00+01:00"},"requestId":"desk-setup-0001"}' | ./dist/desk-reminders-mac
  ```
- **`desk-task`** files the task under its map with `--label desk:principal-intake` and `--once "<!-- desk:request <requestId> -->"`, so a retry of one card finds the node it already filed instead of filing a second (it refuses a request without a request id). It uses a checkpoint `desk-<kebab title>` of at most 48 characters, and a body holding the details (or the title) under `## Question` plus a line saying it came from the Desk. With one or more `--map`, any other map is refused. An `owner/name#N` map is filed on github.com with an explicit `--repo`, so it does not depend on the directory Cortex runs the writer from; a qualified ref (`github:host/owner/name#N`) is passed as it is. The `id` is `owner/name#N` and the `url` the issue.
- **`desk-goal`** first runs `soma goal list --wording`; if an open goal (draft, active or paused) already has exactly this wording (trimmed), it prints that goal's id and adds nothing; a dropped or achieved goal does not count. Otherwise it runs `soma goal add --wording <wording>` and prints the new goal's id (`G<n>`). The wording is the dedupe key, because `soma goal add` takes none, so the request id is accepted but not required. The goal starts as a draft; activate it with `soma goal activate`.
- **`desk-note-tana`** posts the note text as one plain node (no supertag, no fields) to Tana's Input API, under `--target <nodeId>` or, by default, the Inbox. It reads the API token from `TANA_API_TOKEN`, or else from the `apiToken` in [supertag](https://github.com/jcfischer/supertag-cli)'s config (`$XDG_CONFIG_HOME/supertag/config.json`, which `supertag config --token` writes); it never takes the token in argv. `TANA_API_ENDPOINT` or the config's `apiEndpoint` override the endpoint. The Input API cannot search, so the writer keeps a ledger of request ids at `$XDG_STATE_HOME/cortex-desk-adapters/tana-notes.json` (default `~/.local/state/...`), written only after Tana answers success; a retry within 30 days whose request id is in the ledger adds nothing and reports the node it already made. It refuses a request without a request id or without `text`, and a text over 1000 characters; line breaks become spaces. Without a token, on an HTTP error or a refused payload it exits 1 with one sentence and records nothing; after a 5xx answer or no answer it says the note may have been created. The `id` is the Tana node id and the `url` opens it in Tana.
- **`desk-parse`** asks a model once (`claude -p --model haiku --output-format text`) to read the text against `now` and `timeZone`, choosing a map only from `maps`. It prints the first JSON object of the answer after a shape check, and exits non-zero on anything else. A call takes about ten seconds.

Configure them under `mc.desk.ask`:

```yaml
mc:
  desk:
    ask:
      parser: [/path/to/cortex-desk-adapters/bin/desk-parse.ts]
      writers:
        calendar: [/path/to/cortex-desk-adapters/dist/desk-calendar-mac, --create]
        task: [/path/to/cortex-desk-adapters/bin/desk-task.ts, --map, the-metafactory/cortex#2770]
        goal: [/path/to/cortex-desk-adapters/bin/desk-goal.ts]
        note: [/path/to/cortex-desk-adapters/bin/desk-note-tana.ts]
        reminder: [/path/to/cortex-desk-adapters/dist/desk-reminders-mac]
      taskMaps:
        - { ref: the-metafactory/cortex#2770, label: Desk }
```

## Mail actions

A mail item on the Desk offers Delete (and "Seen, delete" on `fyi` and `bulk` mail). Cortex then runs the command set as `mc.desk.mail.actions.trash`, without a shell, and writes one JSON object to its stdin: `{ "action": "trash", "account": "<the item's account>", "messageId": "<the item's id>" }` (`DeskMailActionRequest` in [`src/contract.ts`](src/contract.ts)). Exit 0 means the message moved; on any other exit the last line of stderr is shown to the person.

`desk-mail-trash [--mailbox INBOX]` is that command for the `email` CLI's accounts. It reads the account's IMAP settings from `~/.config/email/config.json` (a password as `keychain:<service>`, `env:<VAR>` or plain text, as the `email` CLI reads it), finds the message in INBOX by an IMAP header search, keeps only messages whose Message-ID is exactly the one asked for, and moves that one message to the mailbox flagged `\Trash` (else one named Trash, Deleted Items or Deleted Messages). It never deletes or expunges. It refuses, and moves nothing, when the message is not in INBOX ("The message is no longer in the work INBOX."), when more than one message has that Message-ID, or when the account has no Trash.

```yaml
mc:
  desk:
    mail:
      actions:
        trash: [/path/to/cortex-desk-adapters/bin/desk-mail-trash.ts]
        timeoutSeconds: 30
```

## Develop

```sh
bun install
bun test
bunx tsc --noEmit
```
