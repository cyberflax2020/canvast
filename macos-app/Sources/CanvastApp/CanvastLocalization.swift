import Foundation
import SwiftUI
import CanvastAppCore

private struct CanvastLocalizerKey: EnvironmentKey {
  static let defaultValue = CanvastLocalizationRuntime.localizer
}

extension EnvironmentValues {
  var canvastLocalizer: CanvastLocalizer {
    get { self[CanvastLocalizerKey.self] }
    set { self[CanvastLocalizerKey.self] = newValue }
  }
}

extension View {
  func canvastLocalizer(_ localizer: CanvastLocalizer) -> some View {
    environment(\.canvastLocalizer, localizer)
      .environment(\.locale, localizer.locale)
  }
}
