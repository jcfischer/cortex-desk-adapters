// desk-calendar-mac: macOS Calendar events as Desk JSON, read through EventKit.
//
// macOS grants calendar access to the "responsible" process. Started by a daemon, this binary would
// inherit the daemon's responsibility (and its lack of a grant), so it re-launches itself with
// responsibility disclaimed. The grant then belongs to desk-calendar-mac, whoever starts it.
//
// Usage: desk-calendar-mac [--days 5] [--exclude <calendar>]... [--include <calendar>]...
//        desk-calendar-mac --create [--calendar <name>]   (a Desk writer: one calendar request on stdin)
//
// stdin is read only after the relaunch; the child inherits the parent's descriptors, so the request reaches it.

import EventKit
import Foundation

@_silgen_name("responsibility_spawnattrs_setdisclaim")
func responsibility_spawnattrs_setdisclaim(_ attrs: UnsafeMutablePointer<posix_spawnattr_t?>, _ disclaim: Int32) -> Int32

let disclaimedFlag = "DESK_CALENDAR_DISCLAIMED"

func relaunchDisclaimed() -> Never {
  var attrs: posix_spawnattr_t?
  posix_spawnattr_init(&attrs)
  _ = responsibility_spawnattrs_setdisclaim(&attrs, 1)
  let path = Bundle.main.executablePath ?? CommandLine.arguments[0]
  let argv: [UnsafeMutablePointer<CChar>?] = CommandLine.arguments.map { strdup($0) } + [nil]
  var env = ProcessInfo.processInfo.environment
  env[disclaimedFlag] = "1"
  let envp: [UnsafeMutablePointer<CChar>?] = env.map { strdup("\($0.key)=\($0.value)") } + [nil]
  var pid: pid_t = 0
  let rc = posix_spawn(&pid, path, nil, &attrs, argv, envp)
  if rc != 0 {
    FileHandle.standardError.write("desk-calendar-mac: relaunch failed (\(rc))\n".data(using: .utf8)!)
    exit(1)
  }
  var status: Int32 = 0
  while waitpid(pid, &status, 0) == -1 && errno == EINTR {}
  let signal = status & 0x7f
  if signal != 0 {
    FileHandle.standardError.write("desk-calendar-mac: killed by signal \(signal)\n".data(using: .utf8)!)
    exit(128 + signal)
  }
  exit((status >> 8) & 0xff)
}

if ProcessInfo.processInfo.environment[disclaimedFlag] == nil { relaunchDisclaimed() }

var days = 5
var excluded = Set<String>()
var included = Set<String>()
var create = false
var calendarName: String?
var args = CommandLine.arguments.dropFirst().makeIterator()
while let arg = args.next() {
  switch arg {
  case "--days": days = Int(args.next() ?? "") ?? days
  case "--exclude": if let v = args.next() { excluded.insert(v) }
  case "--include": if let v = args.next() { included.insert(v) }
  case "--create": create = true
  case "--calendar": calendarName = args.next()
  default:
    FileHandle.standardError.write("desk-calendar-mac: unknown argument \(arg)\n".data(using: .utf8)!)
    exit(2)
  }
}

// MARK: --create, the Desk calendar writer. Its refusals are one plain sentence on stderr, exit non-zero.

func refuse(_ sentence: String, _ code: Int32 = 2) -> Never {
  FileHandle.standardError.write("\(sentence)\n".data(using: .utf8)!)
  exit(code)
}

if calendarName != nil && !create { refuse("--calendar only applies with --create.") }

struct CalendarRequest {
  let title: String
  let start: Date
  let end: Date?
  let allDay: Bool
  let location: String?
  let notes: String?
}

/// ISO 8601 with an offset (fractional seconds allowed), or a local date / date-time without one.
func parseDate(_ text: String) -> Date? {
  let iso = ISO8601DateFormatter()
  for options: ISO8601DateFormatter.Options in [[.withInternetDateTime, .withFractionalSeconds], [.withInternetDateTime]] {
    iso.formatOptions = options
    if let d = iso.date(from: text) { return d }
  }
  let local = DateFormatter()
  local.locale = Locale(identifier: "en_US_POSIX")
  local.timeZone = TimeZone.current
  local.isLenient = false
  for format in ["yyyy-MM-dd'T'HH:mm:ss", "yyyy-MM-dd'T'HH:mm", "yyyy-MM-dd"] {
    local.dateFormat = format
    if let d = local.date(from: text) { return d }
  }
  return nil
}

/// Reads and checks the writer input before any calendar access, so a refused request touches nothing.
func readCalendarRequest() -> CalendarRequest {
  let data = FileHandle.standardInput.readDataToEndOfFile()
  guard let body = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { refuse("The request is not valid JSON.") }
  guard body["kind"] as? String == "calendar" else { refuse("This writer handles calendar requests, not \(body["kind"].map { "\($0)" } ?? "none").") }
  guard let f = body["fields"] as? [String: Any] else { refuse("The request has no fields.") }
  func text(_ name: String) -> String? {
    guard let v = f[name] else { return nil }
    guard let s = v as? String else { refuse("The \(name) must be text.") }
    let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
    return t.isEmpty ? nil : t
  }
  func time(_ name: String) -> Date? {
    guard let s = text(name) else { return nil }
    guard let d = parseDate(s) else { refuse("The \(name) is not an ISO 8601 time.") }
    return d
  }
  guard let title = text("title") else { refuse("The title is missing.") }
  guard let start = time("start") else { refuse("The start is missing.") }
  var allDay = false
  if let v = f["allDay"] {
    guard let n = v as? NSNumber, CFGetTypeID(n) == CFBooleanGetTypeID() else { refuse("allDay must be true or false.") }
    allDay = n.boolValue
  }
  return CalendarRequest(title: title, start: start, end: time("end"), allDay: allDay, location: text("location"), notes: text("notes"))
}

