# Pmrg2022AI Glasses — web prototype

## Files
- `index.html`: page structure
- `style.css`: understated dark UI
- `script.js`: chat API, browser speech recognition, and speech synthesis

## Run
For microphone access, serve this site from HTTPS or localhost. Opening `index.html` directly may prevent browser microphone features from working.

The chat request matches the provided backend:
POST https://ai-custom-hosting.onrender.com/chat
Content-Type: application/json
Body: {"message":"..."}

Expected response: {"response":"..."}

## Glasses
Pair `six-13` using the iPad's Bluetooth settings before testing speech output. Web speech synthesis normally uses the system-selected audio output; browser APIs do not provide a universal way to force a specific Bluetooth device.

Speech recognition availability differs between iPadOS browsers. If voice input is unavailable, typed chat should still work.
