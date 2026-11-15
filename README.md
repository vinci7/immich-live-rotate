# Immich Live Photo Rotate

[中文](README.zh-CN.md)

A userscript that rotates iPhone Live Photos in the [Immich](https://immich.app) web UI — photo and motion video together, losslessly. Immich's own editor can't do this ([immich#28480](https://github.com/immich-app/immich/issues/28480)).

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/) or [Violentmonkey](https://violentmonkey.github.io/). In Chrome, also enable **Allow User Scripts** on the extension's details page.
2. Open [immich-live-rotate.user.js](https://raw.githubusercontent.com/vinci7/immich-live-rotate/main/immich-live-rotate.user.js) and install.

## Use

Open a Live Photo, click the rotate button in the toolbar (each click adds 90°), then **Rotate**. Click elsewhere or press <kbd>Esc</kbd> to cancel.

The original is stacked under the new version by default; switch to "move to trash" in the userscript manager's menu.

## Good to know

- Rotating creates a new asset. Favorite, description, rating, albums and tags are copied; date or location edits made in Immich, shared links and comments are not, and faces are re-detected.
- The script matches all sites because Immich runs on any domain, and only activates where `/api/server/ping` answers like Immich. You can restrict it to your Immich URL in the userscript manager.
- HEIC Live Photos from iPhone only, one at a time, your own photos only.
- Tested on Immich v3.4.0 with Chrome. If the button disappears after an Immich update, please [open an issue](https://github.com/vinci7/immich-live-rotate/issues).

## How it works

Orientation is metadata, so only a few bytes change: `irot` and EXIF Orientation in the HEIC (HDR gain map kept aligned), the `tkhd` matrix in the MOV. Both get a new `ContentIdentifier` so Immich doesn't re-pair the original with the new video. The pair is then uploaded through Immich's API with your session.

Test the core with your own files: `node test/core.test.cjs photo.heic video.mov`.

## License

[MIT](LICENSE). Not affiliated with Immich.
