// swift-tools-version: 5.9
import PackageDescription

// SPM manifest for projects generated with `npx cap add ios --packagemanager SPM`.
// The CocoaPods flow uses OrSpeech.podspec instead; both declare the same single
// source target. No third-party dependency: AVFoundation ships with the OS, which
// is the entire point of this path.
let package = Package(
    name: "OrSpeech",
    platforms: [.iOS(.v15)],
    products: [
        .library(
            name: "OrSpeech",
            targets: ["OrSpeechPlugin"])
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", from: "8.0.0")
    ],
    targets: [
        .target(
            name: "OrSpeechPlugin",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm")
            ],
            path: "ios/Sources/OrSpeechPlugin")
    ]
)
