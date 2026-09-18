// ============================================================================
// Canvast — Resource Bundle Probe / Canvast 源文件
// ============================================================================
// @file        macos-app/Config/ResourceBundleProbe.swift
// @brief       Load the packaged logo through Foundation and AppKit.
// @description 通过 Foundation 与 AppKit 无窗口加载打包后的品牌资源。
// @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
// ============================================================================
import AppKit
import Darwin
import Foundation

@main
struct CanvastResourceProbe {
  static func main() {
    let bundleURL = executableURL()
      .deletingLastPathComponent()
      .deletingLastPathComponent()
      .appendingPathComponent("Resources/CanvastMacApp_CanvastApp.bundle", isDirectory: true)
    guard let bundle = Bundle(url: bundleURL) else {
      FileHandle.standardError.write(Data("resource probe: packaged resource bundle is unavailable\n".utf8))
      exit(65)
    }
    guard let logoURL = bundle.url(forResource: "CanvastLogo", withExtension: "svg") else {
      FileHandle.standardError.write(Data("resource probe: CanvastLogo.svg is not discoverable\n".utf8))
      exit(66)
    }
    guard let image = NSImage(contentsOf: logoURL), image.isValid else {
      FileHandle.standardError.write(Data("resource probe: CanvastLogo.svg cannot be decoded by AppKit\n".utf8))
      exit(67)
    }
    print("Resource load: CanvastLogo.svg (\(image.size.width)x\(image.size.height)) from \(bundle.bundlePath)")
  }

  private static func executableURL() -> URL {
    var capacity: UInt32 = 0
    guard _NSGetExecutablePath(nil, &capacity) != 0, capacity > 0 else {
      FileHandle.standardError.write(Data("resource probe: executable path is unavailable\n".utf8))
      exit(71)
    }
    var buffer = [CChar](repeating: 0, count: Int(capacity))
    guard buffer.withUnsafeMutableBufferPointer({
      _NSGetExecutablePath($0.baseAddress, &capacity)
    }) == 0 else {
      FileHandle.standardError.write(Data("resource probe: executable path is unavailable\n".utf8))
      exit(71)
    }
    return URL(fileURLWithPath: String(cString: buffer)).resolvingSymlinksInPath()
  }
}
