import Foundation
import AVFoundation
import Capacitor

/// The iPhone's own narrator, with the voices that are actually worth hearing.
///
/// The app shipped a device voice once and it was removed for sounding like a
/// robot. It sounded like a robot because it was speaking through the *default*
/// voice: iOS ships a small "compact" voice in every language and uses it
/// unless asked otherwise. The Enhanced and Premium voices — the ones a reader
/// downloads under Settings → Accessibility → Spoken Content → Voices — are a
/// different class of thing entirely, and nothing in the old code ever asked
/// for one.
///
/// So this plugin's first job is to enumerate honestly: every installed voice,
/// with the quality tier iOS assigns it, so the picker can put the good ones at
/// the top and say plainly when only the compact one is installed.
///
/// Its second job is the thing no on-device model can match: it starts speaking
/// immediately. There is no inference, no 90 MB of weights, and no waiting
/// proportional to the length of the paragraph.
@objc(OrSpeechPlugin)
public class OrSpeechPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "OrSpeechPlugin"
    public let jsName = "OrSpeech"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "available", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "voices", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "speak", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pause", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "resume", returnType: CAPPluginReturnPromise)
    ]

    private let synthesizer = AVSpeechSynthesizer()
    private var delegate: SpeechDelegate?

    override public func load() {
        let d = SpeechDelegate(plugin: self)
        delegate = d
        synthesizer.delegate = d
    }

    @objc func available(_ call: CAPPluginCall) {
        call.resolve(["available": true])
    }

    /// Every installed voice, with its quality tier.
    ///
    /// `quality` is iOS's own judgement, not ours: "default" is the compact
    /// voice that made the old device narrator sound like one, "enhanced" and
    /// "premium" are the downloaded ones. The picker sorts on it, and the app
    /// can tell a reader when the only thing installed is the compact voice —
    /// which is a settings problem, not a bug, and is fixable in a minute.
    @objc func voices(_ call: CAPPluginCall) {
        let wanted = (call.getString("lang") ?? "en").lowercased()
        var out: [[String: Any]] = []
        for voice in AVSpeechSynthesisVoice.speechVoices() {
            let lang = voice.language.lowercased()
            if !wanted.isEmpty && !lang.hasPrefix(wanted) { continue }
            var quality = "default"
            switch voice.quality {
            case .enhanced: quality = "enhanced"
            case .premium: quality = "premium"
            default: quality = "default"
            }
            // Personal Voice needs its own authorisation and is a different
            // proposition from a downloaded voice; say so rather than mixing it in.
            var isPersonal = false
            if #available(iOS 17.0, *) {
                isPersonal = voice.voiceTraits.contains(.isPersonalVoice)
            }
            out.append([
                "id": voice.identifier,
                "name": voice.name,
                "lang": voice.language,
                "quality": quality,
                "personal": isPersonal
            ])
        }
        call.resolve(["voices": out])
    }

    /// Speaks one utterance and resolves when it FINISHES.
    ///
    /// The reader's queue depends on that: it advances a sentence when this
    /// promise settles, so resolving early would race the narration ahead of
    /// the audio. Cancellation resolves with spoken:false rather than
    /// rejecting, because being interrupted is an ordinary thing to happen to
    /// a sentence and not an error anyone needs to see.
    @objc func speak(_ call: CAPPluginCall) {
        let text = call.getString("text") ?? ""
        if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            call.resolve(["spoken": false])
            return
        }

        // Playback, not ambient: narration must survive the screen locking and
        // must not be silenced by the ringer switch. A reader on a train has
        // the phone in a pocket.
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playback, mode: .spokenAudio, options: [])
            try session.setActive(true, options: [])
        } catch {
            // A session we could not configure is still worth trying to speak
            // through; the failure surfaces as silence, not as a crash.
        }

        let utterance = AVSpeechUtterance(string: text)
        if let id = call.getString("voiceId"), !id.isEmpty,
           let voice = AVSpeechSynthesisVoice(identifier: id) {
            utterance.voice = voice
        } else if let lang = call.getString("lang"), !lang.isEmpty {
            utterance.voice = AVSpeechSynthesisVoice(language: lang)
        }

        // The app's rate is a multiplier around 1.0; AVSpeechUtterance's is an
        // absolute 0…1 where the default sits near 0.5. Scaling the default
        // rather than mapping the range keeps "1.0×" meaning "the voice's own
        // natural pace" on every device, which is what a reader expects.
        let multiplier = Float(call.getDouble("rate") ?? 1.0)
        let base = AVSpeechUtteranceDefaultSpeechRate
        utterance.rate = min(max(base * multiplier, AVSpeechUtteranceMinimumSpeechRate),
                             AVSpeechUtteranceMaximumSpeechRate)
        utterance.pitchMultiplier = Float(call.getDouble("pitch") ?? 1.0)
        utterance.postUtteranceDelay = call.getDouble("gap") ?? 0

        // Order matters. AVSpeechSynthesizer.speak() QUEUES rather than
        // replaces, so a second utterance arriving mid-sentence would leave two
        // in the queue behind a single tracked call. Stopping first empties the
        // queue and fires didCancel, which settles the previous call — and it
        // has to happen BEFORE the new call is recorded, or that cancellation
        // would settle the new one instead of the old.
        //
        // The reader never does this: it waits for each promise before asking
        // for the next sentence. This is for everything that is not the reader
        // — a preview tapped mid-playback, a double tap, a future caller.
        if synthesizer.isSpeaking || synthesizer.isPaused {
            synthesizer.stopSpeaking(at: .immediate)
        }
        call.keepAlive = true
        delegate?.begin(call: call, utterance: utterance)
        synthesizer.speak(utterance)
    }

    @objc func stop(_ call: CAPPluginCall) {
        synthesizer.stopSpeaking(at: .immediate)
        delegate?.settleAll(spoken: false)
        call.resolve()
    }

    @objc func pause(_ call: CAPPluginCall) {
        synthesizer.pauseSpeaking(at: .word)
        call.resolve()
    }

    @objc func resume(_ call: CAPPluginCall) {
        synthesizer.continueSpeaking()
        call.resolve()
    }

    func emitBoundary(start: Int, length: Int) {
        notifyListeners("boundary", data: ["start": start, "length": length])
    }
}

