/* Service worker — recibe mensajes del content script y delega en
 * APIs de chrome.* (badge en el ícono de la extensión).
 */
console.log("background");

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || typeof msg.type !== "string") return;

  if (msg.type === "JamBot:badge") {
    const tabId = sender.tab && sender.tab.id;
    if (tabId == null) return;
    chrome.action.setBadgeText({ text: msg.text || "", tabId });
    if (msg.color) {
      chrome.action.setBadgeBackgroundColor({ color: msg.color, tabId });
    }
  }
});
