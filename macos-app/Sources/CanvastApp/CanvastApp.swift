import SwiftUI
import AppKit
import CanvastAppCore

final class CanvastAppDelegate: NSObject, NSApplicationDelegate {
  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
    true
  }
}

@main
struct CanvastDesktopApp: App {
  @NSApplicationDelegateAdaptor(CanvastAppDelegate.self) private var appDelegate
  @StateObject private var model: CanvastDesktopModel

  init() {
    do {
      try CanvastAppBootstrap.prepare(arguments: CommandLine.arguments)
    } catch {
      FileHandle.standardError.write(Data("Canvast app bootstrap failed: \(error)\n".utf8))
      Foundation.exit(EXIT_FAILURE)
    }
    let credentialStore: any CanvastCredentialStore = CanvastKeychainCredentialStore()
    _model = StateObject(wrappedValue: CanvastDesktopModel(credentialStore: credentialStore))
  }

  var body: some Scene {
    WindowGroup {
      CanvastWorkbenchView()
        .environmentObject(model)
        .canvastLocalizer(model.localizer)
        .frame(minWidth: 960, minHeight: 680)
    }
    .commands {
      CommandMenu(model.localizer.text("Canvast", "Canvast")) {
        Button(model.localizer.text("Refresh Workspace", "刷新工作区")) { model.refresh() }
          .keyboardShortcut("r", modifiers: [.command])
          .disabled(!model.workspaceIsConfigured || model.isActionLocked(.refreshWorkspace))
        Button(model.displayedRuntimeMode == .enhanced
          ? model.localizer.text("Switch To Standard", "切换为标准模式")
          : model.localizer.text("Switch To Enhanced", "切换为增强模式")
        ) {
          model.toggleMode()
        }
        .keyboardShortcut("e", modifiers: [.command, .shift])
        .disabled(!model.workspaceIsConfigured || model.isActionLocked(.setRuntimeMode))
        Divider()
        Button(model.localizer.text("Run", "运行")) { model.startRun() }
          .keyboardShortcut(.return, modifiers: [.command])
          .disabled(!model.canStartRun)
        Button(model.localizer.text("Stop Run", "停止运行")) { model.stopRun() }
          .keyboardShortcut(".", modifiers: [.command])
          .disabled(!model.canStopRun)
      }
    }

    Settings {
      CanvastSettingsView()
        .environmentObject(model)
        .canvastLocalizer(model.localizer)
    }
  }
}
