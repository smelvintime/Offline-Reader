import Foundation
import Capacitor

// The SPM package's PRODUCT is `onnxruntime`, but its TARGET — and therefore
// the Swift module — is `OnnxRuntimeBindings`. Guessing at the product name got
// four `Cannot find type 'ORTEnv' in scope` errors and no clue why: an
// unmatched `#if canImport` compiles to nothing at all, so the import silently
// vanished and every ORT type went undefined with no mention of a missing
// module. The `#else` is the point of this block. A build that cannot find
// ONNX Runtime now says so, in those words, instead of failing somewhere else.
#if canImport(OnnxRuntimeBindings)
import OnnxRuntimeBindings          // SPM: microsoft/onnxruntime-swift-package-manager
#elseif canImport(onnxruntime_objc)
import onnxruntime_objc             // CocoaPods: onnxruntime-objc
#else
#error("ONNX Runtime is not linked. SPM: add the onnxruntime-swift-package-manager dependency (module OnnxRuntimeBindings). CocoaPods: pod 'onnxruntime-objc'. Then `npm install && npm run sync`.")
#endif

/// Runs Kokoro's forward pass natively, so the voice the reader likes can keep
/// up with them.
///
/// The first problem was *where* the model ran: WebAssembly, single-threaded,
/// inside a WebView sandbox. Apple's own voices are the same class of thing
/// executed as native ARM code, which is most of why they sound effortless and
/// ours did not. ONNX Runtime rather than a hand-converted Core ML model,
/// because coremltools no longer converts ONNX directly and the PyTorch round
/// trip is several chances for the voice to come out subtly wrong.
///
/// The second problem was *which* weights. This originally loaded the same
/// `model_quantized.onnx` as the web build, on the reasoning that a smaller
/// model is a faster one. That is true of a download and false of this graph.
/// q8 here is dynamic quantisation: it rewrites the matmuls to int8 and wraps
/// them in DynamicQuantizeLinear/DequantizeLinear, leaves Kokoro's convolutions
/// and its iSTFT decoder's LSTMs in float, and so pays conversion at every
/// boundary between the two. It exists to make an 88 MB download instead of a
/// 326 MB one, which is the right trade in a browser and the wrong one in an
/// app bundle that ships the file anyway. `bundledWeights` therefore prefers
/// fp32 and falls back, so an existing build keeps working unchanged and
/// re-running fetch-voice-model.mjs is what upgrades it.
///
/// The surface is deliberately tiny. Phonemisation, tokenisation, voice style
/// vectors and the sentence queue all stay in JavaScript exactly as they are;
/// `js/novel-voice-worker.js` swaps the engine's `model` property for a call to
/// this plugin. Only the tensor maths crosses the bridge.
@objc(OrKokoroPlugin)
public class OrKokoroPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "OrKokoroPlugin"
    public let jsName = "OrKokoro"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "available", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "infer", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "release", returnType: CAPPluginReturnPromise)
    ]

    /// Inference blocks for seconds at a time. Never on the main thread: the
    /// reader has to stay scrollable while the next paragraph renders.
    private let queue = DispatchQueue(label: "com.offlinereader.orkokoro", qos: .userInitiated)

    private var env: ORTEnv?
    private var session: ORTSession?
    private var provider = "cpu"
    private var weightsName = ""

    private struct Weights {
        let path: String
        let name: String
        let quantized: Bool
    }

    /// Which weights this build actually has, where scripts/sync-www.sh +
    /// `cap sync` leave them.
    ///
    /// Fastest first, not smallest first. A build that only ran
    /// fetch-voice-model.mjs with its old default still finds q8 at the bottom
    /// of the list and runs exactly as it did before — the upgrade is a
    /// re-fetch, never a broken build.
    private var bundledWeights: Weights? {
        guard let root = Bundle.main.resourceURL else { return nil }
        let dir = root
            .appendingPathComponent("public/vendor/tts/models")
            .appendingPathComponent("onnx-community/Kokoro-82M-v1.0-ONNX")
            .appendingPathComponent("onnx")
        let candidates: [(file: String, name: String, quantized: Bool)] = [
            ("model.onnx", "fp32", false),
            ("model_fp16.onnx", "fp16", false),
            ("model_quantized.onnx", "q8", true)
        ]
        for c in candidates {
            let path = dir.appendingPathComponent(c.file).path
            if FileManager.default.fileExists(atPath: path) {
                return Weights(path: path, name: c.name, quantized: c.quantized)
            }
        }
        return nil
    }

    /// Reports whether this build can actually do the work, not merely whether
    /// the plugin is installed. A build that skipped fetch-voice-model.mjs has
    /// the plugin and no weights, and that is a different problem with a
    /// different fix — so it is a different answer.
    @objc func available(_ call: CAPPluginCall) {
        let weights = bundledWeights
        call.resolve([
            "available": weights != nil,
            "provider": provider,
            "weights": weightsName.isEmpty ? (weights?.name ?? "") : weightsName,
            "loaded": session != nil
        ])
    }

    @objc func release(_ call: CAPPluginCall) {
        queue.async {
            self.session = nil
            self.env = nil
            call.resolve()
        }
    }

    /// One forward pass: phoneme ids + a 256-float style vector + speed, in;
    /// 16-bit PCM, out.
    ///
    /// Int16 rather than float32 on the way back because the app encodes a
    /// 16-bit WAV from this anyway — sending floats would double the bridge
    /// traffic to be truncated at the other end. A long paragraph is a megabyte
    /// either way, and halving it is free.
    @objc func infer(_ call: CAPPluginCall) {
        guard let rawIds = call.getArray("ids") as? [NSNumber], !rawIds.isEmpty else {
            call.reject("infer: ids must be a non-empty array of phoneme token ids")
            return
        }
        guard let rawStyle = call.getArray("style") as? [NSNumber], !rawStyle.isEmpty else {
            call.reject("infer: style must be the 256-float voice vector")
            return
        }
        let speed = Float(call.getDouble("speed") ?? 1.0)

        queue.async {
            do {
                let session = try self.ensureSession()
                let started = Date()

                var ids = rawIds.map { Int64(truncating: $0) }
                var style = rawStyle.map { Float(truncating: $0) }
                var speeds = [speed]

                let idsValue = try ORTValue(
                    tensorData: NSMutableData(bytes: &ids, length: ids.count * MemoryLayout<Int64>.size),
                    elementType: .int64,
                    shape: [1, NSNumber(value: ids.count)])
                let styleValue = try ORTValue(
                    tensorData: NSMutableData(bytes: &style, length: style.count * MemoryLayout<Float>.size),
                    elementType: .float,
                    shape: [1, NSNumber(value: style.count)])
                let speedValue = try ORTValue(
                    tensorData: NSMutableData(bytes: &speeds, length: MemoryLayout<Float>.size),
                    elementType: .float,
                    shape: [1])

                let outputName = try self.waveformOutputName(session)
                let outputs = try session.run(
                    withInputs: ["input_ids": idsValue, "style": styleValue, "speed": speedValue],
                    outputNames: Set([outputName]),
                    runOptions: nil)

                guard let waveform = outputs[outputName] else {
                    call.reject("infer: the model produced no \(outputName)")
                    return
                }
                let data = try waveform.tensorData() as Data
                let pcm = Self.floatBytesToInt16Base64(data)

                call.resolve([
                    "pcm": pcm,
                    "sampleRate": 24000,
                    "provider": self.provider,
                    "weights": self.weightsName,
                    "ms": Int(Date().timeIntervalSince(started) * 1000)
                ])
            } catch {
                call.reject("infer: \(error.localizedDescription)")
            }
        }
    }

    // MARK: - Session

    private func ensureSession() throws -> ORTSession {
        if let session = session { return session }
        guard let weights = bundledWeights else {
            throw NSError(domain: "OrKokoro", code: 1, userInfo: [
                NSLocalizedDescriptionKey:
                    "the weights are not in this build — run scripts/fetch-voice-model.mjs, then npm run sync"
            ])
        }
        weightsName = weights.name

        let env = try ORTEnv(loggingLevel: ORTLoggingLevel.warning)
        let options = try ORTSessionOptions()

        // Not setting this leaves the graph unfused. Kokoro is full of the
        // patterns the extended passes collapse, and it costs nothing at run
        // time — the work happens once, while the session is being built.
        try? options.setGraphOptimizationLevel(ORTGraphOptimizationLevel.all)

        // Left unset, a session can end up running the forward pass on one
        // core, which is what a ratio barely above realtime looks like from the
        // outside. Half the logical cores, because the other half are Apple's
        // efficiency cores: handing them matmuls makes the fast cores wait on
        // the slow ones at every join, so counting them in makes this slower,
        // not faster.
        let threads = max(2, ProcessInfo.processInfo.activeProcessorCount / 2)
        try? options.setIntraOpNumThreads(Int32(threads))

        // No Core ML execution provider, deliberately.
        //
        // This used to append one unconditionally, on the assumption that a
        // provider which can decline is free to offer. It is not, for two
        // reasons that both apply here. On the quantised graph Core ML cannot
        // run int8 nodes at all, so it claims a few float islands and the
        // partition boundaries cost more than the islands save. On any graph it
        // specialises per input shape — and every group is a different number
        // of phoneme tokens, so a chapter is a fresh compile per sentence,
        // which is the opposite of the problem being solved.
        //
        // Restoring it is three lines (appendCoreMLExecutionProvider before the
        // session is built); what would justify them is a measurement, and the
        // engine line prints the one to beat. Meanwhile "cpu" here is native
        // ARM with NEON across the performance cores, which is the gap that
        // mattered against single-threaded wasm.
        //
        // Assigned, never appended: release() can drop the session and a later
        // infer() rebuilds it, and appending would report "cpu ×3 ×3".
        provider = "cpu ×\(threads)"

        let session = try ORTSession(env: env, modelPath: weights.path, sessionOptions: options)
        self.env = env
        self.session = session
        return session
    }

    /// Kokoro's output is `waveform`, but a re-export could name it anything,
    /// and "the model produced no waveform" is a far better failure than a
    /// silent empty clip.
    private func waveformOutputName(_ session: ORTSession) throws -> String {
        let names: [String] = try session.outputNames()
        if names.contains("waveform") { return "waveform" }
        guard let first = names.first else {
            throw NSError(domain: "OrKokoro", code: 2, userInfo: [
                NSLocalizedDescriptionKey: "the model declares no outputs"
            ])
        }
        return first
    }

    // MARK: - PCM

    /// Float32 samples in [-1, 1] → little-endian Int16 → base64.
    static func floatBytesToInt16Base64(_ data: Data) -> String {
        let count = data.count / MemoryLayout<Float>.size
        var out = Data(capacity: count * 2)
        data.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
            let floats = raw.bindMemory(to: Float.self)
            for i in 0..<count {
                let clamped = max(-1.0, min(1.0, floats[i]))
                // Rounded, not truncated. Int16(x) truncates toward zero, which
                // biases every sample by up to half a step in the same
                // direction — a systematic pull toward silence rather than the
                // symmetric error quantisation is supposed to be.
                var sample = Int16((clamped * 32767.0).rounded())
                withUnsafeBytes(of: &sample) { out.append(contentsOf: $0) }
            }
        }
        return out.base64EncodedString()
    }
}
