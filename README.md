# YouTube Video Summarizer Chrome Extension

A Chrome extension that adds AI-powered summarization buttons to YouTube videos on the home page using Google's Gemini API.

## Features

- 🎯 Adds a "Summarize" button to each video on YouTube's home page
- 🤖 Uses Google Gemini API to generate concise summaries
- 💾 Stores your API key securely in Chrome sync storage
- 🎨 Beautiful, modern UI with smooth animations
- ⚡ Fast and lightweight

## Installation

1. **Create Icon Files (Required)**
   - Open `create-icons.html` in your browser
   - Click "Generate Icons"
   - Right-click each canvas and save as:
     - `icon16.png` (16x16)
     - `icon48.png` (48x48)
     - `icon128.png` (128x128)
   - Place these files in the `yt-sum` folder
   - Alternatively, create your own icon PNG files with these dimensions

2. **Get a Gemini API Key**
   - Visit [Google AI Studio](https://makersuite.google.com/app/apikey)
   - Sign in with your Google account
   - Click "Create API Key"
   - Copy your API key

3. **Load the Extension**
   - Open Chrome and navigate to `chrome://extensions/`
   - Enable "Developer mode" (toggle in top right)
   - Click "Load unpacked"
   - Select the `yt-sum` folder

4. **Configure the Extension**
   - Click the extension icon in your toolbar
   - Paste your Gemini API key
   - Click "Save API Key"

## Usage

1. Navigate to YouTube's home page (`youtube.com`)
2. You'll see a "📝 Summarize" button on each video thumbnail
3. Click the button to get an AI-generated summary
4. The summary will appear in a modal popup

## How It Works

- The extension injects buttons into YouTube's home page using a content script
- When you click a button, it:
  1. Extracts the video ID and title
  2. Sends a request to the Gemini API via the background service worker
  3. Displays the generated summary in a modal


## Documentation

For detailed codebase documentation, see [DOCUMENTATION.md](./docs/DOCUMENTATION.md) which includes:
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

**Button doesn't appear:**
- Make sure you're on YouTube's home page
- Refresh the page
- Check that the extension is enabled in `chrome://extensions/`

**Summary fails to generate:**
- Verify your API key is correct in the extension popup
- Check that you have API quota remaining
- Open Chrome DevTools (F12) and check the Console for errors

**API Key not saving:**
- Make sure Chrome sync is enabled
- Try reloading the extension

## Development

To modify the extension:

1. Make your changes to the files
2. Go to `chrome://extensions/`
3. Click the refresh icon on the extension card
4. Reload the YouTube page to see changes

## License

MIT License - Feel free to use and modify as needed.

## Notes

- The Gemini API has rate limits - check your quota if you encounter issues.

