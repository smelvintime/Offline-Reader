# voice-server

Prepares Offline Reader audiobooks on your computer instead of your iPhone,
and keeps them. The phone sends a book's text over home Wi-Fi, this computer
renders it with the same voice and stores it, and the phone collects the
finished audio whenever it likes. Listening afterwards is the same either way.

The computer owns the work. Once a book has been sent, the phone can be shut,
run flat or leave the house, and the rendering carries on here. Stopping the
server and starting it again picks every unfinished book up where it stopped.

## Once

1. Install Node 22 or newer. With Homebrew:

   ```bash
   brew install node
   ```

2. Install ffmpeg, so books are stored compressed. Without it everything
   still works, at about 170 MB an hour instead of 22 MB:

   ```bash
   brew install ffmpeg
   ```

3. Install the server's one dependency:

   ```bash
   cd voice-server && npm install
   ```

## Each time

1. Start it, keeping the Mac awake while it runs:

   ```bash
   caffeinate -i npm start
   ```

   It prints an **Address** (one per network; use the Wi-Fi one, usually
   `192.168…`) and a six-digit **Code**.

2. If macOS asks whether `node` may accept incoming connections, choose
   **Allow**.

3. On the phone: open the book, open the voice sheet, type the address and
   code under **Prepare on my computer**, and tap it. The first time, iOS
   asks to find devices on your local network: **Allow**. (If it was refused:
   Settings → Privacy & Security → Local Network → Offline Reader.)

   The phone sends the whole book and then only watches. Once it says so you
   can close the app and put the phone down: this computer keeps rendering.

   You do not have to wait for the book to finish. Tap **Play** as soon as you
   like: the book is sent starting from the chapter you are on, the audio
   arrives as it is made, and the book plays while the rest is prepared behind
   it. If you jump to a chapter that is not ready, playback waits and this
   computer makes that chapter next. Later, with the app reopened, **Play**
   goes back to this computer by itself and collects what is waiting.

4. Leave this window open while it works. Ctrl+C stops the server, and
   starting it again carries on by itself.

The first start downloads the voice (about 330 MB) into a cache inside
`node_modules`, so later starts are quick. It then starts several copies of
the voice, which takes a few seconds each. The phone shows "Your computer is
loading the voice" while that happens.

## Watching it work

When it starts, the server prints a **Monitor** link. Open it in a browser on
this computer:

```
http://localhost:8787/?code=123456
```

(with the code your server printed). The page shows whether the voice has
loaded, a ring that spins while anything is rendering, and each book with a
progress bar, how many parts are done, about how long is left, how fast it is
going compared with listening, and when the last part finished. Under that are
the last things the server said. It refreshes itself every two seconds, and
says so if the server stops answering.

From another device on the same Wi-Fi, use the server's **Address** in place
of `localhost`, with the same `?code=`.

## Using the whole computer

The server runs several copies of the voice at once, each in a process of its
own on one processor thread, so every core renders a sentence instead of most
of them waiting on one. It starts with half as many copies as the computer has
cores, and then finds the fastest number by trying, while it works:

1. it measures how fast it is going (seconds of audio made per second);
2. it adds one copy and measures again;
3. if that was at least 5% faster it keeps the copy and tries one more;
4. if not, it takes the copy away again and stays there.

It never starts more copies than the computer has cores, or than fit in half
its memory (about 1 GB a copy). After settling it looks again every twenty
minutes, since the answer changes when another program stops or starts. The
number it found is remembered in `voice-tuning.json` in the books folder, so
the next start begins there. The monitor page shows how many copies are
running and how fast it is going.

A long book will use most of the computer while it renders. To keep some for
yourself, fix the number:

```bash
caffeinate -i npm start -- --workers 4
```

To see what this computer can do before leaving a book on it:

```bash
npm run bench
```

It renders the same few sentences with one copy using every core, which is
how the server used to work, and then with 1, 2, 3… copies, and prints the
speed of each.

## More than one computer

Every computer renders its share at the same time, and each part goes to
whichever one is free, so two similar Macs take about half the time and a
faster one simply does more.

1. On each extra computer, do **Once** above, then start it with a fixed
   code:

   ```bash
   caffeinate -i npm start -- --code 123456
   ```

2. On the main computer, use the same code and name each extra one by its
   address:

   ```bash
   caffeinate -i npm start -- --code 123456 --peer 192.168.1.21
   ```

   It says straight away whether each one answers. Repeat `--peer` for a
   third.

   Either computer can use its graphics chip: add `--gpu` on that one, as
   below, and it renders on its chip and its processor together. Each
   computer tells the main one how many parts it takes at once, so every
   one is kept as busy as it would be on its own.

3. On the phone, type only the main computer's address. The progress line
   reads "On 2 computers".

If an extra computer sleeps, stops or has a different code, the main one
carries on without it and tries it again 30 seconds later.

