// swift-tools-version: 5.9
import PackageDescription

// SPM manifest for projects generated with `npx cap add ios --packagemanager SPM`.
// The default CocoaPods flow uses OrZip.podspec instead; both declare the same
// single source target and the same ZIPFoundation dependency.
let package = Package(
    name: "OrZip",
    platforms: [.iOS(.v15)],
    products: [
        .library(
            name: "OrZip",
            targets: ["OrZipPlugin"])
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", from: "8.0.0"),
        .package(url: "https://github.com/weichsel/ZIPFoundation.git", from: "0.9.19")
    ],
    targets: [
        .target(
            name: "OrZipPlugin",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm"),
                .product(name: "ZIPFoundation", package: "ZIPFoundation")
            ],
            path: "ios/Sources/OrZipPlugin")
    ]
)
