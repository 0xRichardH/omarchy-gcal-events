import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui
import "Model.js" as Model

// Agenda popup + first-run/edit setup form for the Google Calendar Events
// plugin. BarWidget.qml owns the bar label and hands this panel the button
// to anchor against (see its injectPanel()).
//
// Data flow: feedUrlFile (FileView) reads the secret iCal URL from
// ~/.local/state/omarchy/plugins/<id>/feed-url.txt — kept out of
// shell.json deliberately, since it's a bearer secret, not a display
// preference. fetchProc curls that URL on open/refresh/timer and hands the
// raw ICS text to Model.buildAgenda(). Saving a new URL goes through
// bin/save-feed-url.sh over stdin (never argv) so the secret never shows
// up in `ps`.
Panel {
  id: root
  moduleName: "0xrichardh.gcal-events"
  ipcTarget: "0xrichardh.gcal-events"
  manageIpc: false

  property var anchorItem: null

  // The bar tracks the widget mounted in its slot — BarWidget.qml — not
  // this nested panel. See weather/clock's own Panel.qml for the same
  // shape contract this mirrors.
  property var hostWidget: null
  readonly property var barIdentity: hostWidget || root

  readonly property color contentForeground: bar ? bar.foreground : Color.foreground
  readonly property string contentFontFamily: bar ? bar.fontFamily : Style.font.family

  readonly property int refreshIntervalSec: Math.max(60, parseInt(setting("refreshIntervalSec", 300), 10) || 300)
  readonly property int lookaheadHours: Math.max(1, parseInt(setting("lookaheadHours", 72), 10) || 72)
  readonly property int maxEventsShown: Math.max(1, parseInt(setting("maxEventsShown", 6), 10) || 6)

  // Ticks the relative-time labels ("in 5m") and re-sorts urgency without
  // needing a fresh network fetch.
  property real nowMs: Date.now()
  Timer { interval: 30000; running: true; repeat: true; onTriggered: root.nowMs = Date.now() }

  Timer {
    interval: root.refreshIntervalSec * 1000
    running: true
    repeat: true
    onTriggered: root.fetchNow()
  }

  property string feedUrl: ""
  property bool editingFeedUrl: false
  property string pendingUrlInput: ""
  property string validationError: ""
  property string fetchError: ""
  property bool fetching: false
  property var events: []

  readonly property bool showSetupForm: root.feedUrl === "" || root.editingFeedUrl
  readonly property var nextEvent: events.length > 0 ? events[0] : null
  readonly property string label: Model.formatBarLabel(nextEvent, nowMs)
  readonly property bool urgent: !!nextEvent && nextEvent.startMs > nowMs && (nextEvent.startMs - nowMs) <= 5 * 60 * 1000
  readonly property string tooltipText: nextEvent
    ? (nextEvent.summary + " · " + Model.formatEventTime(nextEvent))
    : (root.feedUrl === "" ? "Click to set up Google Calendar" : "No upcoming events")
  readonly property var groupedEvents: Model.groupByDay(events, nowMs)

  readonly property string feedUrlPath: (Quickshell.env("HOME") || "") + "/.local/state/omarchy/plugins/" + root.moduleName + "/feed-url.txt"
  readonly property string helperScriptPath: String(Qt.resolvedUrl(".")).replace(/^file:\/\//, "") + "bin/save-feed-url.sh"

  function open() {
    root.controller.show()
    if (root.feedUrl !== "") Qt.callLater(root.fetchNow)
  }

  function close() {
    root.controller.hide()
  }

  function toggle() {
    if (root.opened) root.close()
    else root.open()
  }

  function switchPanel(direction) {
    if (root.bar && typeof root.bar.switchPanelFrom === "function")
      return root.bar.switchPanelFrom(root.barIdentity, direction)
    return false
  }

  function fetchNow() {
    if (root.feedUrl === "" || fetchProc.running) return
    root.fetching = true
    fetchProc.command = ["curl", "-fsS", "--max-time", "10", root.feedUrl]
    fetchProc.running = true
  }

  function startEditingFeedUrl() {
    root.pendingUrlInput = root.feedUrl
    root.validationError = ""
    root.editingFeedUrl = true
  }

  function cancelEditingFeedUrl() {
    if (root.feedUrl === "") return // nothing to fall back to on first run
    root.editingFeedUrl = false
    root.pendingUrlInput = ""
    root.validationError = ""
  }

  function requestSaveFeedUrl() {
    var error = Model.validateFeedUrl(root.pendingUrlInput)
    if (error !== "") { root.validationError = error; return }
    root.validationError = ""
    saveFeedUrlProc.pendingSecret = root.pendingUrlInput.trim()
    saveFeedUrlProc.command = ["bash", root.helperScriptPath, root.feedUrlPath]
    saveFeedUrlProc.running = true
  }

  property FileView feedUrlFile: FileView {
    path: root.feedUrlPath
    watchChanges: true
    printErrors: false
    onFileChanged: reload()
    onLoaded: {
      root.feedUrl = text().trim()
      Qt.callLater(root.fetchNow)
    }
    onLoadFailed: root.feedUrl = ""
  }

  Process {
    id: fetchProc
    stdout: StdioCollector {
      id: fetchStdout
      waitForEnd: true
      onStreamFinished: {
        root.fetching = false
        var raw = String(text || "").trim()
        if (!raw) {
          root.events = []
          root.fetchError = "Couldn't reach the calendar feed. Check your connection, or the secret link may have been reset."
          return
        }
        try {
          var windowEndMs = root.nowMs + root.lookaheadHours * 3600 * 1000
          root.events = Model.buildAgenda(raw, root.nowMs, windowEndMs, root.maxEventsShown)
          root.fetchError = ""
        } catch (e) {
          root.events = []
          root.fetchError = (e && e.code === "not-icalendar")
            ? "That link didn't return calendar data. Make sure you copied the secret iCal address, not a sharing link."
            : "Couldn't read the calendar feed (unexpected format)."
        }
      }
    }
  }

  Process {
    id: saveFeedUrlProc
    property string pendingSecret: ""
    stdinEnabled: true
    onStarted: {
      write(pendingSecret + "\n")
      pendingSecret = ""
    }
    onExited: function(exitCode) {
      if (exitCode !== 0) {
        root.validationError = "Couldn't save the link — try again."
        return
      }
      root.editingFeedUrl = false
      root.pendingUrlInput = ""
      root.feedUrlFile.reload()
    }
  }

  IpcHandler {
    target: root.ipcTarget
    function open(): void { root.open() }
    function close(): void { root.close() }
    function show(): void { root.open() }
    function hide(): void { root.close() }
    function toggle(): void { root.toggle() }
    function refresh(): void { root.fetchNow() }
  }

  KeyboardPanel {
    id: panel
    anchorItem: root.anchorItem
    owner: root.barIdentity
    bar: root.bar
    open: root.opened
    contentWidth: panel.fittedContentWidth(Style.space(340))
    contentHeight: panel.fittedContentHeight(agendaColumn.implicitHeight)

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      onCloseRequested: root.close()
      onTabRequested: function(direction) { root.switchPanel(direction) }

      Flickable {
        id: scroll
        anchors.fill: parent
        contentWidth: width
        contentHeight: agendaColumn.implicitHeight
        clip: true
        boundsBehavior: Flickable.StopAtBounds

        Column {
          id: agendaColumn
          width: scroll.width
          spacing: Style.space(12)

          Text {
            text: "Google Calendar"
            color: root.contentForeground
            font.family: root.contentFontFamily
            font.pixelSize: Style.font.body
            font.bold: true
          }

          // ---- Setup / edit-link form -----------------------------------
          Column {
            width: parent.width
            visible: root.showSetupForm
            spacing: Style.space(8)

            Text {
              width: parent.width
              wrapMode: Text.WordWrap
              text: root.feedUrl === ""
                ? "Paste your calendar's secret iCal address to get started."
                : "Update the calendar link."
              color: root.contentForeground
              font.family: root.contentFontFamily
              font.pixelSize: Style.font.bodySmall
            }

            Column {
              width: parent.width
              spacing: Style.space(4)
              Button {
                text: "Open Google Calendar settings ↗"
                foreground: root.contentForeground
                bordered: true
                onClicked: Qt.openUrlExternally("https://calendar.google.com/calendar/r/settings")
              }

              Text {
                width: parent.width
                wrapMode: Text.WordWrap
                text: "It opens straight to Integrate calendar. Pick the right calendar in the left sidebar if you have more than one, then copy the “Secret address in iCal format” (not the Public one)."
                color: Qt.darker(root.contentForeground, 1.4)
                font.family: root.contentFontFamily
                font.pixelSize: Style.font.bodySmall
              }

              Text {
                width: parent.width
                wrapMode: Text.WordWrap
                visible: root.feedUrl === ""
                text: "Treat this link like a password — anyone with it can read your calendar."
                color: Qt.darker(root.contentForeground, 1.4)
                font.family: root.contentFontFamily
                font.pixelSize: Style.font.bodySmall
                font.italic: true
              }
            }

            TextField {
              id: feedUrlField
              width: parent.width
              text: root.pendingUrlInput
              placeholderText: "https://calendar.google.com/calendar/ical/…/basic.ics"
              foreground: root.contentForeground
              font.family: root.contentFontFamily
              onTextChanged: root.pendingUrlInput = text
              Keys.onReturnPressed: root.requestSaveFeedUrl()
              Keys.onEnterPressed: root.requestSaveFeedUrl()
            }

            Text {
              width: parent.width
              wrapMode: Text.WordWrap
              visible: root.validationError !== ""
              text: root.validationError
              color: bar ? bar.urgent : Color.urgent
              font.family: root.contentFontFamily
              font.pixelSize: Style.font.bodySmall
            }

            Row {
              spacing: Style.space(8)

              Button {
                text: saveFeedUrlProc.running ? "Saving…" : "Save"
                foreground: root.contentForeground
                bordered: true
                enabled: !saveFeedUrlProc.running
                onClicked: root.requestSaveFeedUrl()
              }

              Button {
                text: "Cancel"
                foreground: root.contentForeground
                bordered: true
                visible: root.feedUrl !== ""
                onClicked: root.cancelEditingFeedUrl()
              }
            }
          }

          // ---- Agenda -----------------------------------------------------
          Column {
            width: parent.width
            visible: !root.showSetupForm
            spacing: Style.space(10)

            Row {
              width: parent.width
              spacing: Style.space(8)

              Button {
                text: root.fetching ? "Refreshing…" : "Refresh"
                foreground: root.contentForeground
                bordered: true
                enabled: !root.fetching
                onClicked: root.fetchNow()
              }

              Button {
                text: "Change link"
                foreground: root.contentForeground
                bordered: true
                onClicked: root.startEditingFeedUrl()
              }
            }

            Text {
              width: parent.width
              wrapMode: Text.WordWrap
              visible: root.fetchError !== ""
              text: root.fetchError
              color: bar ? bar.urgent : Color.urgent
              font.family: root.contentFontFamily
              font.pixelSize: Style.font.bodySmall
            }

            Text {
              width: parent.width
              visible: root.fetchError === "" && root.events.length === 0
              text: root.fetching ? "Loading…" : ("No events in the next " + root.lookaheadHours + "h.")
              color: Qt.darker(root.contentForeground, 1.4)
              font.family: root.contentFontFamily
              font.pixelSize: Style.font.bodySmall
            }

            Repeater {
              model: root.groupedEvents

              Column {
                required property var modelData
                width: agendaColumn.width
                spacing: Style.space(4)

                Text {
                  text: modelData.label
                  color: Qt.darker(root.contentForeground, 1.4)
                  font.family: root.contentFontFamily
                  font.pixelSize: Style.font.bodySmall
                  font.letterSpacing: 1
                }

                Repeater {
                  model: modelData.events

                  Row {
                    required property var modelData
                    width: parent.width
                    spacing: Style.space(8)

                    Rectangle {
                      id: statusDot
                      width: Style.space(6)
                      height: Style.space(6)
                      radius: width / 2
                      anchors.verticalCenter: parent.verticalCenter
                      color: (modelData.startMs <= root.nowMs && modelData.endMs > root.nowMs)
                        ? (bar ? bar.urgent : Color.urgent)
                        : Qt.darker(root.contentForeground, 1.6)
                    }

                    Text {
                      id: timeLabel
                      text: Model.formatEventTime(modelData)
                      color: Qt.darker(root.contentForeground, 1.2)
                      font.family: root.contentFontFamily
                      font.pixelSize: Style.font.bodySmall
                    }

                    Text {
                      // Sized off the dot's and time label's *actual* rendered
                      // width rather than a guessed constant — "5:30 PM – 6:00
                      // PM" doesn't reliably fit a fixed pixel budget across
                      // fonts/locales, and a stale guess overlaps the title.
                      width: parent.width - statusDot.width - timeLabel.width - parent.spacing * 2
                      elide: Text.ElideRight
                      text: modelData.summary
                      color: root.contentForeground
                      font.family: root.contentFontFamily
                      font.pixelSize: Style.font.bodySmall
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}
