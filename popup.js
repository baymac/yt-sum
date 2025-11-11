// Popup script for settings

document.addEventListener("DOMContentLoaded", async () => {
	const apiKeyInput = document.getElementById("apiKey");
	const saveBtn = document.getElementById("saveBtn");
	const statusDiv = document.getElementById("status");
	const darkModeToggle = document.getElementById("darkModeToggle");

	// Load saved settings
	const result = await chrome.storage.sync.get(["geminiApiKey", "darkMode"]);
	if (result.geminiApiKey) {
		apiKeyInput.value = result.geminiApiKey;
	}

	// Load dark mode preference
	if (result.darkMode) {
		document.body.classList.add("dark-mode");
		darkModeToggle.classList.add("active");
	}

	// Dark mode toggle
	darkModeToggle.addEventListener("click", async () => {
		const isActive = darkModeToggle.classList.contains("active");

		if (isActive) {
			darkModeToggle.classList.remove("active");
			document.body.classList.remove("dark-mode");
			await chrome.storage.sync.set({ darkMode: false });
		} else {
			darkModeToggle.classList.add("active");
			document.body.classList.add("dark-mode");
			await chrome.storage.sync.set({ darkMode: true });
		}
	});

	// Save API key
	saveBtn.addEventListener("click", async () => {
		const apiKey = apiKeyInput.value.trim();

		if (!apiKey) {
			showStatus("Please enter an API key", "error");
			return;
		}

		try {
			await chrome.storage.sync.set({ geminiApiKey: apiKey });
			showStatus("API key saved successfully!", "success");

			// Clear status after 2 seconds
			setTimeout(() => {
				statusDiv.className = "status";
			}, 2000);
		} catch (error) {
			console.error("Error saving API key:", error);
			showStatus("Failed to save API key. Please try again.", "error");
		}
	});

	function showStatus(message, type) {
		statusDiv.textContent = message;
		statusDiv.className = `status ${type}`;
	}
});
