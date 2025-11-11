![AI Generated](https://img.shields.io/badge/🤖_AI-Generated-orange)

# YouTube Video Summarizer Chrome Extension

A Chrome extension that adds AI-powered summarization buttons to YouTube videos on the home page using Google's Gemini API.

## Features

- 🎯 Adds a "Summarize" button to each video on YouTube's home page
- 🤖 Uses Google Gemini API to generate concise summaries
- 💾 Stores your API key securely in Chrome sync storage
- 🎨 Beautiful, modern UI with smooth animations and dark mode support
- ⚡ Fast and lightweight
- 📱 Side panel interface for easy access to settings

## Quick Start

### 1. Clone the Repository

```bash
git clone https://github.com/baymac/yt-sum.git
```

### 3. Install the Extension

1. Open Chrome and navigate to `chrome://extensions/`
2. Enable **"Developer mode"** (toggle in the top right corner)
3. Click **"Load unpacked"**
4. Select the `yt-sum` folder (the one containing `manifest.json`)
5. The extension should now appear in your extensions list

### 2. Get a Gemini API Key

1. Visit [Google AI Studio](https://makersuite.google.com/app/apikey)
2. Sign in with your Google account
3. Click "Create API Key"
4. Copy your API key (you'll need it in the next step)



### 4. Configure the Extension

1. Click the extension icon in your Chrome toolbar (it will open as a sidebar)
2. Paste your Gemini API key in the input field
3. Click **"Save API Key"**
4. (Optional) Toggle **"Dark Mode"** if you prefer a dark theme

## Usage

1. Navigate to [YouTube's home page](https://www.youtube.com)
2. You'll see a **"📝 Summarize"** button on each video thumbnail
3. Click the button to get an AI-generated summary
4. A modal will appear showing:
   - A loading animation while the summary is being generated
   - The full summary once ready (formatted with markdown support)
5. Close the modal by clicking the × button, pressing `Esc`, or clicking outside the modal

### Using the Side Panel

- Click the extension icon in your toolbar to open/close the settings sidebar
- The sidebar contains:
  - Dark mode toggle
  - API key input and save button
  - Link to get a new API key

## How It Works

- The extension injects buttons into YouTube's home page using a content script
- When you click a button, it:
  1. Extracts the video ID, title, and description
  2. Sends the video URL to the Gemini API via the background service worker
  3. Displays the generated summary in a modal with markdown formatting

## Project Structure

```
yt-sum/
├── manifest.json          # Extension configuration
├── background.js          # Service worker for API calls
├── content.js             # Injected script for YouTube
├── popup.html             # Settings UI (side panel)
├── popup.js               # Settings UI logic
├── styles.css             # Modal and button styles
├── icons/                 # Extension icons
└── README.md              # This file
```

## Documentation

For detailed codebase documentation, see [docs/DOCUMENTATION.md](./docs/DOCUMENTATION.md) which includes:
- Complete file-by-file breakdown
- Architecture overview
- Data flow diagrams
- Design patterns
- Technical implementation details

## Privacy & Security

- Your API key is stored locally in Chrome's sync storage
- API calls are made directly from your browser to Google's servers
- No data is sent to third-party servers
- The extension only runs on YouTube pages

## Troubleshooting

### Button doesn't appear on YouTube
- Make sure you're on YouTube's home page (`youtube.com`)
- Refresh the page (F5 or Ctrl+R)
- Check that the extension is enabled in `chrome://extensions/`
- Try disabling and re-enabling the extension

### Summary fails to generate
- Verify your API key is correct in the extension sidebar
- Check that you have API quota remaining at [Google AI Studio](https://makersuite.google.com/app/apikey)
- Open Chrome DevTools (F12) and check the Console tab for error messages
- Make sure you're using Chrome 114+ (required for side panel API)

### Side panel doesn't open
- Make sure you're using Chrome 114 or later
- Check the background service worker console in `chrome://extensions/` for errors
- Try reloading the extension

### API Key not saving
- Make sure Chrome sync is enabled
- Try reloading the extension
- Check browser console for any storage errors

## Development

To modify the extension:

1. Make your changes to the files
2. Go to `chrome://extensions/`
3. Click the refresh icon on the extension card
4. Reload the YouTube page to see changes

## License

MIT License - Feel free to use and modify as needed.

## Requirements

- **Chrome 114+** (required for side panel API)
- **Google Gemini API Key** (free tier available)
- **Chrome Developer Mode** enabled

## Notes

- The Gemini API has rate limits - check your quota at [Google AI Studio](https://makersuite.google.com/app/apikey) if you encounter issues
- The extension uses the **Gemini 2.5 Flash** model for fast and efficient summarization
- Your API key is stored locally in Chrome's sync storage and never sent to third-party servers

