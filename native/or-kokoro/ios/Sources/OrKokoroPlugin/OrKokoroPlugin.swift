import Foundation
import Capacitor

#if canImport(onnxruntime_objc)
import onnxruntime_objc
#elseif canImport(onnxruntime)
import onnxruntime
#endif

/// Runs Kokoro's forward pass natively, so the voice the reader likes can keep
/// up with them.
///
/// The model was never the problem. Kokoro-82M at q8 is 88 MB and already sits
/// in the app bundle; making it bigger would make it slower, not faster. What
/// was slow is *where* it ran: WebAssembly, single-threaded, inside a WebView
/// sandbox. Apple's own voices are the same class of thing executed as native
/// ARM code, which is most of why they sound effortless and ours did not.
///
/// So this changes the execution path and nothing else. Same weights, same
/// voices, same `model_quantized.onnx` the web build loads — ONNX Runtime
/// rather than a hand-converted Core ML model, because coremltools no longer
/// converts ONNX directly and the PyTorch round trip is several chances for the
/// voice to come out subtly wrong.
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

    /// Where scripts/sync-www.sh + `cap sync` leave the weights.
    private var bundledModelPath: String? {
        guard let root = Bundle.main.resourceURL else { return nil }
        let path = root
            .appendingPathComponent("public/vendor/tts/models")
            .appendingPathComponent("onnx-community/Kokoro-82M-v1.0-ONNX")
            .appendingPathComponent("onnx/model_quantized.onnx")
            .path
        return FileManager.default.fileExists(atPath: path) ? path : nil
    }

    /// Reports whether this build can actually do the work, not merely whether
    /// the plugin is installed. A build that skipped fetch-voice-model.mjs has
    /// the plugin and no weights, and that is a different problem with a
    /// different fix — so it is a different answer.
    @objc func available(_ call: CAPPluginCall) {
        call.resolve([
            "available": bundledModelPath != nil,
            "provider": provider,
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
                    outputNames: [outputName],
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
        guard let path = bundledModelPath else {
            throw NSError(domain: "OrKokoro", code: 1, userInfo: [
                NSLocalizedDescriptionKey:
                    "the weights are not in this build — run scripts/fetch-voice-model.mjs, then npm run sync"
            ])
        }
        let env = try ORTEnv(loggingLevel: ORTLoggingLevel.warning)
        let options = try ORTSessionOptions()

        // Core ML where it will take the graph, CPU where it will not. A
        // quantised model often falls back, and that is fine: native ARM with
        // NEON is already a different universe from single-threaded wasm, which
        // is the gap that made this voice unusable. Reported either way so the
        // engine line can say which one actually ran.
        do {
            try options.appendCoreMLExecutionProvider(with: ORTCoreMLExecutionProviderOptions())
            provider = "coreml"
        } catch {
            provider = "cpu"
        }

        let session = try ORTSession(env: env, modelPath: path, sessionOptions: options)
        self.env = env
        self.session = session
        return session
    }

    /// Kokoro's output is `waveform`, but a re-export could name it anything,
    /// and "the model produced no waveform" is a far better failure than a
    /// silent empty clip.
    private func waveformOutputName(_ session: ORTSession) throws -> String {
        let names = try session.outputNames()
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
