var Model = require("../Model.js")
var assert = require("assert")

var failures = 0
function check(name, cond) {
  if (!cond) { console.log("FAIL: " + name); failures++ }
  else console.log("ok   " + name)
}

// Fixed "now": Mon 2026-08-17 09:00:00 local
var NOW = new Date(2026, 7, 17, 9, 0, 0).getTime()
var WEEK = NOW + 14 * 24 * 3600 * 1000

// ---- unfolding ----
var folded = "BEGIN:VEVENT\nSUMMARY:Long ti\n tle\nEND:VEVENT"
var lines = Model.unfoldIcs(folded)
check("unfold joins continuation", lines.indexOf("SUMMARY:Long title") !== -1)

// ---- single non-recurring event ----
var ics1 = [
  "BEGIN:VCALENDAR",
  "BEGIN:VEVENT",
  "UID:single1@test",
  "SUMMARY:Dentist",
  "DTSTART:20260818T093000",
  "DTEND:20260818T100000",
  "END:VEVENT",
  "END:VCALENDAR"
].join("\r\n")
var agenda1 = Model.buildAgenda(ics1, NOW, WEEK, 10)
check("single event parsed", agenda1.length === 1 && agenda1[0].summary === "Dentist")

// ---- all-day event ----
var ics2 = [
  "BEGIN:VCALENDAR",
  "BEGIN:VEVENT",
  "UID:allday1@test",
  "SUMMARY:Conference",
  "DTSTART;VALUE=DATE:20260819",
  "DTEND;VALUE=DATE:20260820",
  "END:VEVENT",
  "END:VCALENDAR"
].join("\r\n")
var agenda2 = Model.buildAgenda(ics2, NOW, WEEK, 10)
check("all-day event parsed", agenda2.length === 1 && agenda2[0].allDay === true)

// ---- weekdays-only recurring standup: FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR ----
var ics3 = [
  "BEGIN:VCALENDAR",
  "BEGIN:VEVENT",
  "UID:standup@test",
  "SUMMARY:Standup",
  "DTSTART:20260803T090000", // a Monday, before NOW
  "DTEND:20260803T091500",
  "RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR",
  "END:VEVENT",
  "END:VCALENDAR"
].join("\r\n")
var agenda3 = Model.buildAgenda(ics3, NOW, WEEK, 50)
check("standup recurs on weekdays only within window", agenda3.length === 11) // Aug 17-31 inclusive, weekdays only
var anyWeekend = agenda3.some(function(o) {
  var d = new Date(o.startMs).getDay()
  return d === 0 || d === 6
})
check("standup never lands on a weekend", !anyWeekend)

// ---- monthly "2nd Friday" ----
var ics4 = [
  "BEGIN:VCALENDAR",
  "BEGIN:VEVENT",
  "UID:monthly@test",
  "SUMMARY:Town Hall",
  "DTSTART:20260213T140000", // 2nd Friday of Feb 2026
  "DTEND:20260213T150000",
  "RRULE:FREQ=MONTHLY;BYDAY=2FR",
  "END:VEVENT",
  "END:VCALENDAR"
].join("\r\n")
var monthWindow = NOW + 90 * 24 * 3600 * 1000
var agenda4 = Model.buildAgenda(ics4, NOW, monthWindow, 10)
check("monthly 2nd-Friday produced ~3 occurrences in 90d", agenda4.length >= 2 && agenda4.length <= 4)
agenda4.forEach(function(o) {
  var d = new Date(o.startMs)
  var day = d.getDay()
  check("  occurrence " + d.toDateString() + " is a Friday", day === 5)
})

// ---- yearly birthday ----
var ics5 = [
  "BEGIN:VCALENDAR",
  "BEGIN:VEVENT",
  "UID:bday@test",
  "SUMMARY:Birthday",
  "DTSTART;VALUE=DATE:20200909",
  "DTEND;VALUE=DATE:20200910",
  "RRULE:FREQ=YEARLY",
  "END:VEVENT",
  "END:VCALENDAR"
].join("\r\n")
var yearWindow = NOW + 400 * 24 * 3600 * 1000
var agenda5 = Model.buildAgenda(ics5, NOW, yearWindow, 10)
check("yearly birthday occurs twice in a 400-day window (2026 and 2027)", agenda5.length === 2)
check("yearly birthday keeps month/day", new Date(agenda5[0].startMs).getMonth() === 8 && new Date(agenda5[0].startMs).getDate() === 9)

