import AppKit
import SwiftUI

enum CanvastBrandAsset {
  static func logoImage(in bundle: Bundle? = nil) -> NSImage? {
    if let bundle, let image = image(in: bundle) { return image }
    if let installed = installedResourceBundle(), let image = image(in: installed) {
      return image
    }
    if let executable = executableResourceBundle(), let image = image(in: executable) {
      return image
    }
    if let development = developmentResourceBundle(), let image = image(in: development) {
      return image
    }
    return nil
  }

  private static func image(in bundle: Bundle) -> NSImage? {
    let url = bundle.url(forResource: "CanvastLogo", withExtension: "svg")
      ?? bundle.url(
        forResource: "canvast-logo",
        withExtension: "svg",
        subdirectory: "Assets.xcassets/CanvastLogo.imageset"
      )
    return url.flatMap(NSImage.init(contentsOf:))
  }

  private static func installedResourceBundle() -> Bundle? {
    guard let resources = Bundle.main.resourceURL else { return nil }
    return bundle(at: resources.appendingPathComponent(resourceBundleName, isDirectory: true))
  }

  private static func executableResourceBundle() -> Bundle? {
    guard let executable = Bundle.main.executableURL else { return nil }
    return bundle(at: executable.deletingLastPathComponent().appendingPathComponent(resourceBundleName, isDirectory: true))
  }

  private static func developmentResourceBundle() -> Bundle? {
    guard let override = ProcessInfo.processInfo.environment["CANVAST_RESOURCE_BUNDLE_PATH"],
          !override.isEmpty else { return nil }
    return bundle(at: URL(fileURLWithPath: override, isDirectory: true))
  }

  private static func bundle(at url: URL) -> Bundle? {
    guard FileManager.default.fileExists(atPath: url.appendingPathComponent("CanvastLogo.svg").path) else {
      return nil
    }
    return Bundle(url: url)
  }

  private static let resourceBundleName = "CanvastMacApp_CanvastApp.bundle"
}

struct CanvastBrandLogo: View {
  var size: CGFloat = 42

  var body: some View {
    Group {
      if let logo = CanvastBrandAsset.logoImage() {
        Image(nsImage: logo)
          .resizable()
          .interpolation(.high)
      } else {
        Image(systemName: "point.3.connected.trianglepath.dotted")
          .resizable()
          .scaledToFit()
          .padding(size * 0.20)
          .foregroundStyle(.tint)
          .background(.tint.opacity(0.12))
      }
    }
    .frame(width: size, height: size)
    .clipShape(RoundedRectangle(cornerRadius: max(4, size * 0.21)))
    .accessibilityHidden(true)
  }
}
