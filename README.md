# Vinyl

A turntable for your Mac's screen. Vinyl shows the song playing in Apple Music or Spotify as a record in its sleeve, with the cover art on both. The room behind it is the cover, washed into paper, drifting slowly while the music plays.

- Press play and the record slides out of its sleeve and the tonearm swings onto it. Pause, and the arm goes home and the record slides back in.
- The tonearm is the progress bar. It moves from the edge of the record toward the label as the song plays, and cues across the record when you scrub.
- Skip forward and the next record arrives from the right; skip back and it comes from the left.
- Play, pause, skip, seek and volume all control the real app on your Mac. Tap the record to pause it.

## Run it

You need macOS and [Node.js](https://nodejs.org) 18 or newer. Nothing else gets installed.

```sh
git clone https://github.com/aidenyjin/vinyl.git
cd vinyl
npm start
```

Your browser opens <http://localhost:4747>. Keep the Terminal window open while you use it.

The first time it runs, macOS asks whether Terminal may control Music (and Spotify, if it's open). Click **OK**. If you clicked **Don't Allow**, open **System Settings → Privacy & Security → Automation**, find Terminal, and turn on Music and Spotify.

### Make it an app

In Safari, open <http://localhost:4747> and choose **File → Add to Dock**. Vinyl then opens in its own window with its own icon. The helper still needs to be running in Terminal.

### Keys

| Key | Does |
| --- | --- |
| Space | Play or pause |
| ← → | Previous or next song |
| Shift ← → | Back or forward 10 seconds |
| ↑ ↓ | Volume |
| F | Full screen. The screen stays awake while it's full screen. |

The progress and volume lines work with a mouse or a finger: click or drag anywhere along them. You can also scroll on the volume line.

### Options

```sh
PORT=4848 npm start        # use another port
NO_OPEN=1 npm start        # don't open the browser
HOST=0.0.0.0 npm start     # let an iPad or phone on your Wi-Fi open it
```

With `HOST=0.0.0.0`, open `http://<your-mac's-name>.local:4747` on the other device. Anyone on the same network can then see and control what's playing, so use it at home.

## How it works

`server.js` is a small web server with no dependencies. Once a second it asks Music and Spotify what they're playing through AppleScript (`players.js`), and it streams the answer to the page. It only checks apps that are already open, so it never launches one by itself. Cover art comes from Music or Spotify, or from Apple's public search when Music has none.

`public/` is the page itself: plain HTML, CSS and JavaScript with no build step.

If the helper isn't running, for example when you open the page from somewhere else, it plays a demo playlist instead.

## What it can't do

- It shows Apple Music and Spotify only. Songs playing in a browser tab or another app don't appear.
- There's no visualizer. Music and Spotify don't share their audio with other apps, so anything that moved to the beat would be faked.

## Demo covers

The demo playlist pairs public-domain music with public-domain paintings from The Metropolitan Museum of Art's Open Access collection:

- Albert Pinkham Ryder, *Moonlight Marine*, 1870–90 ([source](https://www.metmuseum.org/art/collection/search/11979))
- Pierre Puvis de Chavannes, *The Shepherd's Song*, 1891 ([source](https://www.metmuseum.org/art/collection/search/437344))
- Pieter Bruegel the Elder, *The Harvesters*, 1565 ([source](https://www.metmuseum.org/art/collection/search/435809))
- Katsushika Hokusai, *Under the Wave off Kanagawa*, ca. 1830–32 ([source](https://www.metmuseum.org/art/collection/search/45434)). Debussy chose this print for the first edition of *La Mer*.
- James McNeill Whistler, *Nocturne: The Thames at Battersea*, 1878 ([source](https://www.metmuseum.org/art/collection/search/337702))
