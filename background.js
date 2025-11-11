// Background service worker for handling API calls

// Ensure the side panel uses our settings UI
async function setupSidePanel() {
	try {
		if (chrome?.sidePanel?.setOptions) {
			await chrome.sidePanel.setOptions({
				path: "popup.html",
				enabled: true,
			});
		}
		// Let Chrome open the side panel on action click automatically
		if (chrome?.sidePanel?.setPanelBehavior) {
			await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
		}
	} catch (err) {
		console.error("Error setting up side panel:", err);
	}
}

// Set up side panel on install and startup
chrome.runtime.onInstalled.addListener(() => {
	setupSidePanel();
});

chrome.runtime.onStartup.addListener(() => {
	setupSidePanel();
});

// Optional: ensure per-tab options are set when icon is clicked (opening is handled by Chrome)
chrome.action.onClicked.addListener((tab) => {
	try {
		if (chrome?.sidePanel?.setOptions) {
			chrome.sidePanel
				.setOptions({
					tabId: tab.id,
					path: "popup.html",
					enabled: true,
				})
				.catch((err) => {
					console.error("Error setting side panel options for tab:", err);
				});
		}
	} catch (e) {
		console.error("Unexpected error in action.onClicked:", e);
	}
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
	if (request.action === "summarize") {
		handleSummarize(request, sendResponse);
		return true; // Indicates we will send a response asynchronously
	}
});

async function handleSummarize(request, sendResponse) {
	try {
		const { videoUrl, videoTitle, videoInfo, apiKey } = request;

		// Prepare prompt for Gemini
		// Use the title from videoInfo if available, otherwise use videoTitle
		const actualTitle =
			videoInfo.title && videoInfo.title !== "Untitled Video"
				? videoInfo.title
				: videoTitle;

		// Validate title is not a duration
		const isValidTitle =
			actualTitle && !actualTitle.match(/^\d+:\d+$/) && actualTitle.length > 3;

		if (!isValidTitle) {
			sendResponse({
				error:
					"Unable to extract video title. Please try clicking the button again or refresh the page.",
			});
			return;
		}

		const prompt = `Please watch and summarize this YouTube video:

Video URL: ${videoUrl}
Title: ${actualTitle}
${videoInfo.description ? `Description: ${videoInfo.description}` : ""}

Please watch the video at the URL above and provide a comprehensive summary including:
1. Main topic and key points discussed in the video
2. Important takeaways and insights
3. Who would benefit from watching this video

Provide a detailed summary based on the actual video content, not just the title. Keep it concise (2-3 paragraphs) and informative.`;

		// Use Gemini 2.5 Flash only
		// Try both v1 and v1beta API versions
		const apiVersions = ["v1beta", "v1"];
		let lastError = null;
		let summaryText = null;

		for (const version of apiVersions) {
			for (let attempt = 0; attempt < 3; attempt++) {
				try {
					if (attempt > 0) {
						// Exponential backoff: 1s, 2s, 4s
						const delay = Math.pow(2, attempt - 1) * 1000;
						await new Promise((resolve) => setTimeout(resolve, delay));
					}

					const response = await fetch(
						`https://generativelanguage.googleapis.com/${version}/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
						{
							method: "POST",
							headers: {
								"Content-Type": "application/json",
							},
							body: JSON.stringify({
								contents: [
									{
										parts: [
											{
												text: prompt,
											},
										],
									},
								],
							}),
						},
					);

					if (!response.ok) {
						const errorData = await response.json().catch(() => ({}));
						const errorMessage =
							errorData.error?.message || `API error: ${response.statusText}`;

						// If model is overloaded, try next model or retry
						if (
							errorMessage.includes("overloaded") ||
							errorMessage.includes("503") ||
							response.status === 503
						) {
							lastError = new Error(errorMessage);
							// Continue to next attempt or next model
							continue;
						}

						// For other errors, throw immediately
						throw new Error(errorMessage);
					}

					const data = await response.json();

					// Extract text from response
					summaryText =
						data.candidates?.[0]?.content?.parts?.[0]?.text ||
						"Unable to generate summary. Please try again.";

					// Success! Break out of all loops
					break;
				} catch (error) {
					lastError = error;
					// If it's not an overload error, try next API version
					if (
						!error.message.includes("overloaded") &&
						!error.message.includes("503")
					) {
						// For non-overload errors, try next API version
						break;
					}
				}
			}

			// If we got a successful response, break out of API version loop
			if (summaryText) {
				break;
			}
		}

		// If all models failed, throw the last error
		if (!summaryText) {
			throw (
				lastError || new Error("All models failed. Please try again later.")
			);
		}

		sendResponse({ text: summaryText });
	} catch (error) {
		console.error("Error in summarize:", error);
		sendResponse({
			error:
				error.message ||
				"Failed to get summary. Please check your API key and try again.",
		});
	}
}
