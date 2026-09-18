// swift-tools-version: 5.9

import PackageDescription

let package = Package(
  name: "CanvastMacApp",
  platforms: [
    .macOS(.v13)
  ],
  products: [
    .library(name: "CanvastAppCore", targets: ["CanvastAppCore"]),
    .executable(name: "CanvastApp", targets: ["CanvastApp"])
  ],
  targets: [
    .target(name: "CanvastAppCore"),
    .executableTarget(
      name: "CanvastApp",
      dependencies: ["CanvastAppCore"]
    )
  ]
)
