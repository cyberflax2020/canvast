// ============================================================================
// Canvast — Render macOS App Icon / Canvast source file
// ============================================================================
// @file        scripts/render-macos-app-icon.swift
// @brief       Render the canonical Canvast SVG into a standard iconset.
// @description Part of the Canvast product codebase. Keep provenance and
//              license headers explicit for commercial redistribution.
// @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
// ============================================================================
import AppKit
import Foundation

struct IconRepresentation {
    let filename: String
    let pixels: Int
}

let representations = [
    IconRepresentation(filename: "icon_16x16.png", pixels: 16),
    IconRepresentation(filename: "icon_16x16@2x.png", pixels: 32),
    IconRepresentation(filename: "icon_32x32.png", pixels: 32),
    IconRepresentation(filename: "icon_32x32@2x.png", pixels: 64),
    IconRepresentation(filename: "icon_128x128.png", pixels: 128),
    IconRepresentation(filename: "icon_128x128@2x.png", pixels: 256),
    IconRepresentation(filename: "icon_256x256.png", pixels: 256),
    IconRepresentation(filename: "icon_256x256@2x.png", pixels: 512),
    IconRepresentation(filename: "icon_512x512.png", pixels: 512),
    IconRepresentation(filename: "icon_512x512@2x.png", pixels: 1024),
]

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data("render-macos-app-icon: \(message)\n".utf8))
    exit(1)
}

guard CommandLine.arguments.count == 3 else {
    fail("expected SOURCE.svg OUTPUT.iconset")
}
let source = CommandLine.arguments[1]
let destination = CommandLine.arguments[2]
guard let image = NSImage(contentsOfFile: source), image.isValid else {
    fail("canonical SVG cannot be decoded by AppKit")
}

do {
    try FileManager.default.createDirectory(
        atPath: destination,
        withIntermediateDirectories: false,
        attributes: nil
    )
    for representation in representations {
        guard let bitmap = NSBitmapImageRep(
            bitmapDataPlanes: nil,
            pixelsWide: representation.pixels,
            pixelsHigh: representation.pixels,
            bitsPerSample: 8,
            samplesPerPixel: 4,
            hasAlpha: true,
            isPlanar: false,
            colorSpaceName: .deviceRGB,
            bytesPerRow: 0,
            bitsPerPixel: 0
        ) else {
            fail("cannot allocate \(representation.filename)")
        }
        bitmap.size = NSSize(width: representation.pixels, height: representation.pixels)
        NSGraphicsContext.saveGraphicsState()
        guard let context = NSGraphicsContext(bitmapImageRep: bitmap) else {
            fail("cannot create graphics context for \(representation.filename)")
        }
        NSGraphicsContext.current = context
        context.imageInterpolation = .high
        NSColor.clear.setFill()
        NSRect(x: 0, y: 0, width: representation.pixels, height: representation.pixels).fill()
        image.draw(
            in: NSRect(x: 0, y: 0, width: representation.pixels, height: representation.pixels),
            from: .zero,
            operation: .copy,
            fraction: 1
        )
        context.flushGraphics()
        NSGraphicsContext.restoreGraphicsState()
        guard let png = bitmap.representation(using: .png, properties: [:]) else {
            fail("cannot encode \(representation.filename)")
        }
        try png.write(
            to: URL(fileURLWithPath: destination).appendingPathComponent(representation.filename),
            options: .atomic
        )
    }
} catch {
    fail(error.localizedDescription)
}
