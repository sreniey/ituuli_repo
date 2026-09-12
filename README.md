<img width="1000" height="300" alt="usbnnr" src="https://github.com/user-attachments/assets/043b9f70-0a3e-4915-9a43-fbec668892cd" />


## 
**Team Name : INUTILE**

**Team Members**

**NIHARIKA K GIREESH**

**NIHEL MARIAM**
# ITUULI 🔥🥶
**Find it. Don't ask why.**

<img width="1528" height="761" alt="Screenshot 2026-09-12 064700" src="https://github.com/user-attachments/assets/7fcca17d-0db4-4ce0-b0f7-e9c8130c1276" />










ITUULI turns the classic "hot and cold" game into a Bluetooth-powered device finder. Instead of a person shouting hot/cold while you search for a hidden object, your browser's Bluetooth radio does the shouting — using real signal strength (RSSI) from nearby Bluetooth Low Energy advertisements to tell you if you're getting warmer or colder.

Lost your AirPods somewhere in the house? Scan for them, lock on, and chase the heat meter until you find them.

> ചൂട് / CHOODU — Malayalam for "heat" — is the whole game.

## How it works

1. **Scan** — ITUULI uses the [Web Bluetooth API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Bluetooth_API) to discover nearby Bluetooth devices broadcasting advertisements.

<img width="1505" height="700" alt="Screenshot 2026-09-12 065002" src="https://github.com/user-attachments/assets/648de3de-9042-41bf-a162-8f786283a869" />







2. **Lock on** — Pick the device you're hunting for from the discovered list.
<img width="1435" height="630" alt="Screenshot 2026-09-12 084607" src="https://github.com/user-attachments/assets/8fe24be6-f16e-4e7f-ab94-e93278758b8d" />







3. **Search** — As you physically move around, the browser keeps listening for advertisements from your target. Signal strength (RSSI) is smoothed and normalized into a 0–100 "heat score."
<img width="1523" height="717" alt="Screenshot 2026-09-12 065044" src="https://github.com/user-attachments/assets/ab226f49-5eb9-45cc-aaa0-7449f76c8466" />







4. **Hot or cold** — The heat score drives an emoji, a shout ("THANUPPU..." for cold, "CHUUUDE!" for hot), a glowing heat meter, and audio beeps that speed up as you close in.
5. **Found it** — Cross the heat threshold and the game ends with your time and hot/cold-change stats.

If a real Bluetooth reading hasn't arrived in a while (devices don't advertise constantly), a "wander" fallback gently drifts the heat score so the game never feels frozen — but it's capped well below the "found" threshold, so you can never win from a stale signal.

There's also a **built-in tutorial demo** (mouse/touch based) on the landing screen and search screen, so anyone can understand the hot/cold concept even without a working Bluetooth connection.
<img width="1528" height="761" alt="Screenshot 2026-09-12 064700" src="https://github.com/user-attachments/assets/1f8f8661-e6fc-4aee-aa17-0dc673444b56" />







## Tech stack

Plain HTML, CSS, and JavaScript.

`script.js` is organized into small namespaced modules:

| Module | Responsibility |
|---|---|
| `Utils` | Small math helpers |
| `Config` | Every tunable threshold in one place (heat bands, smoothing, timing) |
| `AudioFX` | Original beeps via the Web Audio API (no external/copyrighted audio) |
| `Proximity` | Normalizes raw signal into a smoothed 0–100 heat score |
| `BluetoothIO` | Real Web Bluetooth device discovery + advertisement RSSI |
| `DemoMode` | Pointer/touch fallback that feeds the same Proximity pipeline |
| `Game` | Timer, hot/cold change counter, found detection |
| `UI` | Screen switching and rendering heat state |
| `Main` | Wires buttons to everything above |

## Project structure

```
.
├── index.html               # App markup (4 screens: landing, select, search, found)
├── style.css                 # Styling and animations
├── script.js                  # All app logic (see modules above)
├── ituuli-single-file.html   # Standalone, self-contained build (HTML+CSS+JS in one file)
└── ituuli-deploy.zip          # Zipped build ready for static hosting
```

## Running locally

Because it's fully static, you can serve it with any static file server. The Web Bluetooth API requires a **secure context** (HTTPS or `localhost`), so plain `file://` won't work for real scanning — the tutorial/demo mode will still work regardless.

```bash
# Python
python3 -m http.server 8000

# Node
npx serve .
```

Then open `http://localhost:8000` in a Web Bluetooth–capable browser.

Alternatively, just open `ituuli-single-file.html` directly for a quick look at the UI (demo mode only, unless served over a secure context).

## Browser support

Web Bluetooth is required for real device scanning and is currently supported in Chromium-based browsers (Chrome, Edge, Opera, Brave) on desktop and Android. It is **not supported in Safari or Firefox**. ITUULI detects support at runtime and falls back to demo mode with an explanatory note when it's unavailable.

## Deployment

`ituuli-deploy.zip` contains the minimal static bundle (`index.html`, `style.css`, `script.js`) ready to drop onto any static host (GitHub Pages, Netlify, Vercel, etc.). Since Web Bluetooth requires HTTPS, make sure your host serves over `https://`.

**OUR DEPLOYED LINK** : (https://ituuli-repo.vercel.app/)


## **Video**
https://drive.google.com/drive/folders/1CFwNNjj6OYZXWLo_uUEWHrDdUQhYtpXd?q=type:video%20parent:1CFwNNjj6OYZXWLo_uUEWHrDdUQhYtpXd








## Disclaimer

Accuracy not guaranteed. Blame Bluetooth.
