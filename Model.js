// Pure logic for the Google Calendar Events plugin: no QML/Quickshell
// imports here so this can be unit-tested with plain node (see
// tools/test-model.js) and reused unchanged by BarWidget.qml / Panel.qml.
//
// Data source is a Google Calendar "secret address in iCal format" feed
// (see README.md for how to get one), fetched over plain HTTPS with curl
// and parsed here. Two deliberate scope limits, both documented so they
// aren't mistaken for bugs:
//
// 1. RRULE expansion covers DAILY/WEEKLY/MONTHLY/YEARLY with INTERVAL,
//    COUNT, UNTIL, BYDAY (with ordinal for MONTHLY/YEARLY), BYMONTHDAY,
//    BYMONTH — the shapes Google Calendar's own UI actually produces.
//    BYSETPOS, BYWEEKNO, and sub-daily frequencies are not implemented.
// 2. DTSTART/DTEND values carrying a TZID (or no zone at all) are treated
//    as wall-clock time in the machine's local timezone rather than the
//    named IANA zone. This is exact when the calendar's timezone matches
//    the machine running the shell (the common case for a personal
//    calendar viewed on your own desktop) and only drifts otherwise.

var WEEKDAY_CODES = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 }
var CALENDAR_GLYPH = ""

// ---- ICS line unfolding & content-line parsing -----------------------

function unfoldIcs(raw) {
  var normalized = String(raw || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n")
  var rawLines = normalized.split("\n")
  var lines = []
  for (var i = 0; i < rawLines.length; i++) {
    var line = rawLines[i]
    if ((line.charAt(0) === " " || line.charAt(0) === "\t") && lines.length > 0) {
      lines[lines.length - 1] += line.slice(1)
    } else if (line.length > 0) {
      lines.push(line)
    }
  }
  return lines
}

function parseContentLine(line) {
  var colonIndex = String(line || "").indexOf(":")
  if (colonIndex === -1) return null
  var head = line.slice(0, colonIndex)
  var value = line.slice(colonIndex + 1)
  var parts = head.split(";")
  var name = parts[0].toUpperCase()
  var params = {}
  for (var i = 1; i < parts.length; i++) {
    var eq = parts[i].indexOf("=")
    if (eq === -1) continue
    params[parts[i].slice(0, eq).toUpperCase()] = parts[i].slice(eq + 1)
  }
  return { name: name, params: params, value: value }
}

function unescapeText(value) {
  return String(value || "")
    .replace(/\\n/gi, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\")
}

function splitVevents(lines) {
  var events = []
  var current = null
  for (var i = 0; i < lines.length; i++) {
    var cl = parseContentLine(lines[i])
    if (!cl) continue
    if (cl.name === "BEGIN" && cl.value === "VEVENT") { current = []; continue }
    if (cl.name === "END" && cl.value === "VEVENT") { if (current) events.push(current); current = null; continue }
    if (current) current.push(cl)
  }
  return events
}

// ---- Date/time parsing -------------------------------------------------

// Returns { ms, allDay } or null. See module header for the TZID caveat.
function parseIcsDateTime(value, params) {
  var v = String(value || "").trim()
  params = params || {}
  if (v === "") return null

  if (params.VALUE === "DATE" || /^\d{8}$/.test(v)) {
    var m = /^(\d{4})(\d{2})(\d{2})$/.exec(v)
    if (!m) return null
    var dateOnly = new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10), 0, 0, 0, 0)
    return { ms: dateOnly.getTime(), allDay: true }
  }

  var m2 = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/.exec(v)
  if (!m2) return null
  var year = parseInt(m2[1], 10), month = parseInt(m2[2], 10) - 1, day = parseInt(m2[3], 10)
  var hour = parseInt(m2[4], 10), minute = parseInt(m2[5], 10), second = parseInt(m2[6], 10)
  var ms = m2[7]
    ? Date.UTC(year, month, day, hour, minute, second)
    : new Date(year, month, day, hour, minute, second, 0).getTime()
  return { ms: ms, allDay: false }
}

// ---- RRULE parsing & expansion -----------------------------------------

