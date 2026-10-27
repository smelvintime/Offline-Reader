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

## Options

`npm start -- --port 8787 --code 123456 --dtype fp32`

- `--port`: default 8787, which is what the app assumes when you type an
  address without one.
- `--code`: fix the code instead of a new random one each start.
- `--dtype`: `fp32` (default, matches the iPhone's own build) or `q8`
  (smaller download, slightly different sound).

Anyone on your network who has the code can ask for audio, and nothing else:
there is no file access and no other endpoint.
