// swift-tools-version: 5.9
import PackageDescription

// SPM manifest for projects generated with `npx cap add ios --packagemanager SPM`.
// The CocoaPods flow uses OrKokoro.podspec instead; both declare the same single
// source target and the same ONNX Runtime dependency.
//
// ONNX Runtime rather than a hand-converted Core ML model: coremltools no longer
// converts ONNX directly, so that route goes through PyTorch and a re-export,
// and every step is a chance for the voice to come out subtly wrong. ORT loads
// the exact model_quantized.onnx the web build already uses, and its Core ML
// execution provider hands over what it can. Same weights, same Michael, no
// conversion to get wrong.
let package = Package(
    name: "OrKokoro",
    platforms: [.iOS(.v15)],
    products: [
        .library(
            name: "OrKokoro",
            targets: ["OrKokoroPlugin"])
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", from: "8.0.0"),
        .package(url: "https://github.com/microsoft/onnxruntime-swift-package-manager.git", from: "1.20.0")
    ],
    targets: [
        .target(
            name: "OrKokoroPlugin",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm"),
                .product(name: "onnxruntime", package: "onnxruntime-swift-package-manager")
            ],
            path: "ios/Sources/OrKokoroPlugin")
    ]
)
