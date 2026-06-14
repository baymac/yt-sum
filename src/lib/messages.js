// Message protocol shared by content script, background SW, and side panel.
//
//  HOME modal:    content ──GENERATE_SUMMARY──▶ background ──▶ Gemini ──▶ content renders modal
//  WATCH sidebar: content ──OPEN_SIDE_PANEL──▶ background (best-effort open)
//                 content ──GENERATE_SUMMARY──▶ background ──▶ Gemini
//                 content ──PUBLISH_SUMMARY──▶ background ──store+broadcast──▶ SUMMARY_READY ──▶ panel renders
//  PANEL trigger: panel ──(tabs.sendMessage)──▶ content SUMMARIZE_IN_SIDEBAR ──▶ (watch flow above)
//  PANEL restore: panel ──SUMMARY_STATE_REQUEST──▶ background ──▶ current stored state

export const MSG = {
	GENERATE_SUMMARY: "GENERATE_SUMMARY",
	PUBLISH_SUMMARY: "PUBLISH_SUMMARY",
	SUMMARY_READY: "SUMMARY_READY",
	SUMMARY_STATE_REQUEST: "SUMMARY_STATE_REQUEST",
	OPEN_SIDE_PANEL: "OPEN_SIDE_PANEL",
	SUMMARIZE_IN_SIDEBAR: "SUMMARIZE_IN_SIDEBAR",
	SUMMARY_PROGRESS: "SUMMARY_PROGRESS",
	CANCEL_SUMMARY: "CANCEL_SUMMARY",
};

// chrome.storage.session key holding the latest sidebar summary state:
//   { status:'loading'|'done'|'error', videoId, title, text?, mode?, error? }
export const SESSION_KEY = "currentSummary";
