// Message protocol shared by content script, background SW, and side panel.
//
//  WATCH sidebar: content ──OPEN_SIDE_PANEL──▶ background (best-effort open)
//                 content ──GENERATE_SUMMARY──▶ background ──▶ Gemini
//                 content ──PUBLISH_SUMMARY──▶ background ──store(per tab)──▶ if active ──▶ SUMMARY_READY ──▶ panel
//  PAGE (any site): background ──scripting.executeScript──▶ page text ──▶ page_ready state (per tab)
//  TAB FOCUS:     tabs.onActivated / windows.onFocusChanged ──▶ background broadcasts the active tab's cached state
//  PANEL restore: panel ──SUMMARY_STATE_REQUEST──▶ background ──▶ active tab's stored state
//  CHAT cache:    panel ──SAVE_CHAT──▶ background stores {history,bubbles,summaryContext} on the tab's state
//  CHAT stream:   panel ──CHAT_MESSAGE {sourceKey,tabId,bubbles}──▶ background ──CHAT_PROGRESS──▶ panel
//                 The background owns the stream: it survives tab switches and navigation. On finish it
//                 caches the chat by sourceKey, patches the tab's state, and broadcasts CHAT_DONE. States
//                 broadcast mid-stream carry pendingChat {history,bubbles,accumulated} so a returning
//                 panel can re-attach to the running stream.

export const MSG = {
	GENERATE_SUMMARY: "GENERATE_SUMMARY",
	PUBLISH_SUMMARY: "PUBLISH_SUMMARY",
	SUMMARY_READY: "SUMMARY_READY",
	SUMMARY_STATE_REQUEST: "SUMMARY_STATE_REQUEST",
	OPEN_SIDE_PANEL: "OPEN_SIDE_PANEL",
	SUMMARIZE_IN_SIDEBAR: "SUMMARIZE_IN_SIDEBAR",
	SUMMARY_PROGRESS: "SUMMARY_PROGRESS",
	CANCEL_SUMMARY: "CANCEL_SUMMARY",
	CHAT_MESSAGE: "CHAT_MESSAGE",
	CHAT_PROGRESS: "CHAT_PROGRESS",
	CHAT_DONE: "CHAT_DONE",
	CHAT_STOP: "CHAT_STOP",
	SAVE_CHAT: "SAVE_CHAT",
};

// Legacy single-state key (pre per-tab). Retained for compatibility.
export const SESSION_KEY = "currentSummary";

// chrome.storage.session key holding the per-tab state map: { [tabId]: state }.
// Each state: { tabId, url, kind:'youtube'|'youtube-other'|'page'|'unsupported',
//   status:'idle'|'loading'|'loading-page'|'transcript_ready'|'page_ready'|'streaming'|'done'|'error',
//   title, videoId?, transcript?, pageText?, mode?, text?, error?, hint?,
//   chat?: { history:[{role,text}], bubbles:[{role,text,displayType?}], summaryContext:{title,summary} } }
export const TAB_STATES_KEY = "tabStates";
