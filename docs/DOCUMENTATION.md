# YouTube Video Summarizer Extension - Complete Codebase Documentation

## Architecture Overview

The extension uses Chrome Extension Manifest V3 with three main components:
- **Content Script**: Injects UI into YouTube pages
- **Background Service Worker**: Handles API calls
- **Popup UI**: Settings interface

All components share styling through a common CSS file.

---

## File-by-File Breakdown

### 1. `manifest.json` - Extension Configuration

**Purpose**: Defines the extension structure and permissions.

**Key Components**:
- **Manifest Version**: 3 (latest Chrome extension standard)
- **Permissions**:
  - `storage`: Save API key and dark mode preference
  - `activeTab`: Access current tab
  - `tabs`: Message content scripts from background
- **Host Permissions**:
  - `youtube.com/*`: Inject content scripts
  - `generativelanguage.googleapis.com/*`: Call Gemini API
- **Content Scripts**: Runs `content.js` and `styles.css` on YouTube pages
- **Background**: Service worker (`background.js`) for API calls
- **Action**: Popup UI (`popup.html`) when clicking extension icon

---

### 2. `content.js` - Main Content Script (699 lines)

**Purpose**: Injects buttons on YouTube and handles user interactions.

#### Initialization (`init()` function)
```javascript
- Waits for YouTube to load (1 second delay)
- Sets up MutationObserver to watch for new videos (infinite scroll)
- Monitors URL changes (YouTube is a SPA)
- Calls addButtonsToVideos() periodically
```

**Key Functions**:

**`addButtonsToVideos()`** - Video Detection:
- Finds video containers using multiple selectors:
  - `ytd-rich-item-renderer` (home page rich items)
  - `ytd-video-renderer` (standard video cards)
  - `ytd-grid-video-renderer` (grid layout)
  - `ytd-compact-video-renderer` (compact view)
- For each container:
  1. Checks if button already exists (prevents duplicates)
  2. Extracts video ID from URL
  3. Extracts video title (multiple strategies to avoid getting duration)
  4. Creates and inserts button

**Title Extraction** (Lines 92-142):
Uses 4 strategies to get actual title (not duration):
1. `#video-title` element
2. `h3` with video link
3. `aria-label` attribute (removes duration suffix)
4. `title` attribute

**`createSummaryButton()`** - Button Creation:
- Creates button element with:
  - Purple gradient styling
  - Video ID and title stored as data attributes
  - Click handler that prevents event bubbling

**`insertButton()`** - Button Insertion:
Tries 6 strategies to place button:
1. After metadata line
2. Inside details section
3. After thumbnail
4. After video title
5. Inside text container
6. Append to container (fallback)

**`handleSummaryClick()`** - Summary Request Flow:
1. Shows loading state on button
2. Gets API key from storage
3. Validates API key exists
4. Extracts video info (title, description)
5. Shows loading modal immediately
6. Sends message to background script
7. Updates modal when response arrives

**Modal Management**:

- **`showLoadingModal()`**:
  - Checks dark mode preference
  - Creates modal with loading animation
  - Prevents body scrolling
  - Sets up close handlers (button, outside click, Escape key)

- **`updateModalWithContent()`**:
  - Replaces loading content with formatted summary
  - Preserves dark mode setting

- **`showSummaryModal()`**:
  - Creates modal for errors or final content
  - Applies dark mode if enabled

**`formatSummary()`** - Markdown Formatting:
Converts markdown to HTML:
- Headers (`#` to `######`)
- Bold (`**text**` or `__text__`)
- Italic (`*text*` or `_text_`)
- Links (`[text](url)`)
- Code (inline `` `code` `` and blocks)
- Lists (ordered and unordered)
- Paragraphs

**`processInlineMarkdown()`**:
- Processes inline formatting (bold, italic, links, code)
- Escapes HTML to prevent XSS
- Uses regex with lookbehind/lookahead for accurate parsing

---

### 3. `background.js` - Service Worker (147 lines)

**Purpose**: Handles API calls to Gemini (isolated from page context).

#### Message Listener
```javascript
chrome.runtime.onMessage.addListener()
- Listens for "summarize" action
- Returns true to indicate async response
```

#### Main Handler (`handleSummarize()`)

**1. Input Validation**:
- Extracts video info from request
- Validates title (not a duration like "9:06")
- Returns error if invalid

**2. Prompt Construction**:
- Builds prompt with video URL, title, description
- Asks for: main topic, takeaways, target audience

**3. API Call with Retry Logic**:
- Tries `v1beta` first, then `v1`
- Up to 3 retries per version with exponential backoff (1s, 2s, 4s)
- Handles overload errors (503) gracefully
- Uses `gemini-2.5-flash` model only

**4. Response Handling**:
- Extracts text from `data.candidates[0].content.parts[0].text`
- Returns summary or error message

**Error Handling**:
- Catches API errors
- Returns user-friendly error messages
- Logs errors to console for debugging

---

### 4. `popup.html` - Settings UI (231 lines)

**Purpose**: User interface for extension settings.

