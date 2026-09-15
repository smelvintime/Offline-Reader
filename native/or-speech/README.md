# or-speech

The iPhone's own narrator, with the voices that are actually worth hearing.

## Why this exists

The app shipped a device voice once and it was removed for sounding like a
robot. It sounded like a robot because it was speaking through the **compact**
voice: iOS ships a small default in every language and uses it unless asked
otherwise. The Enhanced and Premium voices — the ones a reader downloads under
Settings → Accessibility → Spoken Content → Voices — are a different class of
thing, and nothing in the old code ever asked for one.

So the first job here is to enumerate honestly. `voices()` reports every
installed voice with the quality tier iOS assigns it, which lets the picker lead
with the good ones and say plainly when only the compact one is installed. That
is a settings problem with a one-minute fix, and telling the reader beats any
amount of tuning on our side.

The second job is the thing no on-device model matches: it starts speaking
immediately. No inference, no weights, and no wait proportional to the length of
the paragraph — which is exactly where the natural voice struggles on real
hardware.

## What it is not

Siri's own voices. Those are not exposed to third-party apps through
`AVSpeechSynthesisVoice`, so this enumerates what the device will actually give
us rather than promising a voice it will not. Personal Voice (iOS 17+) is
reported with `personal: true` when the reader has one and has granted access.

## API

All methods degrade to `null` off-device, per ARCHITECTURE §2.3.

| Method | Returns |
| --- | --- |
| `available()` | `{ available: true }` |
| `voices({ lang })` | `{ voices: [{ id, name, lang, quality, personal }] }` |
| `speak({ text, voiceId, lang, rate, pitch, gap })` | `{ spoken: boolean }` |
| `stop()` / `pause()` / `resume()` | `void` |

`quality` is one of `premium`, `enhanced`, `default`.

`speak` resolves when the utterance **finishes**, not when it starts. The
reader's queue advances on that promise, so resolving early would race the
narration ahead of its own audio. Being interrupted resolves `spoken: false`,
which is an ordinary outcome rather than an error.

The audio session is `.playback` with mode `.spokenAudio`, so narration
survives the screen locking and is not silenced by the ringer switch.

A `boundary` listener event (`{ start, length }`) fires as iOS moves through the
sentence, which is what lets a highlight follow the voice rather than jump a
sentence at a time.

## Dependencies

None. `AVFoundation` is a system framework, so this adds nothing to the app's
download.
