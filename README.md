# SFX Editor

A small desktop tool for trimming sound effects quickly and matching their volumes.

## Run

Double-click `SFX Editor.cmd`, or:

```
npm install
npm start
```

If Electron complains it "failed to install correctly", run `node node_modules/electron/install.js` once.

## Use

Drop one or more sounds (wav, mp3, ogg, flac…) anywhere in the window, or click **+ Add**.

| Action | Button | Key |
| --- | --- | --- |
| Select a range | drag on the waveform (drag the edges to adjust, drag inside to move it) | double-click / `Ctrl+A` selects all, `Esc` clears |
| Preview the selection (whole sound if nothing selected) | **Preview** | `Space` |
| Remove the selection | **Cut** | `Del` / `X` |
| Replace the selection with silence | **Silence** | `M` |
| Keep only the selection | **Trim to selection** | `T` |
| Mix stereo down to mono (whole sound; removes left-right panning) | **Make mono** | `O` |
| Undo | **Undo** | `Ctrl+Z` |
| Save `name-edit.wav` next to the original | **Save -edit** | `Ctrl+S` |
| Switch sound | click it in the list | `↑` / `↓` |

### Matching volumes

Each sound in the list has a gain slider (double-click resets it to 0 dB) and a meter showing its loudness (bar) and peak
(tick). The blue tick on each meter is the selected sound's loudness, so you can line them up by eye.

- **Match others to selected** sets every other sound's gain so its loudness equals the selected one.
- **▶ Play all** plays every sound back to back so you can compare by ear. Gain changes apply live while playing.
- **Save all** writes a `-edit` copy of every sound with unsaved changes (marked ●).

Gain is baked into the saved file. Peaks that would clip turn red in the meter and the waveform.

### Saving

- `boom.mp3` saves as `boom-edit.wav` in the same folder. Saving again overwrites that `-edit` file, never the original.
- Opening `boom-edit.wav` and saving writes back to `boom-edit.wav`.
- WAVs keep their sample rate and bit depth (16-bit, 24-bit, or 32-bit float). Other formats save as 16-bit WAV.
- A sound made mono saves as a mono WAV (half the size). Mono is what game engines need for 3D-positioned sounds.