**Structure**:
- **Header**: Extension title
- **Dark Mode Toggle**: Switch to enable/disable dark mode
- **API Key Input**: Text field for Gemini API key
- **Save Button**: Saves API key to storage
- **Status Message**: Shows success/error feedback

**Styling**:
- Embedded CSS for all styles
- Dark mode styles (lines 154-203)
- Toggle switch animation
- Responsive design (400px width)

---

### 5. `popup.js` - Popup Logic (66 lines)

**Purpose**: Handles popup interactions and storage.

**On Load**:
1. Loads saved API key from storage
2. Loads dark mode preference
3. Applies dark mode if enabled

**Dark Mode Toggle**:
- Click handler toggles dark mode
- Updates UI immediately
- Saves preference to Chrome storage
- Persists across sessions

**API Key Management**:
- Validates input (not empty)
- Saves to `chrome.storage.sync`
- Shows success/error status
- Auto-clears status after 2 seconds

---

### 6. `styles.css` - Shared Styles (421 lines)

**Purpose**: Styles for buttons and modals injected into YouTube.

#### Button Styles (`.yt-sum-summarize-btn`)
- Purple gradient background
- Hover effects (lift animation)
- Loading state (opacity change)
- Uses `!important` to override YouTube styles

#### Modal Styles (`.yt-sum-modal`)
- Full-screen overlay with backdrop
- Centered modal (max 900px width, 90vh height)
- Slide-up animation
- Scrollable body area
- Custom scrollbar styling

#### Dark Mode Styles
- Dark backgrounds (`#1e1e1e`, `#2d2d2d`)
- Light text colors (`#e0e0e0`)
- Adjusted borders and shadows
- Dark mode for all modal elements

#### Loading Animation
- Three bouncing dots
- Staggered animation delays
- Smooth scale/opacity transitions

---

## Data Flow

### User Journey:

1. **User opens YouTube home page**
   - `content.js` loads and runs `init()`
   - Detects video containers
   - Injects "📝 Summarize" buttons

2. **User clicks summarize button**
   - `handleSummaryClick()` executes
   - Validates API key
   - Shows loading modal
   - Sends message to `background.js`

3. **Background script processes request**
   - `background.js` receives message
   - Calls Gemini API with retry logic
   - Returns summary text

4. **Content script displays result**
   - Receives response
   - Updates modal with formatted summary
   - Removes loading animation

---

## Key Design Patterns

### 1. Multiple Fallback Strategies
- **Title extraction**: 4 strategies
- **Button insertion**: 6 strategies
- **API versions**: 2 versions (v1beta, v1)
- **Retry logic**: 3 attempts with backoff

### 2. Debouncing
- MutationObserver uses 500ms debounce
- Prevents excessive function calls

### 3. State Management
- Uses Chrome Storage API for persistence
- Stores: API key, dark mode preference
- Syncs across devices (if Chrome sync enabled)

### 4. Error Handling
- Try-catch blocks throughout
- User-friendly error messages
- Graceful degradation

### 5. Security
- HTML escaping (`escapeHtml()`)
- API key stored securely
- No XSS vulnerabilities

---

## Technical Details

### YouTube DOM Structure
- Uses custom elements (`ytd-rich-item-renderer`)
- Dynamic content loading (infinite scroll)
- SPA navigation (URL changes without full reload)

### Chrome Extension APIs Used
- `chrome.storage.sync`: Persistent storage
- `chrome.runtime.sendMessage`: Communication between scripts
- `chrome.runtime.onMessage`: Message listeners
- `chrome.tabs`: Tab management (for future features)

### API Integration
- **Gemini API**: v1beta/v1
- **Model**: `gemini-2.5-flash`
- **Endpoint**: `generateContent`
- **Request Format**: JSON with `contents` array

---

## File Dependencies

```
manifest.json
  ├── content.js (injected into YouTube)
  ├── styles.css (injected into YouTube)
  ├── background.js (service worker)
  └── popup.html
      └── popup.js (popup logic)

content.js
  ├── Uses styles.css (via manifest)
  ├── Communicates with background.js
  └── Reads from chrome.storage.sync

background.js
  ├── Receives messages from content.js
  └── Calls Gemini API

popup.js
  └── Reads/writes to chrome.storage.sync
```

---

## Code Structure Summary

The extension follows a clean architecture:
1. **UI Layer** (content.js): Handles user interactions
2. **Service Layer** (background.js): Handles API calls
3. **Settings Layer** (popup.js/html): Manages configuration
4. **Style Layer** (styles.css): Provides consistent styling

Each layer is independent and communicates through Chrome's messaging API.

---

## Extension Lifecycle

1. **Installation**: User loads extension in Chrome
2. **Initialization**: Content script runs on YouTube pages
3. **Button Injection**: Buttons appear on video thumbnails
4. **User Interaction**: Click triggers summary request
5. **API Call**: Background script calls Gemini API
6. **Response Display**: Modal shows formatted summary
7. **Settings Management**: Popup allows configuration

---

## Future Enhancement Ideas

- Add video transcript fetching for better summaries
- Support for multiple AI models
- Summary history/caching
- Export summaries to file
- Keyboard shortcuts
- Batch summarization
- Custom prompt templates