/// Holds the in-flight call so the delegate can settle it.
///
/// One utterance at a time is the contract — the reader speaks a sentence, waits
/// for it, then speaks the next — so this keeps a single call rather than a map.
/// A second speak() while one is running settles the first as interrupted,
/// which is exactly what the synthesiser itself does to the audio.
final class SpeechDelegate: NSObject, AVSpeechSynthesizerDelegate {
    private weak var plugin: OrSpeechPlugin?
    private var pending: CAPPluginCall?

    init(plugin: OrSpeechPlugin) {
        self.plugin = plugin
        super.init()
    }

    /// Records the call to settle when this utterance ends.
    ///
    /// The settleAll here is belt and braces: speak() stops the synthesiser
    /// first, so didCancel has normally already cleared the previous call. It
    /// stays for the case where the synthesiser was idle but a call somehow
    /// outlived its utterance, because a pending call that is never settled is
    /// a reader stuck on a sentence forever.
    func begin(call: CAPPluginCall, utterance: AVSpeechUtterance) {
        settleAll(spoken: false)
        pending = call
    }

    func settleAll(spoken: Bool) {
        guard let call = pending else { return }
        pending = nil
        call.resolve(["spoken": spoken])
        call.keepAlive = false
    }

    public func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer,
                                  didFinish utterance: AVSpeechUtterance) {
        settleAll(spoken: true)
    }

    public func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer,
                                  didCancel utterance: AVSpeechUtterance) {
        settleAll(spoken: false)
    }

    // Where iOS is in the sentence, so the reader's highlight can follow the
    // voice instead of jumping a sentence at a time.
    public func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer,
                                  willSpeakRangeOfSpeechString characterRange: NSRange,
                                  utterance: AVSpeechUtterance) {
        plugin?.emitBoundary(start: characterRange.location, length: characterRange.length)
    }
}
