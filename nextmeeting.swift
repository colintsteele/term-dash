// nextmeeting — print the next calendar event as JSON, for local-status's left segment.
//
// Reads the local EventKit store, which is where Calendar.app parks an Exchange
// account's events after it syncs them. That indirection is the whole point:
// new Outlook (16.112+) still answers AppleScript for `calendar 1` but reports
// zero `calendar events`, so scripting Outlook directly is a dead end. Syncing
// the M365 account into Calendar.app and reading EventKit gets push-fresh data
// with no OAuth app registration and no token to rotate.
//
// EventKit needs a usage string in the binary's __TEXT,__info_plist section or
// the permission prompt is skipped and access is denied outright — see the
// -sectcreate flags in build.sh. The prompt is attributed to the terminal app
// (iTerm), not to this binary, so it is granted once per terminal.
//
// Two modes, two shapes: no args prints the NEXT meeting (for local-status's
// left segment), `--agenda` prints the whole calendar day (for morning-brief).
// See the comment on `struct Agenda` for why they are not the same query.
//
// Output is a single JSON object on stdout, always — `access` and `error` are
// reported in-band so the caller can tell "no meetings" from "we can't see the
// calendar", which look identical if you only ever print events.

import EventKit
import Foundation

let HORIZON_HOURS = 14.0

// A meeting is worth showing until it ends, not until it starts: mid-meeting is
// exactly when you look up to check what you're in. Only once it's over does the
// strip move on to the next one.

struct Meeting: Encodable {
    let title: String
    let start: String
    let end: String
    let minutes_until: Int  // negative while in progress
    let in_progress: Bool
    let all_day: Bool
    let location: String?
    let join_url: String?
    let calendar: String
}

struct Report: Encodable {
    let checked_at: String
    let access: String  // granted | denied | restricted | unknown
    let error: String?
    let next: Meeting?
    let later_count: Int  // further events inside the horizon, after `next`
}

// `--agenda` answers a different question from the default output, so it gets
// its own shape rather than a longer `later_count`. The status strip asks "what
// is the one thing coming up"; the morning brief asks "what does today LOOK
// like" — which needs every event, including the ones already over (so the
// shape of the day is intact at 2pm) and the all-day banners the strip
// deliberately drops (an OOO banner is not your next meeting, but it is very
// much part of your day).
struct Agenda: Encodable {
    let checked_at: String
    let access: String
    let error: String?
    let day: String
    let events: [Meeting]
}

let iso: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime]
    f.timeZone = TimeZone.current
    return f
}()

func emit(_ r: Report) -> Never {
    let enc = JSONEncoder()
    enc.outputFormatting = [.prettyPrinted, .sortedKeys]
    if let data = try? enc.encode(r), let s = String(data: data, encoding: .utf8) {
        print(s)
    } else {
        print("{\"access\":\"unknown\",\"error\":\"encode failed\",\"next\":null,\"later_count\":0}")
    }
    exit(0)
}

func fail(access: String, _ message: String) -> Never {
    emit(Report(checked_at: iso.string(from: Date()), access: access,
                error: message, next: nil, later_count: 0))
}

// Teams puts its join link in the event URL on some syncs and buries it in the
// body on others, so check both. Worth the trouble: local-status wraps it in an
// OSC-8 hyperlink, which turns the strip into a one-click join.
func joinURL(_ ev: EKEvent) -> String? {
    if let u = ev.url?.absoluteString, u.contains("teams.microsoft.com") || u.contains("zoom.us") {
        return u
    }
    guard let notes = ev.notes else { return nil }
    let patterns = [
        #"https://teams\.microsoft\.com/l/meetup-join/[^\s"'<>]+"#,
        #"https://[a-zA-Z0-9.-]*zoom\.us/j/[^\s"'<>]+"#,
        #"https://meet\.google\.com/[a-z-]+"#,
    ]
    for p in patterns {
        if let re = try? NSRegularExpression(pattern: p),
           let m = re.firstMatch(in: notes, range: NSRange(notes.startIndex..., in: notes)),
           let r = Range(m.range, in: notes) {
            return String(notes[r])
        }
    }
    return nil
}

// Events you declined are not your next meeting. EventKit reports your own
// participation via the attendee flagged isCurrentUser.
func declined(_ ev: EKEvent) -> Bool {
    if ev.status == .canceled { return true }
    guard let attendees = ev.attendees else { return false }
    for a in attendees where a.isCurrentUser {
        return a.participantStatus == .declined
    }
    return false
}

let store = EKEventStore()

// Access request is async and this is a one-shot CLI, so block on a semaphore
// rather than spinning a run loop.
let sem = DispatchSemaphore(value: 0)
var granted = false
var requestError: Error?

if #available(macOS 14.0, *) {
    store.requestFullAccessToEvents { ok, err in
        granted = ok; requestError = err; sem.signal()
    }
} else {
    store.requestAccess(to: .event) { ok, err in
        granted = ok; requestError = err; sem.signal()
    }
}

// A prompt the user never answers must not wedge the caller. local-status polls
// on a 5s tick and treats a missing/!ok exit as "nothing to show", so bailing
// out loudly here is better than hanging.
//
// Inside NextMeeting.app (the bundle the morning brief launches with `open`)
// the first run is someone answering the permission dialog, so give them two
// minutes instead of ten seconds. Nothing polls the bundle.
let promptWait: Double = Bundle.main.bundlePath.hasSuffix(".app") ? 120 : 10
if sem.wait(timeout: .now() + promptWait) == .timedOut {
    fail(access: "unknown", "timed out waiting for calendar permission")
}
if let e = requestError {
    fail(access: "denied", e.localizedDescription)
}
if !granted {
    let status = EKEventStore.authorizationStatus(for: .event)
    fail(access: status == .restricted ? "restricted" : "denied",
         Bundle.main.bundlePath.hasSuffix(".app")
           ? "calendar access not granted to NextMeeting.app"
           : "calendar access not granted to the terminal app")
}

