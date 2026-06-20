/**
 * Claude Annotate - Background Service Worker
 * 
 * Connects to native messaging host and forwards messages between
 * the native host (Pi) and content scripts.
 */

let nativePort = null;
let pendingPing = null;
let lastNativeDisconnectError = "";
const requestTabs = new Map();

function getRequestId(msg) {
  return typeof msg.requestId === "number" ? msg.requestId : (typeof msg.id === "number" ? msg.id : null);
}

function isRestrictedUrl(url) {
  if (!url) return true;
  return /^(chrome|chrome-extension|edge|about|devtools|view-source):/.test(url);
}

function resolvePendingPing(result) {
  if (!pendingPing) return;
  clearTimeout(pendingPing.timeoutId);
  pendingPing.resolve(result);
  pendingPing = null;
}

function pingNative() {
  if (!nativePort) {
    return Promise.resolve({
      connected: false,
      error: lastNativeDisconnectError || "Native host not connected",
    });
  }

  if (pendingPing) {
    return pendingPing.promise;
  }

  let resolvePing;
  const promise = new Promise((resolve) => {
    resolvePing = resolve;
  });

  const timeoutId = setTimeout(() => {
    if (!pendingPing || pendingPing.promise !== promise) return;
    pendingPing = null;
    resolvePing({ connected: false, error: "Timeout - native host not responding" });
  }, 3000);

  pendingPing = { promise, resolve: resolvePing, timeoutId };

  try {
    nativePort.postMessage({ type: "PING" });
  } catch (err) {
    clearTimeout(timeoutId);
    pendingPing = null;
    resolvePing({
      connected: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return promise;
}

function sendToNative(msg) {
  if (!nativePort) {
    console.error("[claude-annotate] Cannot send to native host - not connected");
    return;
  }
  try {
    nativePort.postMessage(msg);
  } catch (err) {
    console.error("[claude-annotate] Failed to send to native host:", err);
  }
}

// Send message to content script, injecting it first if needed
async function sendToContentScript(tabId, msg) {
  try {
    await chrome.tabs.sendMessage(tabId, msg);
  } catch (err) {
    console.log("[claude-annotate] Content script not found, injecting...");
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["content.js"],
      });
      await new Promise(r => setTimeout(r, 100));
      await chrome.tabs.sendMessage(tabId, msg);
    } catch (injectErr) {
      console.error("[claude-annotate] Failed to inject:", injectErr.message);
      const requestId = getRequestId(msg);
      if (requestId) {
        requestTabs.delete(requestId);
        sendToNative({ type: "CANCEL", requestId, reason: `Cannot inject into tab: ${injectErr.message}` });
      }
    }
  }
}

// Wait for a tab to finish loading, then inject content script
function injectAfterLoad(tabId, msg, requestId) {
  let timeoutId = null;
  const listener = (updatedTabId, info) => {
    if (updatedTabId === tabId && info.status === "complete") {
      if (timeoutId) clearTimeout(timeoutId);
      chrome.tabs.onUpdated.removeListener(listener);
      setTimeout(() => {
        if (requestId) requestTabs.set(requestId, tabId);
        sendToContentScript(tabId, msg);
      }, 150);
    }
  };
  chrome.tabs.onUpdated.addListener(listener);

  timeoutId = setTimeout(() => {
    chrome.tabs.onUpdated.removeListener(listener);
    console.log("[claude-annotate] Navigation timeout - listener removed");
    if (requestId) {
      requestTabs.delete(requestId);
      sendToNative({ type: "CANCEL", requestId, reason: "navigation_timeout" });
    }
  }, 30000);
}

// Toggle annotation picker on active tab (used by popup + keyboard shortcut)
async function togglePicker() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || isRestrictedUrl(tab.url)) {
      console.log("[claude-annotate] Cannot toggle picker: no valid tab");
      return;
    }
    await sendToContentScript(tab.id, { type: "TOGGLE_PICKER" });
  } catch (err) {
    console.error("[claude-annotate] Toggle picker failed:", err);
  }
}