function parseByDayToken(token) {
  var m = /^([+-]?\d+)?(SU|MO|TU|WE|TH|FR|SA)$/.exec(String(token || "").trim())
  if (!m) return null
  return { ordinal: m[1] ? parseInt(m[1], 10) : 0, weekday: WEEKDAY_CODES[m[2]] }
}

function parseRRule(value) {
  var rule = { freq: null, interval: 1, count: null, until: null, byday: [], bymonthday: [], bymonth: [] }
  var parts = String(value || "").split(";")
  for (var i = 0; i < parts.length; i++) {
    var kv = parts[i].split("=")
    if (kv.length !== 2) continue
    var key = kv[0].toUpperCase()
    var val = kv[1]
    if (key === "FREQ") rule.freq = val.toUpperCase()
    else if (key === "INTERVAL") rule.interval = Math.max(1, parseInt(val, 10) || 1)
    else if (key === "COUNT") rule.count = parseInt(val, 10) || null
    else if (key === "UNTIL") { var parsed = parseIcsDateTime(val, {}); rule.until = parsed ? parsed.ms : null }
    else if (key === "BYDAY") rule.byday = val.split(",").map(parseByDayToken).filter(function(x) { return !!x })
    else if (key === "BYMONTHDAY") rule.bymonthday = val.split(",").map(function(x) { return parseInt(x, 10) })
    else if (key === "BYMONTH") rule.bymonth = val.split(",").map(function(x) { return parseInt(x, 10) })
  }
  return rule
}

function addDays(ms, n) {
  var d = new Date(ms)
  d.setDate(d.getDate() + n)
  return d.getTime()
}

// ordinal > 0: nth weekday from the start of the month. ordinal < 0: nth
// from the end. ordinal === 0 (bare BYDAY, no leading number): not
// supported for MONTHLY/YEARLY — Google's own UI always supplies one.
function nthWeekdayOfMonth(year, month, weekday, ordinal) {
  if (ordinal > 0) {
    var first = new Date(year, month, 1)
    var offset = (weekday - first.getDay() + 7) % 7
    var day = 1 + offset + (ordinal - 1) * 7
    var maxDay = new Date(year, month + 1, 0).getDate()
    return day > maxDay ? null : new Date(year, month, day).getTime()
  }
  if (ordinal < 0) {
    var last = new Date(year, month + 1, 0)
    var offsetFromEnd = (last.getDay() - weekday + 7) % 7
    var day2 = last.getDate() - offsetFromEnd + (ordinal + 1) * 7
    return day2 < 1 ? null : new Date(year, month, day2).getTime()
  }
  return null
}

// emit(ms) returns false once the caller should stop the whole expansion
// (UNTIL passed, window exceeded, or COUNT reached), true to keep going.
function makeEmitter(rrule, durationMs, exdateSet, windowStartMs, windowEndMs, results) {
  var count = 0
  return function emit(ms) {
    if (rrule.until != null && ms > rrule.until) return false
    if (ms > windowEndMs) return false
    count++
    if (rrule.count != null && count > rrule.count) return false
    if (ms + durationMs >= windowStartMs && !exdateSet[ms]) results.push(ms)
    return !(rrule.count != null && count >= rrule.count)
  }
}