// `--calendars` exists to answer the one question that breaks this setup: did
// the Exchange account actually reach EventKit? A synced-but-empty calendar and
// an account that never synced both render as "no meetings" otherwise.
if CommandLine.arguments.contains("--calendars") {
    for c in store.calendars(for: .event) {
        let src = c.source?.title ?? "?"
        print("\(c.title)  [source: \(src), type: \(c.type.rawValue)]")
    }
    exit(0)
}

let now = Date()
let horizon = now.addingTimeInterval(HORIZON_HOURS * 3600)
let calendars = store.calendars(for: .event)
if calendars.isEmpty {
    fail(access: "granted", "no calendars in EventKit — is the account synced in Calendar.app?")
}

// Emitted before the horizon window is built, because the agenda's range is the
// CALENDAR DAY, not a rolling 14 hours: a brief generated at 06:00 with a 14h
// horizon would silently cut the day off at 20:00.
if CommandLine.arguments.contains("--agenda") {
    let cal = Calendar.current
    let dayStart = cal.startOfDay(for: now)
    let dayEnd = cal.date(byAdding: .day, value: 1, to: dayStart) ?? now
    let dayFmt: DateFormatter = {
        let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd"; return f
    }()

    let pred = store.predicateForEvents(withStart: dayStart, end: dayEnd, calendars: calendars)
    let todays = store.events(matching: pred)
        // Declined and canceled are dropped — those are not on your day. `.free`
        // is KEPT, unlike the strip: a focus block is exactly the kind of thing
        // the agenda exists to show you.
        .filter { !declined($0) }
        .sorted { ($0.startDate ?? now) < ($1.startDate ?? now) }

    let out: [Meeting] = todays.compactMap { ev in
        guard let start = ev.startDate else { return nil }
        let end = ev.endDate ?? start
        return Meeting(
            title: ev.title ?? "(untitled)",
            start: iso.string(from: start),
            end: iso.string(from: end),
            minutes_until: Int((start.timeIntervalSince(now) / 60).rounded()),
            in_progress: start <= now && end > now,
            all_day: ev.isAllDay,
            location: ev.location?.isEmpty == false ? ev.location : nil,
            join_url: joinURL(ev),
            calendar: ev.calendar?.title ?? "?"
        )
    }

    let enc = JSONEncoder()
    enc.outputFormatting = [.prettyPrinted, .sortedKeys]
    let report = Agenda(checked_at: iso.string(from: now), access: "granted",
                        error: nil, day: dayFmt.string(from: now), events: out)
    if let data = try? enc.encode(report), let s = String(data: data, encoding: .utf8) {
        print(s)
    }
    exit(0)
}

let predicate = store.predicateForEvents(withStart: now, end: horizon, calendars: calendars)
let raw = store.events(matching: predicate)

// Why an event isn't the next meeting. Returning the reason rather than a Bool
// is what makes `--all` useful: "no meetings" and "four meetings, all filtered"
// are the same output otherwise, and they need different fixes.
func skipReason(_ ev: EKEvent, now: Date) -> String? {
    if ev.isAllDay { return "all-day" }
    if ev.availability == .free { return "free" }
    if ev.status == .canceled { return "canceled" }
    if declined(ev) { return "declined" }
    if (ev.endDate ?? now) <= now { return "ended" }
    return nil
}

// `--all` dumps the horizon unfiltered, each line tagged with the filter that
// dropped it. The companion to `--calendars`: that one answers "can EventKit see
// the account", this one answers "it can see the event and still shows nothing".
if CommandLine.arguments.contains("--all") {
    let hm: DateFormatter = {
        let f = DateFormatter(); f.dateFormat = "EEE HH:mm"; return f
    }()
    print("\(raw.count) event(s) in the next \(Int(HORIZON_HOURS))h")
    for ev in raw.sorted(by: { ($0.startDate ?? now) < ($1.startDate ?? now) }) {
        let when = ev.startDate.map { hm.string(from: $0) } ?? "?"
        let tag = skipReason(ev, now: now).map { "SKIP(\($0))" } ?? "ok"
        print("  \(tag)\t\(when)\t[\(ev.calendar?.title ?? "?")]\t\(ev.title ?? "(untitled)")")
    }
    exit(0)
}

let events = raw
    // All-day entries are banners (holidays, PTO, "OOO"), not something you walk
    // into a room for, and one would otherwise pin itself to the strip all day.
    // `.free` is how Outlook marks focus blocks and FYI invites — not a meeting.
    .filter { skipReason($0, now: now) == nil }
    .sorted { ($0.startDate ?? now) < ($1.startDate ?? now) }

guard let next = events.first, let start = next.startDate else {
    emit(Report(checked_at: iso.string(from: now), access: "granted",
                error: nil, next: nil, later_count: 0))
}

let end = next.endDate ?? start
let meeting = Meeting(
    title: next.title ?? "(untitled)",
    start: iso.string(from: start),
    end: iso.string(from: end),
    minutes_until: Int((start.timeIntervalSince(now) / 60).rounded()),
    in_progress: start <= now,
    all_day: next.isAllDay,
    location: next.location?.isEmpty == false ? next.location : nil,
    join_url: joinURL(next),
    calendar: next.calendar?.title ?? "?"
)

emit(Report(checked_at: iso.string(from: now), access: "granted", error: nil,
            next: meeting, later_count: max(0, events.count - 1)))
