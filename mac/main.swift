// desk-calendar-mac: macOS Calendar events as Desk JSON, read through EventKit.
//
// macOS grants calendar access to the "responsible" process. Started by a daemon, this binary would
// inherit the daemon's responsibility (and its lack of a grant), so it re-launches itself with
// responsibility disclaimed. The grant then belongs to desk-calendar-mac, whoever starts it.
//
// Usage: desk-calendar-mac [--days 5] [--exclude <calendar>]... [--include <calendar>]...

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
var args = CommandLine.arguments.dropFirst().makeIterator()
while let arg = args.next() {
  switch arg {
  case "--days": days = Int(args.next() ?? "") ?? days
  case "--exclude": if let v = args.next() { excluded.insert(v) }
  case "--include": if let v = args.next() { included.insert(v) }
  default:
    FileHandle.standardError.write("desk-calendar-mac: unknown argument \(arg)\n".data(using: .utf8)!)
    exit(2)
  }
}

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