// Expands a recurring VEVENT into concrete start times (ms) that overlap
// [windowStartMs, windowEndMs]. Bounded by maxLoops so a malformed or
// open-ended RRULE (no COUNT/UNTIL) can never spin.
function expandRecurrence(dtstartMs, durationMs, rrule, exdateSet, windowStartMs, windowEndMs, maxInstances) {
  var results = []
  if (!rrule || !rrule.freq) return results

  var maxLoops = 3000
  var loops = 0
  var hardUntilMs = rrule.until != null ? rrule.until : windowEndMs
  var anchor = new Date(dtstartMs)
  var anchorWeekday = anchor.getDay()
  var anchorMonthday = anchor.getDate()
  var anchorMonth = anchor.getMonth()
  var anchorYear = anchor.getFullYear()
  var anchorHours = anchor.getHours(), anchorMinutes = anchor.getMinutes(), anchorSeconds = anchor.getSeconds()
  var emit = makeEmitter(rrule, durationMs, exdateSet, windowStartMs, windowEndMs, results)

  function atAnchorTime(dayMs) {
    var d = new Date(dayMs)
    d.setHours(anchorHours, anchorMinutes, anchorSeconds, 0)
    return d.getTime()
  }

  if (rrule.freq === "DAILY") {
    var cursor = dtstartMs
    var doneD = false
    while (!doneD && loops++ < maxLoops) {
      if (!emit(cursor)) doneD = true
      else {
        cursor = addDays(cursor, rrule.interval)
        if (cursor > hardUntilMs + 24 * 3600 * 1000) doneD = true
      }
    }
  } else if (rrule.freq === "WEEKLY") {
    var weekdays = rrule.byday.length > 0 ? rrule.byday.map(function(b) { return b.weekday }) : [anchorWeekday]
    weekdays.sort(function(a, b) { return a - b })
    var weekCursorStart = addDays(dtstartMs, -anchorWeekday)
    var weekIndex = 0
    var doneW = false
    while (!doneW && loops++ < maxLoops) {
      var weekBaseMs = addDays(weekCursorStart, weekIndex * 7 * rrule.interval)
      for (var w = 0; w < weekdays.length && !doneW; w++) {
        var candMs = atAnchorTime(addDays(weekBaseMs, weekdays[w]))
        if (candMs < dtstartMs) continue
        if (!emit(candMs)) doneW = true
      }
      if (weekBaseMs > hardUntilMs + 7 * 24 * 3600 * 1000) doneW = true
      weekIndex++
    }
  } else if (rrule.freq === "MONTHLY") {
    var monthIndex = 0
    var doneM = false
    while (!doneM && loops++ < maxLoops) {
      var baseMonthRaw = anchorMonth + monthIndex * rrule.interval
      var baseYear = anchorYear + Math.floor(baseMonthRaw / 12)
      var normMonth = ((baseMonthRaw % 12) + 12) % 12
      var candidates = []
      if (rrule.byday.length > 0) {
        for (var bi = 0; bi < rrule.byday.length; bi++) {
          var dm = nthWeekdayOfMonth(baseYear, normMonth, rrule.byday[bi].weekday, rrule.byday[bi].ordinal)
          if (dm != null) candidates.push(dm)
        }
      } else if (rrule.bymonthday.length > 0) {
        var maxDayM = new Date(baseYear, normMonth + 1, 0).getDate()
        for (var mi = 0; mi < rrule.bymonthday.length; mi++) {
          var dom = rrule.bymonthday[mi]
          var day = dom > 0 ? dom : (maxDayM + dom + 1)
          if (day >= 1 && day <= maxDayM) candidates.push(new Date(baseYear, normMonth, day).getTime())
        }
      } else {
        var maxDayM2 = new Date(baseYear, normMonth + 1, 0).getDate()
        if (anchorMonthday <= maxDayM2) candidates.push(new Date(baseYear, normMonth, anchorMonthday).getTime())
      }
      candidates.sort(function(a, b) { return a - b })
      for (var ci = 0; ci < candidates.length && !doneM; ci++) {
        var candM = atAnchorTime(candidates[ci])
        if (candM < dtstartMs) continue
        if (!emit(candM)) doneM = true
      }
      if (new Date(baseYear, normMonth, 1).getTime() > hardUntilMs + 40 * 24 * 3600 * 1000) doneM = true
      monthIndex++
    }
  } else if (rrule.freq === "YEARLY") {
    var yearIndex = 0
    var doneY = false
    while (!doneY && loops++ < maxLoops) {
      var year = anchorYear + yearIndex * rrule.interval
      var months = rrule.bymonth.length > 0 ? rrule.bymonth.map(function(mo) { return mo - 1 }) : [anchorMonth]
      var candidatesY = []
      for (var mj = 0; mj < months.length; mj++) {
        var mth = months[mj]
        if (rrule.byday.length > 0) {
          for (var bj = 0; bj < rrule.byday.length; bj++) {
            var ordinal = rrule.byday[bj].ordinal || 1
            var dY = nthWeekdayOfMonth(year, mth, rrule.byday[bj].weekday, ordinal)
            if (dY != null) candidatesY.push(dY)
          }
        } else {
          var maxDayY = new Date(year, mth + 1, 0).getDate()
          candidatesY.push(new Date(year, mth, Math.min(anchorMonthday, maxDayY)).getTime())
        }
      }
      candidatesY.sort(function(a, b) { return a - b })
      for (var ck = 0; ck < candidatesY.length && !doneY; ck++) {
        var candY = atAnchorTime(candidatesY[ck])
        if (candY < dtstartMs) continue
        if (!emit(candY)) doneY = true
      }
      if (new Date(year, 11, 31).getTime() > hardUntilMs + 400 * 24 * 3600 * 1000) doneY = true
      yearIndex++
    }
  }

  results.sort(function(a, b) { return a - b })
  if (maxInstances && results.length > maxInstances) results = results.slice(0, maxInstances)
  return results
}

