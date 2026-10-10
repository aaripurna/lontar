// swift-tools-version:5.3

import PackageDescription

let package = Package(
  name: "tauri-plugin-library",
  platforms: [
    .iOS(.v14)
  ],
  products: [
    .library(
      name: "tauri-plugin-library",
      type: .static,
      targets: ["tauri-plugin-library"])
  ],
  dependencies: [
    .package(name: "Tauri", path: "../.tauri/tauri-api")
  ],
  targets: [
    .target(
      name: "tauri-plugin-library",
      dependencies: [
        .byName(name: "Tauri")
      ],
      path: "Sources")
  ]
)