// ---- override moved from OUTSIDE the window to INSIDE it must still surface ----
var ics5b = [
  "BEGIN:VCALENDAR",
  "BEGIN:VEVENT",
  "UID:pulled-in@test",
  "SUMMARY:Sync",
  "DTSTART:20260710T110000", // original occurrence long before NOW, outside window
  "DTEND:20260710T113000",
  "RRULE:FREQ=WEEKLY;COUNT=2",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:pulled-in@test",
  "RECURRENCE-ID:20260717T110000", // 2nd occurrence's original slot, also before NOW
  "SUMMARY:Sync (rescheduled)",
  "DTSTART:20260818T110000", // moved INTO the window
  "DTEND:20260818T113000",
  "END:VEVENT",
  "END:VCALENDAR"
].join("\r\n")
var agenda5b = Model.buildAgenda(ics5b, NOW, WEEK, 10)
check("override moved into window is surfaced", agenda5b.some(function(o) { return o.summary.indexOf("rescheduled") !== -1 }))
check("override moved into window has no leftover duplicate", agenda5b.length === 1)

// ---- EXDATE removes an instance ----
var ics6 = [
  "BEGIN:VCALENDAR",
  "BEGIN:VEVENT",
  "UID:daily@test",
  "SUMMARY:Daily check",
  "DTSTART:20260817T100000",
  "DTEND:20260817T101000",
  "RRULE:FREQ=DAILY;COUNT=5",
  "EXDATE:20260819T100000",
  "END:VEVENT",
  "END:VCALENDAR"
].join("\r\n")
var agenda6 = Model.buildAgenda(ics6, NOW, WEEK, 10)
check("EXDATE removes one of 5 daily instances", agenda6.length === 4)
check("EXDATE'd date is absent", !agenda6.some(function(o) { return new Date(o.startMs).getDate() === 19 }))

// ---- RECURRENCE-ID override changes one instance's time/title ----
var ics7 = [
  "BEGIN:VCALENDAR",
  "BEGIN:VEVENT",
  "UID:weekly@test",
  "SUMMARY:1:1",
  "DTSTART:20260817T110000",
  "DTEND:20260817T113000",
  "RRULE:FREQ=WEEKLY;COUNT=3",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:weekly@test",
  "RECURRENCE-ID:20260824T110000",
  "SUMMARY:1:1 (moved)",
  "DTSTART:20260824T150000",
  "DTEND:20260824T153000",
  "END:VEVENT",
  "END:VCALENDAR"
].join("\r\n")
var agenda7 = Model.buildAgenda(ics7, NOW, WEEK, 10)
var moved = agenda7.filter(function(o) { return o.summary.indexOf("moved") !== -1 })
check("override present with new title", moved.length === 1)
check("override uses new time (15:00) not original (11:00)", new Date(moved[0].startMs).getHours() === 15)
// The 3rd weekly occurrence (Aug 31) falls outside the 14-day window, so
// only Aug 17 (unmodified) + Aug 24 (moved) are in range — no duplicate.
check("no duplicate for the moved instance", agenda7.length === 2)

// ---- CANCELLED status is dropped ----
var ics8 = [
  "BEGIN:VCALENDAR",
  "BEGIN:VEVENT",
  "UID:cancelled1@test",
  "SUMMARY:Oops",
  "DTSTART:20260818T090000",
  "DTEND:20260818T100000",
  "STATUS:CANCELLED",
  "END:VEVENT",
  "END:VCALENDAR"
].join("\r\n")
check("cancelled event excluded", Model.buildAgenda(ics8, NOW, WEEK, 10).length === 0)

// ---- meeting link extraction ----
check("Meet link found in LOCATION", Model.extractMeetingUrl("https://meet.google.com/abc-defg-hij", "") === "https://meet.google.com/abc-defg-hij")
check("Meet link found in DESCRIPTION", Model.extractMeetingUrl("", "Join with Google Meet\nhttps://meet.google.com/abc-defg-hij\n\nOr dial: +1 555-0100") === "https://meet.google.com/abc-defg-hij")
check("LOCATION wins when both carry a link", Model.extractMeetingUrl("https://meet.google.com/loc-ation-x", "https://meet.google.com/desc-ripti-on") === "https://meet.google.com/loc-ation-x")
check("Zoom subdomain link recognized", Model.extractMeetingUrl("", "https://us02web.zoom.us/j/1234567890?pwd=abc123") === "https://us02web.zoom.us/j/1234567890?pwd=abc123")
check("Teams link recognized", Model.extractMeetingUrl("https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc", "") === "https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc")
check("no meeting link -> empty string", Model.extractMeetingUrl("Conference Room 4B", "Bring the laptop.") === "")
check("stops at whitespace, not the rest of the sentence", Model.extractMeetingUrl("", "Meet: https://meet.google.com/abc-defg-hij for the sync") === "https://meet.google.com/abc-defg-hij")

var icsWithMeet = [
  "BEGIN:VCALENDAR",
  "BEGIN:VEVENT",
  "UID:meet1@test",
  "SUMMARY:Design Review",
  "DTSTART:20260818T090000",
  "DTEND:20260818T093000",
  "LOCATION:https://meet.google.com/abc-defg-hij",
  "DESCRIPTION:Join with Google Meet\\nhttps://meet.google.com/abc-defg-hij",
  "END:VEVENT",
  "END:VCALENDAR"
].join("\r\n")
check("buildAgenda surfaces meetingUrl on the occurrence", Model.buildAgenda(icsWithMeet, NOW, WEEK, 10)[0].meetingUrl === "https://meet.google.com/abc-defg-hij")