// ---- VEVENT parsing ------------------------------------------------------

function parseVeventBlock(block) {
  var ev = {
    uid: "", summary: "", location: "", description: "", status: "",
    dtstart: null, dtend: null, rrule: null, exdates: [], recurrenceId: null
  }
  for (var i = 0; i < block.length; i++) {
    var cl = block[i]
    if (cl.name === "UID") ev.uid = cl.value
    else if (cl.name === "SUMMARY") ev.summary = unescapeText(cl.value)
    else if (cl.name === "LOCATION") ev.location = unescapeText(cl.value)
    else if (cl.name === "DESCRIPTION") ev.description = unescapeText(cl.value)
    else if (cl.name === "STATUS") ev.status = cl.value.toUpperCase()
    else if (cl.name === "DTSTART") ev.dtstart = parseIcsDateTime(cl.value, cl.params)
    else if (cl.name === "DTEND") ev.dtend = parseIcsDateTime(cl.value, cl.params)
    else if (cl.name === "RRULE") ev.rrule = parseRRule(cl.value)
    else if (cl.name === "EXDATE") {
      var parts = cl.value.split(",")
      for (var p = 0; p < parts.length; p++) {
        var d = parseIcsDateTime(parts[p], cl.params)
        if (d) ev.exdates.push(d.ms)
      }
    } else if (cl.name === "RECURRENCE-ID") {
      var rid = parseIcsDateTime(cl.value, cl.params)
      if (rid) ev.recurrenceId = rid.ms
    }
  }
  if (!ev.dtstart) return null
  return ev
}

