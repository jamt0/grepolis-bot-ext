/* Service worker — corre independiente de las pestañas. Garantiza dos cosas
 * que no se pueden hacer desde el content script con la pestaña en background:
 *
 *   1. POLLING CONFIABLE — `chrome.alarms` cada 30s pega un ping a las
 *      pestañas de Grepolis para que ataquesEntrantes.js disparé `ciclo()`
 *      inmediatamente. Sin esto, el `setInterval` del content script lo
 *      throttlea Chrome a ~1/min cuando la pestaña no es la activa.
 *
 *   2. NOTIFICACIÓN DEL SO — `chrome.notifications` muestra una notif a
 *      nivel sistema operativo cuando ataquesEntrantes detecta un ataque
 *      nuevo. El SO toca su propio sonido (que SIEMPRE suena, aunque la
 *      pestaña esté minimizada, el browser detrás de otras ventanas, etc).
 *      El AudioContext del content script puede quedar suspendido en
 *      background — la notif del SO lo soluciona.
 *
 * También se mantiene el handler legacy de badge (texto del icono de la
 * extensión).
 */

const ALARM_POLL_ATAQUES = "ataquesEntrantesPoll";
const POLL_PERIOD_MIN = 0.5; // 30s — mínimo permitido por chrome.alarms.

// id de notif → tab id, para que al apretarla podamos enfocar la pestaña.
const notifIdToTabId = new Map();

// Asegurarse de que la alarma esté creada/refrescada cada vez que el SW
// arranca (install, browser start, suspend/wake). create() es idempotente.
function asegurarAlarma() {
  chrome.alarms.create(ALARM_POLL_ATAQUES, { periodInMinutes: POLL_PERIOD_MIN });
}

chrome.runtime.onInstalled.addListener(asegurarAlarma);
chrome.runtime.onStartup.addListener(asegurarAlarma);
asegurarAlarma();

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== ALARM_POLL_ATAQUES) return;
  // Pegarle a TODAS las pestañas de Grepolis (puede haber varias abiertas
  // con distintos mundos). Cada content script decide si reacciona o no.
  chrome.tabs.query({ url: "*://*.grepolis.com/*" }, (tabs) => {
    for (const tab of tabs) {
      if (tab.id == null) continue;
      chrome.tabs.sendMessage(tab.id, { type: "JamBot:pollAtaques" }, () => {
        // Swallow errors: tabs sin content script (subdominios excluidos)
        // o tabs viejas tiran "Receiving end does not exist". No es fallo.
        void chrome.runtime.lastError;
      });
    }
  });
});

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || typeof msg.type !== "string") return;

  if (msg.type === "JamBot:badge") {
    const tabId = sender.tab && sender.tab.id;
    if (tabId == null) return;
    chrome.action.setBadgeText({ text: msg.text || "", tabId });
    if (msg.color) {
      chrome.action.setBadgeBackgroundColor({ color: msg.color, tabId });
    }
    return;
  }

  if (msg.type === "JamBot:notifyAttack") {
    // payload = { title, message, notifId? }
    const tabId = sender.tab && sender.tab.id;
    const notifId = msg.notifId || `jambot-ataque-${Date.now()}`;
    const opts = {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icon-alerta.png"),
      title: msg.title || "Grepolis JamBot",
      message: msg.message || "Tenés ataques entrantes",
      priority: 2,                  // máxima — más visible y más persistente
      requireInteraction: true,     // no auto-cierra hasta que el usuario interactúe
    };
    chrome.notifications.create(notifId, opts, (createdId) => {
      if (chrome.runtime.lastError) {
        console.warn("[JamBot/bg] notif create error:", chrome.runtime.lastError.message);
        return;
      }
      if (tabId != null) notifIdToTabId.set(createdId, tabId);
    });
    return;
  }

  if (msg.type === "JamBot:clearAttackNotifs") {
    // Cuando el usuario silencia la alarma en el content script, limpiamos
    // todas las notifs vivas que originamos.
    for (const id of notifIdToTabId.keys()) {
      chrome.notifications.clear(id);
    }
    notifIdToTabId.clear();
    return;
  }
});

// Al hacer click en la notif, llevar al usuario a la pestaña del juego.
chrome.notifications.onClicked.addListener((notifId) => {
  const tabId = notifIdToTabId.get(notifId);
  chrome.notifications.clear(notifId);
  notifIdToTabId.delete(notifId);
  if (tabId == null) return;
  chrome.tabs.update(tabId, { active: true }, () => {
    void chrome.runtime.lastError;
  });
  // También enfocar la ventana del browser por si está detrás de otras.
  chrome.tabs.get(tabId, (tab) => {
    if (tab && tab.windowId != null) {
      chrome.windows.update(tab.windowId, { focused: true });
    }
  });
});

chrome.notifications.onClosed.addListener((notifId) => {
  notifIdToTabId.delete(notifId);
});