## Books this computer keeps

Every book sent here is written to `~/OfflineReaderBooks`, one folder per
book, named so you can find it:

    the-blade-itself-9f2a1c0d/
      book.json          the book, its voice, and every part with its file
      parts/4f3ad91c….m4a   one part of the narration

Nothing is deleted on its own. `Books:` at startup says where the folder is,
and `--library` moves it, onto an external drive for instance.

The app talks to it over these, all needing the same `x-voice-code` header:

| | |
|---|---|
| `POST /job` | takes a book, or a chunk of one: `{ book, title, voice, parts: [{ key, text, cuts }] }`. Answers 202 as soon as it is written down, and renders afterwards. Sending the same book again adds new parts and retries failed ones, leaving finished ones alone. `cuts` is optional: where each sentence begins in `text`, starting at 0. A part that has them is rendered a sentence at a time, so its clip knows when each sentence starts. `first: true` puts these parts at the front of the queue: it is what the app sends when someone is waiting to hear them. |
| `GET /job?book=…` | how far along: `done`, `total`, `bytes`, `running`, `msPerPart`. |
| `POST /job/stop?book=…` | stops rendering. Parts already finished are kept. |
| `GET /bundle?book=…` | every finished part as one zip, holding `book.json` and `parts/`. To collect a book in several passes, send `&from=N` with the `next` from the last zip you took (also the `x-next` header), and you get only what has landed since. A part rendered a sentence at a time carries `marks` in `book.json`: the second each sentence starts at, which is what the app's highlight follows. |
| `GET /books` | everything this computer holds. |
| `DELETE /book?book=…` | removes a book and its audio. |
| `GET /` | the monitor page. Needs no code, because it holds nothing: it asks `/activity` for what it shows. |
| `GET /activity` | everything the monitor page shows: the voice, how busy the computers are, every book with its progress, and the last lines of the log. |

A book can be kept in more than one voice. The app sends each voice as its own
book (`book` is `id@voice`) and names the book they both are in `family`. Each
gets its own folder, with the voice in its name. Only one voice of a family
renders at a time: the one asked for most recently. The other pauses, keeps
its audio, and carries on when the app asks for that voice again.

The zip is an ordinary zip: double-click it in Finder, or put it on a USB
stick, if you would rather move a book by hand than over Wi-Fi.

## The Trevor voice (Phonon)

Besides the Kokoro voices the phone also has, this server speaks one more:
**Trevor**, from Phonon (`gradium/phonon-31m-en`, Apache 2.0). In the app it
is the voice marked "Your computer", and the narrator a new reader starts with.

- **Trevor's pace** (1.0x to 1.4x, 1.3x to begin with) sits under Speed while
  Trevor is chosen. It is spoken into the audio rather than sped up, so it
  sounds natural, and a new pace is a new voice to this server: the book is
  prepared again at that pace, and the old pace is kept. 1.4x is as fast as
  the model goes; Speed still works on top. The voice id carries it:
  `pn_trevor_13` is 1.3x.

- Only a computer makes it. The phone has no Phonon, so it will not prepare a
  book in Trevor itself; use **Prepare on my computer**. Preview asks the
  computer too.
- Nothing to install. The first Trevor book downloads the model and voice
  (about 65 MB) into `voice-server/.cache/phonon/`, pinned to fixed
  revisions so a book never changes voice halfway.
- It runs in its own copies on the processor, tuned like Kokoro's and
  remembered in `voice-tuning-phonon.json`, and starts only when a Trevor book
  arrives. A Mac renders a chapter of a novel in under a minute.
- It never goes to `--gpu`, which is a Kokoro service. Every computer sharing
  a Trevor book needs this version of voice-server.

## Options

`npm start -- --port 8787 --code 123456 --dtype fp32`

- `--port`: default 8787, which is what the app assumes when you type an
  address without one.
- `--code`: fix the code instead of a new random one each start.
- `--library`: where books are kept. Default `~/OfflineReaderBooks`, or the
  `OFFLINE_READER_LIBRARY` environment variable.
