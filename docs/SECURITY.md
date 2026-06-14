# Security Documentation - XSS Prevention

> v2 note: code line references below are historical. The escaping logic now lives in
> `src/lib/markdown.js` (`escapeHtml`, `formatSummary`). Two items previously flagged as
> "could be enhanced" are now **implemented**:
> - **Link URL sanitization** — `sanitizeUrl()` blocks `javascript:`/`data:`/`vbscript:`
>   and relative/protocol-relative URLs, allowing only `http(s)`. Covered by tests.
> - **API key isolation** — the Gemini key is read only in the background service worker
>   (`src/background.js`); it is never passed into page or content-script context.

## How XSS is Prevented

### 1. HTML Escaping Function

The extension uses an `escapeHtml()` function to sanitize all user input and API responses:

```javascript
function escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text;  // textContent automatically escapes HTML
    return div.innerHTML;    // Returns escaped HTML entities
}
```

**How it works**:
- `textContent` property automatically converts special characters to HTML entities
- `<` becomes `&lt;`
- `>` becomes `&gt;`
- `&` becomes `&amp;`
- `"` becomes `&quot;`
- `'` becomes `&#39;`

### 2. Where Escaping is Applied

#### Video Titles (User Input from YouTube DOM)
```javascript
// src/lib/modal.js
<h3>${escapeHtml(title)}</h3>
```
- All video titles are escaped before insertion
- Prevents malicious titles from executing scripts

#### API Response Content
```javascript
// src/lib/markdown.js — processInlineMarkdown()
str = escapeHtml(str);  // Escape FIRST before processing
```
- All API response text is escaped before markdown processing
- Prevents malicious summaries from executing scripts

#### Error Messages
```javascript
// src/lib/modal.js
showSummaryModal("Error", `<div class="yt-sum-error">${message}</div>`, true);
```
- Error messages are wrapped in divs (safe)
- Error content comes from controlled sources

### 3. Safe HTML Insertion Points

#### Static Content (No User Input)
```javascript
// src/content.js, src/lib/modal.js
button.innerHTML = "📝 Summarize";  // Static string - safe
button.innerHTML = "⏳ Summarizing...";  // Static string - safe
```

#### Hardcoded HTML Structure
```javascript
// Lines 428-445, 535-543
modal.innerHTML = `...`;  // Template with escaped variables
```
- Only uses `innerHTML` for templates
- All dynamic content is escaped via `escapeHtml()`

### 4. Markdown Processing Security

The markdown formatter has a security-first approach:

```javascript
function processInlineMarkdown(str) {
    str = escapeHtml(str);  // ESCAPE FIRST

    // Then process markdown (already escaped, so safe)
    str = str.replace(/\[([^\]]+)\]\(([^)]+)\)/g,
        '<a href="$2" target="_blank" rel="noopener">$1</a>');
    // ... more replacements
}
```

**Security Flow**:
1. **Escape first**: All HTML special characters are converted to entities
2. **Then process**: Regex replacements work on escaped text
3. **Result**: Safe HTML with markdown formatting

### 5. Security Concerns & Mitigations

#### ✅ Link URL Validation

**Implementation** (`src/lib/markdown.js`):
```javascript
function sanitizeUrl(url) {
    // Block dangerous protocols
    if (/^(javascript|data|vbscript):/i.test(url)) return '#';
    // Block relative and protocol-relative URLs — only http(s) allowed
    if (!/^https?:\/\//i.test(url)) return '#';
    return url;
}
```

Links extracted from markdown are passed through `sanitizeUrl()` before insertion into `href`, blocking `javascript:`, `data:`, `vbscript:`, and protocol-relative URLs. Covered by unit tests in `tests/unit/markdown.test.js`.

**Additional mitigations:**
- `rel="noopener"` prevents window.opener attacks
- `target="_blank"` opens in new tab (isolated)

#### ✅ Safe Text Extraction

**YouTube DOM Reading**:
```javascript
titleElement.textContent?.trim()  // textContent is safe (read-only)
```
- Uses `textContent` (not `innerHTML`) to read from YouTube
- `textContent` returns plain text, no HTML parsing

### 6. Content Security Policy (CSP)

The extension inherits YouTube's CSP, which:
- Prevents inline script execution
- Restricts external resource loading
- Limits `eval()` usage

### 7. Attack Vectors Prevented

#### ✅ Script Injection
- All user input is escaped
- No `eval()` or `Function()` calls
- No dynamic script creation

#### ✅ HTML Injection
- All dynamic content uses `escapeHtml()`
- Template literals only contain escaped variables

#### ✅ Event Handler Injection
- No `onclick` or other event handlers in templates
- Event listeners attached via `addEventListener()` (safe)

#### ✅ Attribute Injection
- All attributes use escaped values
- No user-controlled attributes

### 8. Security Best Practices Followed

1. **Input Validation**: All titles validated (not duration)
2. **Output Encoding**: All output escaped via `escapeHtml()`
3. **Principle of Least Privilege**: Minimal permissions requested
4. **No Eval**: No use of `eval()` or similar functions
5. **Safe DOM Manipulation**: Uses `textContent` for reading, escaped `innerHTML` for writing

### 9. Security Checklist

- ✅ All user input escaped
- ✅ All API responses escaped
- ✅ No inline event handlers
- ✅ No eval() usage
- ✅ Safe DOM reading (textContent)
- ✅ Safe DOM writing (escaped innerHTML)
- ✅ Link URL validation via `sanitizeUrl()` (blocks javascript:, data:, vbscript:)
- ✅ Sender origin validated in background message handler (`chrome.runtime.id`)
- ✅ YouTube domain validated for Gemini video-mode requests

### 10. Testing for XSS

To verify XSS protection, try these test cases:

1. **Malicious Title**: Video with title `<script>alert('XSS')</script>`
   - Should display as plain text, not execute

2. **Malicious Summary**: API returns `<img src=x onerror=alert('XSS')>`
   - Should be escaped and display as text

3. **JavaScript URL**: Link with `javascript:alert('XSS')`
   - Blocked by `sanitizeUrl()` — returns `#` for any non-http(s) protocol

### Conclusion

The extension has **strong XSS protection** through:
- Comprehensive HTML escaping in `src/lib/markdown.js`
- `sanitizeUrl()` blocking dangerous protocols in links
- Safe DOM manipulation practices (textContent reads, escaped innerHTML writes)
- No eval or dynamic script execution
- Escaping before markdown processing
- Sender origin validation in the background message handler
- YouTube domain enforcement for Gemini video-mode requests

