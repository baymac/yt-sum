import { describe, it, expect, beforeEach } from "vitest";
import { openLoadingModal, showSummary, showError, closeModal } from "../../src/lib/modal.js";

const modalEl = () => document.getElementById("yt-sum-summary-modal");

describe("modal", () => {
	beforeEach(() => {
		document.body.innerHTML = "";
		document.body.className = "";
		closeModal();
	});

	it("opens a loading modal with title and locks scroll", () => {
		openLoadingModal("My Video");
		const m = modalEl();
		expect(m).toBeTruthy();
		expect(m.querySelector("h3").textContent).toBe("My Video");
		expect(m.querySelector(".yt-sum-loading-text")).toBeTruthy();
		expect(document.body.classList.contains("yt-sum-modal-open")).toBe(true);
	});

	it("applies dark mode when requested", () => {
		openLoadingModal("X", { darkMode: true });
		expect(modalEl().classList.contains("dark-mode")).toBe(true);
	});

	it("escapes the title (no XSS via video title)", () => {
		openLoadingModal("<img src=x onerror=alert(1)>");
		expect(modalEl().querySelector("h3").innerHTML).not.toContain("<img");
	});

	it("renders the summary, replacing the loader", () => {
		openLoadingModal("X");
		showSummary("# Heading\n\n- point one");
		const body = modalEl().querySelector(".yt-sum-modal-body");
		expect(body.querySelector(".yt-sum-loading-text")).toBeNull();
		expect(body.innerHTML).toContain("<h1>Heading</h1>");
		expect(body.innerHTML).toContain("<li>point one</li>");
	});

	it("adds a source note for the video-fallback mode", () => {
		openLoadingModal("X");
		showSummary("text", { mode: "video" });
		expect(modalEl().querySelector(".yt-sum-source-note")).toBeTruthy();
	});

	it("shows an error message", () => {
		openLoadingModal("X");
		showError("Something broke");
		expect(modalEl().querySelector(".yt-sum-error").textContent).toBe("Something broke");
	});

	it("closes via the close button and unlocks scroll", () => {
		openLoadingModal("X");
		modalEl().querySelector(".yt-sum-close-btn").click();
		expect(modalEl()).toBeNull();
		expect(document.body.classList.contains("yt-sum-modal-open")).toBe(false);
	});

	it("closes on Escape", () => {
		openLoadingModal("X");
		document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape" }));
		expect(modalEl()).toBeNull();
	});

	it("only keeps one modal at a time", () => {
		openLoadingModal("A");
		openLoadingModal("B");
		expect(document.querySelectorAll("#yt-sum-summary-modal").length).toBe(1);
		expect(modalEl().querySelector("h3").textContent).toBe("B");
	});

	it("closes when the user clicks the backdrop (outside the content area)", () => {
		openLoadingModal("X");
		const modal = modalEl();
		modal.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		expect(modalEl()).toBeNull();
	});

	it("ignores a stale response once a newer modal has opened", () => {
		const tokenA = openLoadingModal("A");
		const tokenB = openLoadingModal("B"); // user opened a second video
		showSummary("stale summary for A", { token: tokenA });
		const body = () => modalEl().querySelector(".yt-sum-modal-body").innerHTML;
		expect(body()).not.toContain("stale summary for A");
		showSummary("fresh summary for B", { token: tokenB });
		expect(body()).toContain("fresh summary for B");
	});
});