- `--dtype`: `fp32` (default, matches the iPhone's own build) or `q8`
  (smaller download, slightly different sound). Use the same on every
  computer sharing a book.
- `--workers`: how many copies of the voice run at once on this computer's
  processor. Default `auto`: it finds the fastest number by trying (see
  "Using the whole computer"). A number fixes it, for example `--workers 4`
  to leave room for other work.
- `--threads`: threads given to each copy. Default 1, which is what makes
  many copies fast; raise it only with a small `--workers`.
- `--peer`: another computer running voice-server with the same code, to
  share the work with. Repeat it, or separate addresses with commas.
- `--gpu`: render on a graphics card too, through the small Python service
  described below. The card has first pick of the work and the processor's
  copies take what it cannot, so both are busy; if the service stops, the
  processor carries on alone. `--workers 0` uses the card only.
- `--slots`: how many parts to render at once. 1 on the CPU, where one
  forward pass already uses every core, and 8 with `--gpu`, because one
  paragraph leaves a card about a third busy.

### A Windows computer as one of them

The server runs the same on Windows; only the setup differs.

- Install Node (`winget install OpenJS.NodeJS.LTS`) and, if this one will be
  the main computer, ffmpeg (`winget install ffmpeg`). Then `npm install`
  here as usual.
- There is no `caffeinate`: start it with plain `npm start -- ...`, and set
  Settings → System → Power → Sleep to Never while a book prepares.
- The first start, Windows Firewall asks about `node`: allow it on
  **Private** networks, or the other computer cannot reach it. If the Wi-Fi
  is marked Public, change it to Private (Settings → Network → Wi-Fi → the
  network → Private).
- An NVIDIA card is the `gpu_voice.py` service below, not `mac_voice.py`.
  Start it first, then `npm start -- --code 123456 --gpu http://127.0.0.1:8899`.
  Its processor helps as on a Mac.

## Rendering on a graphics card

The engine above runs on the CPU on purpose, so a desktop sounds exactly like
the phone. On a machine with a real graphics card that costs most of the
speed. Measured here on an RTX 4080 Super, same parts, same voice, through
this same server and library:

| Engine | Audio | Took | Rate |
|---|---|---|---|
| CPU, fp32, 16 cores | 7.4 min | 74.7s | 6x realtime |
| GPU | 7.4 min | 8.3s | 54x realtime |
| GPU, longer run | 30.8 min | 18.6s | 100x realtime |

Sixteen times, once the run is long enough to settle. A book that took 70
hours should take about 4.

Nothing in this server knows about CUDA. Its engine is one function, text in
and samples out, so the card lives behind that function in a separate Python
service, started first:

```
cd ..\..\book2audio
.venv\Scripts\python gpu_voice.py
```

then here:

```
npm start -- --gpu http://127.0.0.1:8899 --code 123456
```

The phone sees no difference: same model, same voices, same clip keys, same
manifest. The CPU voice loads as well and takes what the card cannot; if
the Python service is not running, the CPU does it all and the log says the
GPU failed. With `--workers 0` there is no CPU voice and nothing renders
without the service.

### On a Mac's graphics chip

`gpu/mac_voice.py` is the same kind of service for Apple Silicon, running
Kokoro on the GPU through MLX (Apple's array library) and the `mlx-audio`
package. It speaks the same two routes as the CUDA service, so `--gpu` cannot
tell them apart.

**Status: written from `mlx-audio` 0.6.5's source and tested only with its fake
voice. It has not been run on a Mac with the real model.** The first thing to
do is the check below, which measures it. Whether it beats the processor on
your Mac is the question, and it is yours to answer: the processor path
already makes about 8x realtime on a 12-core Mac.

Once:

```bash
brew install python@3.12 espeak-ng
cd voice-server/gpu
/opt/homebrew/bin/python3.12 -m venv .venv
. .venv/bin/activate
pip install -r requirements-mac.txt
```

Then check it. This renders a few sentences, says how fast, and tests that a
made-up name is spoken rather than skipped:

```bash
python mac_voice.py --check
```

The first run downloads the voices and a small language model, so it takes a
few minutes. If it says **DROPPED**, install `espeak-ng` as above and run it
again: without it, every word its dictionary does not know (a novel's invented
names) is left out of the sentence without a sound.

Then find how many requests to keep waiting, with the service running in one
window:

```bash
python mac_voice.py
```

and in another:

```bash
cd voice-server
node bench.mjs --gpu http://127.0.0.1:8899
```

It prints the speed with 1, 2, 3… requests in flight and the `--slots` to use.
Then:

```bash
caffeinate -i npm start -- --gpu http://127.0.0.1:8899 --slots 3 --code 123456
```

Two things to listen for, since this is a different implementation of the same
voice and not the same program:

- It speaks the 16-bit-float (`bf16`) weights, where the processor path uses
  full precision, and it turns text into sounds with a different program
  (misaki, not the one the phone uses). The same words can be pronounced
  slightly differently. The clip keys do not include which machine made a
  clip, so a book can mix them, but it is kinder to the ear to render one
  book on one engine.
- Everything else is the same: the same voices, the same clip keys, the same
  manifest, and the phone cannot tell.

The service listens on `127.0.0.1` only, so nothing else on the network can
reach it; voice-server, on the same computer, is its only caller. Without a
Mac, `python gpu/mac_voice.py --fake` serves a tone instead of speech, which
checks the wiring.

Anyone on your network who has the code can ask for audio and read back the
books this server itself prepared, and nothing else: there is no access to
any other file on the computer.
