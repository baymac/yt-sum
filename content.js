// Content script to inject summary buttons on YouTube home page

(function () {
	"use strict";

	// Configuration
	const BUTTON_CLASS = "yt-sum-summarize-btn";
	const SUMMARY_MODAL_ID = "yt-sum-summary-modal";
	const LOADING_CLASS = "yt-sum-loading";

	// Initialize when page loads
	function init() {
		// Wait for YouTube to fully load
		if (document.readyState === "loading") {
			document.addEventListener("DOMContentLoaded", () => {
				// Wait a bit for YouTube's JS to initialize
				setTimeout(addButtonsToVideos, 1000);
			});
		} else {
			// Page already loaded, wait a bit for YouTube to initialize
			setTimeout(addButtonsToVideos, 1000);
		}

		// Watch for dynamic content changes (YouTube uses infinite scroll)
		let timeoutId;
		const observer = new MutationObserver(() => {
			// Debounce to avoid too many calls
			clearTimeout(timeoutId);
			timeoutId = setTimeout(() => {
				addButtonsToVideos();
			}, 500);
		});

		// Start observing after a delay to ensure YouTube has loaded
		setTimeout(() => {
			if (document.body) {
				observer.observe(document.body, {
					childList: true,
					subtree: true,
				});
			}
		}, 2000);

		// Also try when navigation happens (YouTube is a SPA)
		let lastUrl = location.href;
		setInterval(() => {
			const currentUrl = location.href;
			if (currentUrl !== lastUrl) {
				lastUrl = currentUrl;
				setTimeout(addButtonsToVideos, 1500);
			}
		}, 1000);
	}

	// Find all video thumbnails on home page and add buttons
	function addButtonsToVideos() {
		// Try to find video containers first (more reliable)
		const containerSelectors = [
			"ytd-rich-item-renderer",
			"ytd-video-renderer",
			"ytd-grid-video-renderer",
			"ytd-compact-video-renderer",
			"ytd-playlist-video-renderer",
		];

		let processedContainers = new Set();
		let buttonsAdded = 0;

		// Find all video containers
		containerSelectors.forEach((selector) => {
			const containers = document.querySelectorAll(selector);
			containers.forEach((container) => {
				// Skip if already processed
				if (processedContainers.has(container)) return;

				// Check if button already exists
				if (container.querySelector(`.${BUTTON_CLASS}`)) {
					processedContainers.add(container);
					return;
				}

				// Find video link within container
				const videoLink = container.querySelector('a[href*="/watch?v="]');
				if (!videoLink) return;

				// Get video ID from URL
				const videoUrl = videoLink.href || videoLink.getAttribute("href");
				const videoId = extractVideoId(videoUrl);

				if (!videoId) return;

				// Get video title - be more specific to avoid getting duration
				let videoTitle = "Untitled Video";

				// Try multiple strategies to get the actual title
				// Strategy 1: Look for the title element with id="video-title" or aria-label
				const titleElement = container.querySelector(
					"#video-title, a#video-title-link",
				);
				if (titleElement) {
					const titleText =
						titleElement.textContent?.trim() ||
						titleElement.getAttribute("aria-label") ||
						titleElement.title;
					if (titleText && !titleText.match(/^\d+:\d+$/)) {
						// Not a duration like "9:06"
						videoTitle = titleText;
					}
				}

				// Strategy 2: If not found or is duration, look for h3 with link
				if (videoTitle === "Untitled Video" || videoTitle.match(/^\d+:\d+$/)) {
					const h3Link = container.querySelector(
						'h3 a[href*="/watch?v="], #video-title-link',
					);
					if (h3Link) {
						const titleText =
							h3Link.textContent?.trim() ||
							h3Link.getAttribute("aria-label") ||
							h3Link.title;
						if (titleText && !titleText.match(/^\d+:\d+$/)) {
							videoTitle = titleText;
						}
					}
				}

				// Strategy 3: Get from aria-label of the video link
				if (videoTitle === "Untitled Video" || videoTitle.match(/^\d+:\d+$/)) {
					const ariaLabel = videoLink.getAttribute("aria-label");
					if (ariaLabel && !ariaLabel.match(/^\d+:\d+$/)) {
						// Remove duration from aria-label if present (format: "Title by Channel 9:06")
						videoTitle = ariaLabel.replace(/\s+\d+:\d+\s*$/, "").trim();
					}
				}

				// Strategy 4: Get from title attribute
				if (videoTitle === "Untitled Video" || videoTitle.match(/^\d+:\d+$/)) {
					const titleAttr = videoLink.title || videoLink.getAttribute("title");
					if (titleAttr && !titleAttr.match(/^\d+:\d+$/)) {
						videoTitle = titleAttr;
					}
				}

				// Create and insert button
				const button = createSummaryButton(videoId, videoTitle);
				if (insertButton(container, button)) {
					processedContainers.add(container);
					buttonsAdded++;
				}
			});
		});

		// Debug logging (only log if buttons were added or if on first run)
		if (buttonsAdded > 0) {
			console.log(`[YT Summarizer] Added ${buttonsAdded} summarize button(s)`);
		}
	}

	// Extract video ID from YouTube URL
	function extractVideoId(url) {
		if (!url) return null;
		const match = url.match(
			/(?:youtube\.com\/watch\?v=|youtu\.be\/)([^&\n?#]+)/,
		);
		return match ? match[1] : null;
	}

	// Create summary button element
	function createSummaryButton(videoId, videoTitle) {
		const button = document.createElement("button");
		button.className = BUTTON_CLASS;
		button.innerHTML = "📝 Summarize";
		button.setAttribute("data-video-id", videoId);
		button.setAttribute("data-video-title", videoTitle);
		button.title = "Get AI summary of this video";

		button.addEventListener("click", (e) => {
			e.preventDefault();
			e.stopPropagation();
			handleSummaryClick(videoId, videoTitle);
		});

		return button;
	}

	// Insert button into video container
	function insertButton(container, button) {
		try {
			// Try multiple strategies to find the best insertion point

			// Strategy 1: Find metadata line and insert after title
			const metadataLine = container.querySelector(
				"#metadata-line, #meta, ytd-video-meta-block",
			);
			if (metadataLine) {
				metadataLine.parentNode.insertBefore(button, metadataLine.nextSibling);
				return true;
			}

			// Strategy 2: Find the details section
			const details = container.querySelector("#details, #dismissible");
			if (details) {
				const firstChild = details.firstElementChild;
				if (firstChild) {
					details.insertBefore(button, firstChild);
					return true;
				}
			}

			// Strategy 3: Find thumbnail and insert after
			const thumbnail = container.querySelector(
				"ytd-thumbnail, #thumbnail, a#thumbnail",
			);
			if (thumbnail && thumbnail.parentNode) {
				thumbnail.parentNode.insertBefore(button, thumbnail.nextSibling);
				return true;
			}

			// Strategy 4: Find video title and insert after
			const titleElement = container.querySelector(
				"#video-title, #video-title-link, h3",
			);
			if (titleElement && titleElement.parentNode) {
				titleElement.parentNode.insertBefore(button, titleElement.nextSibling);
				return true;
			}

			// Strategy 5: Find any text container
			const textContainer = container.querySelector(
				"#text-container, .text-container",
			);
			if (textContainer) {
				textContainer.appendChild(button);
				return true;
			}

			// Strategy 6: Last resort - append to container
			container.appendChild(button);
			return true;
		} catch (error) {
			console.error("Error inserting button:", error);
			return false;
		}
	}

	// Handle summary button click
	async function handleSummaryClick(videoId, videoTitle) {
		// Show loading state
		const button = document.querySelector(
			`.${BUTTON_CLASS}[data-video-id="${videoId}"]`,
		);
		if (button) {
			button.classList.add(LOADING_CLASS);
			button.disabled = true;
			button.innerHTML = "⏳ Summarizing...";
		}

		try {
			// Get API key from storage
			const result = await chrome.storage.sync.get(["geminiApiKey"]);
			const apiKey = result.geminiApiKey;

			if (!apiKey) {
				await showError(
					"Please set your Gemini API key in the extension popup.",
				);
				resetButton(button);
				return;
			}

			// Get video information - try to get better title from the button's data attribute
			const buttonTitle = button?.getAttribute("data-video-title");
			const finalTitle =
				buttonTitle &&
				buttonTitle !== "Untitled Video" &&
				!buttonTitle.match(/^\d+:\d+$/)
					? buttonTitle
					: videoTitle;

			// Try to get better title from the page if current one is still wrong
			const videoInfo = await getVideoInfo(videoId, finalTitle);

			// Construct the YouTube video URL
			const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;

			// Get display title
			const displayTitle =
				videoInfo.title && videoInfo.title !== "Untitled Video"
					? videoInfo.title
					: finalTitle && !finalTitle.match(/^\d+:\d+$/)
						? finalTitle
						: videoTitle;

			// Show modal immediately with loading state
			await showLoadingModal(displayTitle);

			// Request summary from background script
			chrome.runtime.sendMessage(
				{
					action: "summarize",
					videoId: videoId,
					videoUrl: videoUrl,
					videoTitle: videoInfo.title || finalTitle,
					videoInfo: videoInfo,
					apiKey: apiKey,
				},
				async (response) => {
					if (response?.error) {
						await showError(response.error);
					} else if (response?.text) {
						// Update modal with the full response
						await updateModalWithContent(response.text);
					}
					resetButton(button);
				},
			);
		} catch (error) {
			console.error("Error getting summary:", error);
			await showError("Failed to get summary. Please try again.");
			resetButton(button);
		}
	}

	// Get video information (title, description, etc.)
	async function getVideoInfo(videoId, fallbackTitle = "") {
		try {
			// Try to find the video container on the page
			const videoLink = document.querySelector(
				`a[href*="/watch?v=${videoId}"]`,
			);
			let title = fallbackTitle;
			let description = "";

			if (videoLink) {
				const container = videoLink.closest(
					"ytd-rich-item-renderer, ytd-video-renderer, ytd-grid-video-renderer",
				);

				if (container) {
					// Try to get title from various sources
					const titleEl = container.querySelector(
						"#video-title, a#video-title-link",
					);
					if (titleEl) {
						const titleText =
							titleEl.textContent?.trim() ||
							titleEl.getAttribute("aria-label") ||
							titleEl.title;
						if (titleText && !titleText.match(/^\d+:\d+$/)) {
							title = titleText;
						}
					}

					// Try to get description if available (usually in metadata)
					const descEl = container.querySelector(
						"#description-text, #metadata-line, ytd-video-meta-block #metadata-line",
					);
					if (descEl) {
						description = descEl.textContent?.trim() || "";
					}
				}

				// Also try aria-label which often has full info
				const ariaLabel = videoLink.getAttribute("aria-label");
				if (ariaLabel && !title.match(/^\d+:\d+$/)) {
					// aria-label format: "Title by Channel 9:06" - extract just the title part
					const match = ariaLabel.match(/^(.+?)\s+by\s+/);
					if (match && match[1]) {
						title = match[1].trim();
					} else if (!ariaLabel.match(/^\d+:\d+$/)) {
						// Remove duration if present
						title = ariaLabel.replace(/\s+\d+:\d+\s*$/, "").trim();
					}
				}
			}

			return {
				title: title || fallbackTitle || "Untitled Video",
				description: description,
			};
		} catch (error) {
			console.error("Error getting video info:", error);
			return {
				title: fallbackTitle || "Untitled Video",
				description: "",
			};
		}
	}

	// Reset button state
	function resetButton(button) {
		if (button) {
			button.classList.remove(LOADING_CLASS);
			button.disabled = false;
			button.innerHTML = "📝 Summarize";
		}
	}

	// Show error message
	async function showError(message) {
		await showSummaryModal(
			"Error",
			`<div class="yt-sum-error">${message}</div>`,
			true,
		);
	}

	// Show loading modal immediately
	async function showLoadingModal(title) {
		// Remove existing modal if any
		const existingModal = document.getElementById(SUMMARY_MODAL_ID);
		if (existingModal) {
			closeModal(existingModal);
		}

		// Check dark mode preference
		const result = await chrome.storage.sync.get(["darkMode"]);
		const isDarkMode = result.darkMode || false;

		// Store current scroll position
		const scrollY = window.scrollY;

		// Create modal
		const modal = document.createElement("div");
		modal.id = SUMMARY_MODAL_ID;
		modal.className = isDarkMode ? "yt-sum-modal dark-mode" : "yt-sum-modal";

		modal.innerHTML = `
      <div class="yt-sum-modal-content">
        <div class="yt-sum-modal-header">
          <h3>${escapeHtml(title)}</h3>
          <button class="yt-sum-close-btn" aria-label="Close">×</button>
        </div>
        <div class="yt-sum-modal-body">
          <div class="yt-sum-loading-container">
            <div class="yt-sum-streaming-loader">
              <span class="yt-sum-bounce-dot"></span>
              <span class="yt-sum-bounce-dot"></span>
              <span class="yt-sum-bounce-dot"></span>
            </div>
            <p class="yt-sum-loading-text">Generating summary...</p>
          </div>
        </div>
      </div>
    `;

		document.body.appendChild(modal);

		// Prevent body scrolling
		document.body.classList.add("yt-sum-modal-open");
		document.body.style.top = `-${scrollY}px`;

		// Close button handler
		const closeBtn = modal.querySelector(".yt-sum-close-btn");
		closeBtn.addEventListener("click", () => closeModal(modal));

		// Close on outside click
		modal.addEventListener("click", (e) => {
			if (e.target === modal) {
				closeModal(modal);
			}
		});

		// Close on Escape key
		const escapeHandler = (e) => {
			if (e.key === "Escape") {
				closeModal(modal);
				document.removeEventListener("keydown", escapeHandler);
			}
		};
		document.addEventListener("keydown", escapeHandler);
	}

	// Update modal with content when response arrives
	async function updateModalWithContent(text) {
		const modal = document.getElementById(SUMMARY_MODAL_ID);
		if (!modal) return;

		// Check if dark mode is enabled (preserve it)
		const result = await chrome.storage.sync.get(["darkMode"]);
		const isDarkMode = result.darkMode || false;

		// Ensure dark mode class is applied if needed
		if (isDarkMode && !modal.classList.contains("dark-mode")) {
			modal.classList.add("dark-mode");
		} else if (!isDarkMode && modal.classList.contains("dark-mode")) {
			modal.classList.remove("dark-mode");
		}

		const bodyEl = modal.querySelector(".yt-sum-modal-body");
		if (bodyEl) {
			// Remove loading content and add formatted summary
			bodyEl.innerHTML = formatSummary(text);
		}
	}

	// Close modal function
	function closeModal(modalElement) {
		// Restore body scrolling
		document.body.classList.remove("yt-sum-modal-open");
		const top = document.body.style.top;
		document.body.style.top = "";
		if (top) {
			window.scrollTo(0, parseInt(top || "0") * -1);
		}
		modalElement.remove();
	}

	// Show summary modal
	async function showSummaryModal(title, content, isError = false) {
		// Remove existing modal if any
		const existingModal = document.getElementById(SUMMARY_MODAL_ID);
		if (existingModal) {
			closeModal(existingModal);
		}

		// Check dark mode preference
		const result = await chrome.storage.sync.get(["darkMode"]);
		const isDarkMode = result.darkMode || false;

		// Store current scroll position
		const scrollY = window.scrollY;

		// Create modal
		const modal = document.createElement("div");
		modal.id = SUMMARY_MODAL_ID;
		let modalClass = isError
			? "yt-sum-modal yt-sum-error-modal"
			: "yt-sum-modal";
		if (isDarkMode) {
			modalClass += " dark-mode";
		}
		modal.className = modalClass;

		modal.innerHTML = `
      <div class="yt-sum-modal-content">
        <div class="yt-sum-modal-header">
          <h3>${escapeHtml(title)}</h3>
          <button class="yt-sum-close-btn" aria-label="Close">×</button>
        </div>
        <div class="yt-sum-modal-body">
          ${isError ? content : formatSummary(content)}
        </div>
      </div>
    `;

		document.body.appendChild(modal);

		// Prevent body scrolling
		document.body.classList.add("yt-sum-modal-open");
		document.body.style.top = `-${scrollY}px`;

		// Close button handler
		const closeBtn = modal.querySelector(".yt-sum-close-btn");
		closeBtn.addEventListener("click", () => closeModal(modal));

		// Close on outside click
		modal.addEventListener("click", (e) => {
			if (e.target === modal) {
				closeModal(modal);
			}
		});

		// Close on Escape key
		const escapeHandler = (e) => {
			if (e.key === "Escape") {
				closeModal(modal);
				document.removeEventListener("keydown", escapeHandler);
			}
		};
		document.addEventListener("keydown", escapeHandler);
	}

	// Format summary text with markdown support
	function formatSummary(text) {
		// Convert markdown-like formatting to HTML
		const lines = text.split("\n");
		let html = "";
		let inList = false;
		let listType = null;

		// Process inline markdown (bold, italic, code, links)
		function processInlineMarkdown(str) {
			// Escape HTML first
			str = escapeHtml(str);

			// Process links [text](url)
			str = str.replace(
				/\[([^\]]+)\]\(([^)]+)\)/g,
				'<a href="$2" target="_blank" rel="noopener">$1</a>',
			);

			// Process bold **text** or __text__ (do this before italic to avoid conflicts)
			str = str.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
			str = str.replace(/__([^_]+)__/g, "<strong>$1</strong>");

			// Process inline code `code` (before italic to avoid conflicts)
			str = str.replace(/`([^`]+)`/g, "<code>$1</code>");

			// Process italic *text* or _text_
			// Since we already processed ** for bold, remaining single * are italic
			// Match *text* where * is not part of **
			str = str.replace(/(?<!\*)\*([^*\n]+?)\*(?!\*)/g, "<em>$1</em>");
			str = str.replace(/(?<!_)_([^_\n]+?)_(?!_)/g, "<em>$1</em>");

			return str;
		}

		lines.forEach((line) => {
			const trimmedLine = line.trim();

			// Empty line - close list if open
			if (!trimmedLine) {
				if (inList) {
					html += `</${listType}>`;
					inList = false;
					listType = null;
				}
				return;
			}

			// Headers
			if (trimmedLine.match(/^#{1,6}\s/)) {
				if (inList) {
					html += `</${listType}>`;
					inList = false;
					listType = null;
				}
				const level = trimmedLine.match(/^#+/)[0].length;
				const content = trimmedLine.replace(/^#+\s*/, "");
				html += `<h${Math.min(level, 6)}>${processInlineMarkdown(content)}</h${Math.min(level, 6)}>`;
			}
			// Unordered list items
			else if (trimmedLine.match(/^[-*]\s/)) {
				if (!inList || listType !== "ul") {
					if (inList) {
						html += `</${listType}>`;
					}
					html += "<ul>";
					inList = true;
					listType = "ul";
				}
				const content = trimmedLine.replace(/^[-*]\s+/, "");
				html += `<li>${processInlineMarkdown(content)}</li>`;
			}
			// Ordered list items
			else if (trimmedLine.match(/^\d+\.\s/)) {
				if (!inList || listType !== "ol") {
					if (inList) {
						html += `</${listType}>`;
					}
					html += "<ol>";
					inList = true;
					listType = "ol";
				}
				const content = trimmedLine.replace(/^\d+\.\s+/, "");
				html += `<li>${processInlineMarkdown(content)}</li>`;
			}
			// Code blocks
			else if (trimmedLine.startsWith("```")) {
				if (inList) {
					html += `</${listType}>`;
					inList = false;
					listType = null;
				}
				// This is a simple implementation - for full code blocks, you'd need to track state
				html += `<pre><code>${escapeHtml(trimmedLine.replace(/```/g, ""))}</code></pre>`;
			}
			// Regular paragraphs
			else {
				if (inList) {
					html += `</${listType}>`;
					inList = false;
					listType = null;
				}
				html += `<p>${processInlineMarkdown(trimmedLine)}</p>`;
			}
		});

		// Close any open list
		if (inList) {
			html += `</${listType}>`;
		}

		return html || `<p>${processInlineMarkdown(text)}</p>`;
	}

	// Escape HTML
	function escapeHtml(text) {
		const div = document.createElement("div");
		div.textContent = text;
		return div.innerHTML;
	}

	// Start the extension
	console.log("[YT Summarizer] Extension loaded, initializing...");
	init();
})();