// Google's ICS export has no structured "conference data" field (that only
// exists in the real Calendar API) — but a Meet/Zoom/Teams/Webex link, when
// present, reliably shows up as plain text in LOCATION and/or DESCRIPTION.
// LOCATION wins when both carry one, since that's where Google's own "Add
// Google Meet video conferencing" puts it.
var MEETING_URL_PATTERN = /https?:\/\/(?:[a-z0-9-]+\.)*(?:meet\.google\.com|zoom\.us|teams\.microsoft\.com|teams\.live\.com|webex\.com)\/[^\s<>"']+/i

function extractMeetingUrl(location, description) {
  var fromLocation = String(location || "").match(MEETING_URL_PATTERN)
  if (fromLocation) return fromLocation[0]
  var fromDescription = String(description || "").match(MEETING_URL_PATTERN)
  if (fromDescription) return fromDescription[0]
  return ""
}

function toOccurrence(ev, startMs, endMs) {
  return {
    uid: ev.uid,
    summary: ev.summary || "(No title)",
    location: ev.location || "",
    meetingUrl: extractMeetingUrl(ev.location, ev.description),
    startMs: startMs,
    endMs: endMs,
    allDay: ev.dtstart.allDay
  }
}

// ---- Top-level: raw ICS text -> sorted, windowed occurrence list --------

function buildAgenda(rawIcs, nowMs, windowEndMs, maxEvents) {
  var text = String(rawIcs || "")
  if (!/BEGIN:VCALENDAR/i.test(text)) {
    var err = new Error("not-icalendar")
    err.code = "not-icalendar"
    throw err
  }

  var lines = unfoldIcs(text)
  var blocks = splitVevents(lines)
  var masters = []
  var overridesByUid = {}

  for (var i = 0; i < blocks.length; i++) {
    var ev = parseVeventBlock(blocks[i])
    if (!ev || ev.status === "CANCELLED") continue
    if (ev.recurrenceId != null) {
      overridesByUid[ev.uid] = overridesByUid[ev.uid] || {}
      overridesByUid[ev.uid][String(ev.recurrenceId)] = ev
    } else {
      masters.push(ev)
    }
  }

  var occurrences = []
  for (var j = 0; j < masters.length; j++) {
    var master = masters[j]
    var duration = master.dtend != null ? (master.dtend.ms - master.dtstart.ms) : 0
    if (duration < 0) duration = 0
    var overrideMap = overridesByUid[master.uid] || {}

    if (master.rrule) {
      var exdateSet = {}
      for (var e = 0; e < master.exdates.length; e++) exdateSet[master.exdates[e]] = true

      var startMsList = expandRecurrence(master.dtstart.ms, duration, master.rrule, exdateSet, nowMs, windowEndMs, 200)
      var seenOverrideKeys = {}
      for (var s = 0; s < startMsList.length; s++) {
        var occStart = startMsList[s]
        var override = overrideMap[String(occStart)]
        if (override) {
          seenOverrideKeys[String(occStart)] = true
          var ovEnd = override.dtend ? override.dtend.ms : override.dtstart.ms + duration
          occurrences.push(toOccurrence(override, override.dtstart.ms, ovEnd))
        } else {
          occurrences.push(toOccurrence(master, occStart, occStart + duration))
        }
      }
      // An edited instance moved INTO the window from outside it won't be
      // in startMsList (that list is keyed on the master's original
      // schedule), so surface it separately by its own new time.
      for (var ridKey in overrideMap) {
        if (seenOverrideKeys[ridKey]) continue
        var ov = overrideMap[ridKey]
        var ovStart = ov.dtstart.ms
        var ovEndB = ov.dtend ? ov.dtend.ms : ovStart + duration
        if (ovEndB >= nowMs && ovStart <= windowEndMs) occurrences.push(toOccurrence(ov, ovStart, ovEndB))
      }
    } else {
      var singleEnd = master.dtend != null ? master.dtend.ms : master.dtstart.ms
      if (singleEnd >= nowMs && master.dtstart.ms <= windowEndMs) {
        occurrences.push(toOccurrence(master, master.dtstart.ms, singleEnd))
      }
    }
  }

  occurrences.sort(function(a, b) { return a.startMs - b.startMs })
  if (maxEvents && occurrences.length > maxEvents) occurrences = occurrences.slice(0, maxEvents)
  return occurrences
}

// ---- Display formatting ---------------------------------------------------

function formatClock(ms) {
  var d = new Date(ms)
  var hours = d.getHours()
  var minutes = d.getMinutes()
  var suffix = hours >= 12 ? "PM" : "AM"
  var h12 = hours % 12
  if (h12 === 0) h12 = 12
  return h12 + ":" + (minutes < 10 ? "0" : "") + minutes + " " + suffix
}

function formatEventTime(occ) {
  if (occ.allDay) return "All day"
  return formatClock(occ.startMs) + " – " + formatClock(occ.endMs)
}

// Calendar-day difference (toMs's day minus fromMs's day), independent of
// the actual hour/minute — "23:59 today" to "00:01 tomorrow" is 1, not 0.
function daysBetween(fromMs, toMs) {
  var from = new Date(fromMs)
  var to = new Date(toMs)
  var fromStart = new Date(from.getFullYear(), from.getMonth(), from.getDate()).getTime()
  var toStart = new Date(to.getFullYear(), to.getMonth(), to.getDate()).getTime()
  return Math.round((toStart - fromStart) / (24 * 3600 * 1000))
}

function dayLabel(ms, nowMs) {
  var target = new Date(ms)
  var diffDays = daysBetween(nowMs, ms)
  if (diffDays === 0) return "Today"
  if (diffDays === 1) return "Tomorrow"
  var weekday = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][target.getDay()]
  if (diffDays > 1 && diffDays < 7) return weekday
  var month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][target.getMonth()]
  return weekday + ", " + month + " " + target.getDate()
}