let request: CalendarRequest? = create ? readCalendarRequest() : nil

let store = EKEventStore()
let done = DispatchSemaphore(value: 0)
var granted = false
store.requestFullAccessToEvents { ok, _ in
  granted = ok
  done.signal()
}
done.wait()
guard granted else {
  FileHandle.standardError.write("desk-calendar-mac: no calendar access; allow it in System Settings > Privacy & Security > Calendars\n".data(using: .utf8)!)
  exit(3)
}

/// Saves the event (.thisEvent) and prints `{ id, message }`; id is the eventIdentifier.
func createEvent(_ r: CalendarRequest) -> Never {
  let target: EKCalendar
  if let name = calendarName {
    let writable = store.calendars(for: .event).filter(\.allowsContentModifications)
    guard let match = writable.first(where: { $0.title == name }) else {
      refuse("There is no calendar named \(name) that takes new events; these do: \(writable.map(\.title).sorted().joined(separator: ", ")).", 4)
    }
    target = match
  } else {
    guard let fallback = store.defaultCalendarForNewEvents else { refuse("There is no default calendar for new events.", 4) }
    target = fallback
  }
  let cal = Calendar.current
  let event = EKEvent(eventStore: store)
  event.calendar = target
  event.title = r.title
  event.isAllDay = r.allDay
  if r.allDay {
    let day = cal.startOfDay(for: r.start)
    // An end at midnight after the start is exclusive, as calendar files write it: the event ends the day before.
    var last = r.end.map { cal.startOfDay(for: $0) == $0 && $0 > day ? $0.addingTimeInterval(-1) : $0 } ?? day
    if last < day { refuse("The end is before the start.") }
    last = cal.startOfDay(for: last)
    event.startDate = day
    event.endDate = last
  } else {
    let end = r.end ?? r.start.addingTimeInterval(3600)
    if end <= r.start { refuse("The end is not after the start.") }
    event.startDate = r.start
    event.endDate = end
  }
  event.location = r.location
  event.notes = r.notes
  do {
    try store.save(event, span: .thisEvent, commit: true)
  } catch {
    refuse("Calendar could not save the event: \(error.localizedDescription)", 5)
  }
  let when = DateFormatter()
  when.locale = Locale(identifier: "en_GB")
  when.timeZone = TimeZone.current
  when.dateFormat = r.allDay ? "EEE d MMM" : "EEE d MMM 'at' HH:mm"
  let message = "Added \"\(r.title)\" to \(target.title) on \(when.string(from: event.startDate))."
  let out = try! JSONSerialization.data(withJSONObject: ["id": event.eventIdentifier ?? event.calendarItemIdentifier, "message": message], options: [])
  FileHandle.standardOutput.write(out)
  FileHandle.standardOutput.write("\n".data(using: .utf8)!)
  exit(0)
}

if let r = request { createEvent(r) }

let calendars = store.calendars(for: .event).filter { cal in
  (included.isEmpty || included.contains(cal.title)) && !excluded.contains(cal.title)
}
let known = Set(store.calendars(for: .event).map(\.title))
let unknown = included.subtracting(known).union(excluded.subtracting(known))
if !unknown.isEmpty {
  FileHandle.standardError.write("desk-calendar-mac: no calendar named \(unknown.sorted().joined(separator: ", ")); known: \(known.sorted().joined(separator: ", "))\n".data(using: .utf8)!)
  exit(4)
}
let start = Calendar.current.startOfDay(for: Date())
let end = Calendar.current.date(byAdding: .day, value: days, to: start)!
let iso = ISO8601DateFormatter()
iso.formatOptions = [.withInternetDateTime]
iso.timeZone = TimeZone.current

var events: [[String: Any]] = []
var seen = Set<String>()

// A multi-day all-day event becomes one entry per day inside the window, like a calendar shows it.
func days(of e: EKEvent) -> [Date] {
  guard e.isAllDay else { return [e.startDate] }
  var out: [Date] = []
  var day = max(Calendar.current.startOfDay(for: e.startDate), start)
  while day < e.endDate && day < end {
    out.append(day)
    day = Calendar.current.date(byAdding: .day, value: 1, to: day)!
  }
  return out
}

if !calendars.isEmpty {
  let predicate = store.predicateForEvents(withStart: start, end: end, calendars: calendars)
  for e in store.events(matching: predicate) {
    for day in days(of: e) {
      let id = "\(e.calendarItemExternalIdentifier ?? e.calendar.title + "|" + (e.title ?? ""))|\(iso.string(from: day))"
      if seen.contains(id) { continue }
      seen.insert(id)
      var entry: [String: Any] = [
        "id": id,
        "start": iso.string(from: e.isAllDay ? day : e.startDate),
        "title": e.title ?? "(no title)",
        "calendar": e.calendar.title,
      ]
      if e.isAllDay { entry["allDay"] = true } else { entry["end"] = iso.string(from: e.endDate) }
      if let loc = e.location, !loc.isEmpty { entry["location"] = loc }
      if let url = e.url?.absoluteString, url.hasPrefix("http") { entry["url"] = url }
      events.append(entry)
    }
  }
}
events.sort { ($0["start"] as! String) < ($1["start"] as! String) }

let data = try JSONSerialization.data(withJSONObject: ["events": events], options: [])
FileHandle.standardOutput.write(data)