function connectNative() {
  if (nativePort) return;

  console.log("[claude-annotate] Connecting to native host...");
  const port = chrome.runtime.connectNative("com.claude.annotate");
  nativePort = port;
  
  port.onMessage.addListener((msg) => {
    if (msg?.type === "PONG") {
      lastNativeDisconnectError = "";
      resolvePendingPing({ connected: true });
      return;
    }

    console.log("[claude-annotate] From native host:", msg);
    
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs[0]?.id) {
        console.log("[claude-annotate] No active tab found");
        const requestId = getRequestId(msg);
        if (requestId) {
          sendToNative({ type: "CANCEL", requestId, reason: "No active browser tab found" });
        }
        return;
      }
      
      const requestId = getRequestId(msg);
      const tabId = requestId && requestTabs.has(requestId) ? requestTabs.get(requestId) : tabs[0].id;
      const currentUrl = tabs[0].url;
      
      if (msg.type === "START_ANNOTATION") {
        const restricted = isRestrictedUrl(currentUrl);

        if (msg.url && (restricted || currentUrl !== msg.url)) {
          if (restricted) {
            console.log("[claude-annotate] Opening new tab:", msg.url);
            chrome.tabs.create({ url: msg.url }, (tab) => {
              if (chrome.runtime.lastError) {
                console.error("[claude-annotate] Failed to create tab:", chrome.runtime.lastError.message);
                sendToNative({ type: "CANCEL", requestId, reason: chrome.runtime.lastError.message });
                return;
              }
              injectAfterLoad(tab.id, msg, requestId);
            });
          } else {
            console.log("[claude-annotate] Navigating to:", msg.url);
            chrome.tabs.update(tabId, { url: msg.url }, (tab) => {
              if (chrome.runtime.lastError) {
                console.error("[claude-annotate] Failed to navigate:", chrome.runtime.lastError.message);
                sendToNative({ type: "CANCEL", requestId, reason: chrome.runtime.lastError.message });
                return;
              }
              injectAfterLoad(tab.id, msg, requestId);
            });
          }
        } else if (restricted) {
          console.log("[claude-annotate] Cannot annotate restricted tab:", currentUrl);
          if (requestId) {
            sendToNative({ type: "CANCEL", requestId, reason: "Current tab cannot be annotated (restricted URL). Provide a URL." });
          }
        } else {
          console.log("[claude-annotate] Activating on current tab:", currentUrl);
          if (requestId) requestTabs.set(requestId, tabId);
          sendToContentScript(tabId, msg);
        }
      } else {
        sendToContentScript(tabId, msg);
      }
    });
  });
  
  port.onDisconnect.addListener(() => {
    const error = chrome.runtime.lastError?.message || "Native host disconnected unexpectedly";
    console.log("[claude-annotate] Native host disconnected", error);
    lastNativeDisconnectError = error;
    resolvePendingPing({ connected: false, error });
    if (nativePort === port) {
      nativePort = null;
    }
    setTimeout(connectNative, 2000);
  });
}

// Handle messages from content script and popup
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  console.log("[claude-annotate] Message:", msg.type);
  
  if (msg.type === "CHECK_CONNECTION") {
    pingNative().then(sendResponse);
    return true;
  }

  if (msg.type === "TOGGLE_PICKER") {
    togglePicker();
    return;
  }
  
  const requestId = getRequestId(msg);
  
  if (msg.type === "CAPTURE_SCREENSHOT") {
    if (!sender.tab?.windowId) {
      console.log("[claude-annotate] Screenshot failed: No window ID");
      sendResponse({ error: "No window ID" });
      return true;
    }
    chrome.tabs.captureVisibleTab(sender.tab.windowId, { format: "png" }, (dataUrl) => {
      if (chrome.runtime.lastError) {
        console.log("[claude-annotate] Screenshot error:", chrome.runtime.lastError.message);
        sendResponse({ error: chrome.runtime.lastError.message });
      } else {
        console.log("[claude-annotate] Screenshot captured, size:", dataUrl?.length || 0);
        sendResponse({ dataUrl });
      }
    });
    return true;
  }
  
  if (["ANNOTATIONS_COMPLETE", "CANCEL"].includes(msg.type)) {
    if (requestId) requestTabs.delete(requestId);
    console.log("[claude-annotate] Forwarding to native host:", msg.type);
    sendToNative(msg);
  }
});

// Handle keyboard shortcut
chrome.commands.onCommand.addListener((command) => {
  if (command === "toggle-picker") {
    togglePicker();
  }
});

// Connect on startup
connectNative();
console.log("[claude-annotate] Background script loaded");
