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

   The phone sends the whole book in one go and then only watches. Once it
   says so you can close the app and put the phone down: this computer keeps
   rendering. Open the book again later and tap **Prepare on my computer** to
   collect what is waiting.

4. Leave this window open while it works. Ctrl+C stops the server, and
   starting it again carries on by itself.

The first start downloads the voice (about 330 MB) into a cache inside
`node_modules`, so later starts are quick. The phone shows "Your computer is
loading the voice" while that happens.

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
| `POST /job` | takes a whole book: `{ book, title, voice, parts: [{ key, text }] }`. Answers 202 as soon as it is written down, and renders afterwards. Sending the same book again adds new parts and retries failed ones, leaving finished ones alone. |
| `GET /job?book=…` | how far along: `done`, `total`, `bytes`, `running`, `msPerPart`. |
| `POST /job/stop?book=…` | stops rendering. Parts already finished are kept. |
| `GET /bundle?book=…` | every finished part as one zip, holding `book.json` and `parts/`. To collect a book in several passes, send `&from=N` with the `next` from the last zip you took (also the `x-next` header), and you get only what has landed since. |
| `GET /books` | everything this computer holds. |
| `DELETE /book?book=…` | removes a book and its audio. |

The zip is an ordinary zip: double-click it in Finder, or put it on a USB
stick, if you would rather move a book by hand than over Wi-Fi.

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
- `--peer`: another computer running voice-server with the same code, to
  share the work with. Repeat it, or separate addresses with commas.

Anyone on your network who has the code can ask for audio and read back the
books this server itself prepared, and nothing else: there is no access to
any other file on the computer.
