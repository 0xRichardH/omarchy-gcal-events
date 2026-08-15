import QtQuick

// Text that renders at its natural width, elided if it doesn't fit, and —
// only while hovered, and only if it's actually overflowing — scrolls left
// to reveal the rest, pauses, scrolls back, and loops for as long as the
// pointer stays over it. Resets instantly (no animated return) on exit.
//
// Two ways callers bound the rendered width, both handled by the same
// `overflowing: naturalWidth > width` check:
//   - external: a Row/layout assigns `width` explicitly (agenda rows).
//   - `capWidth`: nothing assigns `width`, so `implicitWidth` auto-sizes to
//     the text up to this cap (the bar pill, which otherwise has nothing
//     to constrain it and would grow the whole bar for a long title).
Item {
  id: root

  property string text: ""
  property color textColor: "white"
  property string fontFamily: ""
  property int fontPixelSize: 12
  property bool bold: false
  property real capWidth: 0

  readonly property real naturalWidth: label.implicitWidth
  readonly property bool overflowing: naturalWidth > root.width
  readonly property bool scrolling: hoverArea.containsMouse && overflowing
  readonly property real travel: Math.max(0, naturalWidth - root.width)

  implicitWidth: capWidth > 0 ? Math.min(capWidth, naturalWidth) : naturalWidth
  implicitHeight: label.implicitHeight
  clip: true

  Text {
    id: label
    property real offset: 0

    x: root.scrolling ? -offset : 0
    width: root.scrolling ? implicitWidth : root.width
    elide: (root.overflowing && !root.scrolling) ? Text.ElideRight : Text.ElideNone
    text: root.text
    color: root.textColor
    font.family: root.fontFamily
    font.pixelSize: root.fontPixelSize
    font.bold: root.bold

    SequentialAnimation {
      running: root.scrolling
      loops: Animation.Infinite

      PauseAnimation { duration: 500 }
      NumberAnimation {
        target: label; property: "offset"
        from: 0; to: root.travel
        duration: Math.max(400, root.travel * 18)
        easing.type: Easing.Linear
      }
      PauseAnimation { duration: 800 }
      NumberAnimation {
        target: label; property: "offset"
        from: root.travel; to: 0
        duration: Math.max(400, root.travel * 18)
        easing.type: Easing.Linear
      }
    }
  }

  MouseArea {
    id: hoverArea
    anchors.fill: parent
    hoverEnabled: true
    acceptedButtons: Qt.NoButton
  }
}
