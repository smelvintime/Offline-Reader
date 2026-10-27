# voice-server

Prepares Offline Reader audiobooks on your Mac instead of your iPhone. The
phone sends the text over home Wi-Fi, the Mac renders it with the same voice,
and the phone stores the result exactly as if it had made it. Listening
afterwards is the same either way.

## Once

1. Install Node 22 or newer. With Homebrew:

   ```bash
   brew install node
   ```

2. Install the server's one dependency:

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

4. Leave the window open until the book is ready. Ctrl+C stops the server;
   tapping Prepare again later carries on where it stopped.

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

## Options

`npm start -- --port 8787 --code 123456 --dtype fp32`

- `--port`: default 8787, which is what the app assumes when you type an
  address without one.
- `--code`: fix the code instead of a new random one each start.
- `--dtype`: `fp32` (default, matches the iPhone's own build) or `q8`
  (smaller download, slightly different sound). Use the same on every
  computer sharing a book.
- `--peer`: another computer running voice-server with the same code, to
  share the work with. Repeat it, or separate addresses with commas.

Anyone on your network who has the code can ask for audio, and nothing else:
there is no file access and no other endpoint.
