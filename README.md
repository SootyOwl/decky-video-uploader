# Video Uploader

A [Decky Loader](https://github.com/SteamDeckHomebrew/decky-loader) plugin for Steam Deck that lets you export Steam game recordings as MP4 files and upload them to YouTube — all from Game Mode.

## Features

- **Browse Steam clips** — view background recordings and manual clips organised by game
- **Export to MP4** — convert Steam's internal recording format to MP4 with configurable quality (original, smaller, smallest)
- **Upload to YouTube** — upload exported videos directly to YouTube with title, description, tags, and privacy settings
- **Manage videos** — browse, filter, sort, and delete both clips and exported videos
- **Game subfolders** — optionally organise exported videos into `~/Videos/<game name>/` subfolders
- **YouTube authentication** — connect your YouTube account via Google OAuth device flow (built-in or custom credentials)

## Installation

### From the Decky Plugin Store

Coming soon!

### Manual install

1. Download `decky-video-uploader.zip` from the [latest release](https://github.com/SootyOwl/decky-video-uploader/releases)
2. Copy it to your Steam Deck
3. Install via Decky Loader's sideload option

## Usage

1. Open the Quick Access Menu (QAM) and navigate to the Video Uploader plugin
2. **Steam Clips** — browse and export your game recordings to MP4
3. **Exported Videos** — view, upload, or delete your exported MP4 files
4. **Settings** — connect your YouTube account and configure export options

### YouTube setup

1. Go to **Settings > YouTube Authentication**
2. Click **Connect YouTube Account**
3. Visit the displayed URL on any device and enter the code shown
4. Once authorised, you can upload videos from the Exported Videos view

### Custom OAuth credentials (optional)

If you prefer to use your own Google Cloud credentials:

1. Create an OAuth 2.0 Client ID in the [Google Cloud Console](https://console.cloud.google.com/)
2. Enable the YouTube Data API v3
3. In the plugin settings, click **Use Custom Credentials (Advanced)**
4. Enter your Client ID and Client Secret, then save

## Requirements

- Steam Deck running SteamOS (or any Linux system with Decky Loader)
- [Decky Loader](https://github.com/SteamDeckHomebrew/decky-loader) installed
- `ffmpeg` (pre-installed on SteamOS) — used for MP4 conversion

## Building from source

### Dependencies

- Node.js v16.14+
- pnpm v9

```bash
pnpm i
pnpm run build
```

To create a distributable zip:

```bash
bash mkzip.sh
```

## License

See [LICENSE](LICENSE) for details.
