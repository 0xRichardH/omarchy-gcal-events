import QtQuick
import Quickshell
import qs.Commons
import qs.Ui

// Bar pill: next upcoming Google Calendar event, ticking countdown. Hosts
// the agenda popup (Panel.qml) the same way clock/weather do — this file
// owns only the bar label and the shape contract the bar host needs
// (open/close/opened/popoutSwitchClosing), everything else lives in the
// panel.
//
// Left click toggles the agenda (or the setup form, if no feed is
// configured yet). Middle click forces a refetch. Right click opens
// Google Calendar in the browser.
BarWidget {
  id: root
  moduleName: "0xrichardh.gcal-events"

  function refresh() {
    if (panelLoader.item && panelLoader.item.refresh) panelLoader.item.refresh()
  }

  function injectPanel() {
    var target = panelLoader.item
    if (!target) return
    if ("bar" in target) target.bar = root.bar
    if ("settings" in target) target.settings = root.settings
    if ("anchorItem" in target) target.anchorItem = button
    if ("hostWidget" in target) target.hostWidget = root
  }

  function togglePanel() {
    if (panelLoader.item && panelLoader.item.toggle) panelLoader.item.toggle()
  }

  // Shape contract for shell.summon/hide/toggle routing (Bar.findPanelWidget
  // requires open/close/opened on the bar-widget root).
  readonly property bool opened: panelLoader.item ? panelLoader.item.opened === true : false

  function open() {
    if (panelLoader.item && panelLoader.item.open) panelLoader.item.open()
  }

  function close() {
    if (panelLoader.item && panelLoader.item.close) panelLoader.item.close()
  }

  readonly property bool popoutSwitchClosing: panelLoader.item ? panelLoader.item.popoutSwitchClosing === true : false

  function closeForPopoutSwitch() {
    if (panelLoader.item) panelLoader.item.closeForPopoutSwitch()
  }

  readonly property string label: panelLoader.item ? panelLoader.item.label : ""

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  onBarChanged: injectPanel()
  onSettingsChanged: injectPanel()

  Loader {
    id: panelLoader
    active: true
    source: Qt.resolvedUrl("Panel.qml")
    visible: false
    onLoaded: {
      root.injectPanel()
      Qt.callLater(root.injectPanel)
    }
  }

  WidgetButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    // Text stays empty and rendering is handed to MarqueeText below: the
    // base label is unbounded (an imminent event's title can be long), and
    // WidgetButton would otherwise size the whole pill — and the bar slot
    // around it — to fit it in full. fixedWidth caps it instead.
    text: ""
    hasVisualContent: root.label !== ""
    tooltipText: panelLoader.item ? panelLoader.item.tooltipText : ""
    active: panelLoader.item ? panelLoader.item.urgent === true : false
    horizontalMargin: 8.75
    verticalPadding: 8.75
    fixedWidth: marqueeLabel.implicitWidth + Style.spaceReal(horizontalMargin) * 2

    onPressed: function(b) {
      if (b === Qt.RightButton) Qt.openUrlExternally("https://calendar.google.com/")
      else if (b === Qt.MiddleButton) root.refresh()
      else root.togglePanel()
    }

    MarqueeText {
      id: marqueeLabel
      anchors.centerIn: parent
      text: root.label
      textColor: button.active && button.useActiveColor ? button.activeColor : button.foreground
      fontFamily: button.fontFamily
      fontPixelSize: button.fontSize
      capWidth: Style.space(170)
    }
  }
}