var icsNoMeet = [
  "BEGIN:VCALENDAR",
  "BEGIN:VEVENT",
  "UID:nomeet1@test",
  "SUMMARY:In-person lunch",
  "DTSTART:20260818T120000",
  "DTEND:20260818T130000",
  "LOCATION:Cafe on 5th",
  "END:VEVENT",
  "END:VCALENDAR"
].join("\r\n")
check("buildAgenda leaves meetingUrl empty when there is none", Model.buildAgenda(icsNoMeet, NOW, WEEK, 10)[0].meetingUrl === "")

// ---- not an ICS feed at all (e.g. wrong URL pasted, got HTML back) ----
var threw = false
try { Model.buildAgenda("<html><body>nope</body></html>", NOW, WEEK, 10) } catch (e) { threw = true; check("throws recognizable error", e.code === "not-icalendar") }
check("throws on non-ICS input", threw)

// ---- formatting ----
check("dayLabel Today", Model.dayLabel(NOW + 3600000, NOW) === "Today")
check("dayLabel Tomorrow", Model.dayLabel(NOW + 24 * 3600 * 1000, NOW) === "Tomorrow")
check("formatClock 13:05 -> 1:05 PM", Model.formatClock(new Date(2026, 0, 1, 13, 5).getTime()) === "1:05 PM")
check("formatClock 00:00 -> 12:00 AM", Model.formatClock(new Date(2026, 0, 1, 0, 0).getTime()) === "12:00 AM")

// ---- bar pill tiers: quiet when far off, loud only near/at start ----
var GLYPH = Model.CALENDAR_GLYPH
check("no event -> glyph only", Model.formatBarLabel(null, NOW) === GLYPH)

var tomorrowEvent = { summary: "Offsite", startMs: NOW + 25 * 3600 * 1000, endMs: NOW + 26 * 3600 * 1000, allDay: false }
check("event tomorrow -> glyph only, no title/time leak", Model.formatBarLabel(tomorrowEvent, NOW) === GLYPH)

var laterTodayEvent = { summary: "Design Review", startMs: NOW + 5 * 3600 * 1000, endMs: NOW + 6 * 3600 * 1000, allDay: false }
var laterTodayLabel = Model.formatBarLabel(laterTodayEvent, NOW)
check("event later today (not imminent) -> bare time, no title", laterTodayLabel === GLYPH + " " + Model.formatClock(laterTodayEvent.startMs))
check("  ...and doesn't leak the title", laterTodayLabel.indexOf("Design Review") === -1)

var imminentEvent = { summary: "Standup", startMs: NOW + 45 * 60 * 1000, endMs: NOW + 60 * 60 * 1000, allDay: false }
check("event in 45m -> title + countdown", Model.formatBarLabel(imminentEvent, NOW) === GLYPH + " Standup in 45m")

var ongoingEvent = { summary: "1:1 with Sam", startMs: NOW - 15 * 60 * 1000, endMs: NOW + 15 * 60 * 1000, allDay: false }
check("ongoing event -> title + now", Model.formatBarLabel(ongoingEvent, NOW) === GLYPH + " 1:1 with Sam · now")

// Model no longer character-truncates long titles — MarqueeText.qml owns
// width capping + hover-to-reveal scrolling on the QML side instead.
var longTitle = "Quarterly Planning and Roadmap Alignment Sync"
var longTitleEvent = { summary: longTitle, startMs: NOW + 10 * 60 * 1000, endMs: NOW + 40 * 60 * 1000, allDay: false }
check("long title passes through untruncated", Model.formatBarLabel(longTitleEvent, NOW) === GLYPH + " " + longTitle + " in 10m")

// ---- feed URL validation ----
check("valid gcal ics url passes", Model.validateFeedUrl("https://calendar.google.com/calendar/ical/me%40gmail.com/private-abc123/basic.ics") === "")
check("empty url rejected", Model.validateFeedUrl("") !== "")
check("http (not https) rejected", Model.validateFeedUrl("http://calendar.google.com/calendar/ical/x/private-a/basic.ics") !== "")
check("public sharing link rejected", Model.validateFeedUrl("https://calendar.google.com/calendar/embed?src=me") !== "")
check("public ICS address (not secret) rejected", Model.validateFeedUrl("https://calendar.google.com/calendar/ical/richard%40feedmob.com/public/basic.ics") !== "")
check("public ICS address gets a specific hint, not the generic one", /Public address/.test(Model.validateFeedUrl("https://calendar.google.com/calendar/ical/richard%40feedmob.com/public/basic.ics")))

console.log("")
console.log(failures === 0 ? "ALL PASS" : (failures + " FAILURE(S)"))
process.exit(failures === 0 ? 0 : 1)