// Groups a sorted occurrence list into [{ label, events: [...] }, ...],
// preserving input order (already chronological from buildAgenda).
function groupByDay(occurrences, nowMs) {
  var groups = []
  var byLabel = {}
  for (var i = 0; i < occurrences.length; i++) {
    var occ = occurrences[i]
    var label = dayLabel(occ.startMs, nowMs)
    if (!byLabel[label]) {
      byLabel[label] = { label: label, events: [] }
      groups.push(byLabel[label])
    }
    byLabel[label].events.push(occ)
  }
  return groups
}

// Bar pill tiers, quietest to loudest, so the pill doesn't stay "loud" all
// day for something hours out:
//   - not today                      -> icon only
//   - today, but not imminent        -> icon + bare start time
//   - starting within the hour       -> icon + title + countdown
//   - ongoing                        -> icon + title + "now"
// Full detail is always one hover (tooltip) or click (agenda) away, so
// nothing is actually lost by keeping the pill quiet most of the day. The
// title itself is never character-truncated here — MarqueeText.qml caps
// the rendered width and reveals the rest on hover instead, so a long
// title isn't permanently cut down to a fixed character count.
function formatBarLabel(nextEvent, nowMs) {
  if (!nextEvent) return CALENDAR_GLYPH

  var ongoing = nextEvent.startMs <= nowMs && nextEvent.endMs > nowMs
  if (ongoing) return CALENDAR_GLYPH + " " + nextEvent.summary + " · now"

  var minutesUntil = Math.round((nextEvent.startMs - nowMs) / 60000)
  if (minutesUntil <= 60) {
    var rel = minutesUntil < 1 ? "now" : "in " + minutesUntil + "m"
    return CALENDAR_GLYPH + " " + nextEvent.summary + " " + rel
  }

  if (daysBetween(nowMs, nextEvent.startMs) === 0) return CALENDAR_GLYPH + " " + formatClock(nextEvent.startMs)

  return CALENDAR_GLYPH
}

// Client-side sanity check before saving, so obviously-wrong pastes (the
// public sharing link, a random URL, empty input) get caught before ever
// shelling out to curl. Not exhaustive — the real validation is the first
// fetch actually succeeding.
function validateFeedUrl(text) {
  var v = String(text || "").trim()
  if (v === "") return "Paste your calendar's secret iCal address first."
  if (!/^https:\/\//i.test(v)) return "That doesn't look like a URL — it should start with https://."
  if (!/^https:\/\/calendar\.google\.com\/calendar\/ical\//i.test(v)) {
    return "That's not a Google Calendar iCal link. Copy the “Secret address in iCal format” from Settings → Integrate calendar."
  }
  if (/^https:\/\/calendar\.google\.com\/calendar\/ical\/[^/]+\/public\//i.test(v)) {
    return "That's the Public address — it only works if the calendar is public. Use the Secret address instead, just above it."
  }
  if (!/^https:\/\/calendar\.google\.com\/calendar\/ical\/[^/]+\/private-/i.test(v)) {
    return "That doesn't look like the Secret address — it should contain “private-” in the path."
  }
  if (!/\.ics$/i.test(v)) return "The link should end in .ics — check you copied the whole address."
  return ""
}

if (typeof module !== "undefined") {
  module.exports = {
    unfoldIcs: unfoldIcs,
    parseContentLine: parseContentLine,
    unescapeText: unescapeText,
    splitVevents: splitVevents,
    parseIcsDateTime: parseIcsDateTime,
    parseByDayToken: parseByDayToken,
    parseRRule: parseRRule,
    nthWeekdayOfMonth: nthWeekdayOfMonth,
    expandRecurrence: expandRecurrence,
    parseVeventBlock: parseVeventBlock,
    extractMeetingUrl: extractMeetingUrl,
    buildAgenda: buildAgenda,
    formatClock: formatClock,
    formatEventTime: formatEventTime,
    daysBetween: daysBetween,
    dayLabel: dayLabel,
    groupByDay: groupByDay,
    formatBarLabel: formatBarLabel,
    validateFeedUrl: validateFeedUrl,
    CALENDAR_GLYPH: CALENDAR_GLYPH
  }
}
