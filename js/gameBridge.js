/* gameBridge.js — corre en page-context (mismo scope que window.Game / window.MM).
 *
 * Hace de puente entre el content script (mundo aislado) y el cliente del
 * juego (modelos Backbone). El content script le manda eventos via
 * CustomEvent y el bridge actualiza los modelos correspondientes para que
 * la UI se refresque sola gracias a los eventos de Backbone.
 */
(function () {
  console.log("[JamBot bridge] cargado");

  /**
   * Despacha las notifications de un response a los modelos Backbone Y al
   * dispatcher nativo del juego cuando aplica.
   *
   * Tipos típicos en Grepolis:
   *   - "backbone"   → update de un modelo Backbone. Hacemos model.set().
   *   - "new"        → cosas nuevas (mensajes, reportes, ataques entrantes
   *                    detectados). El juego usa esto para encender el
   *                    badge en los iconos del topbar + sonido + banner.
   *   - "raw"        → mensajes HTML de bandeja
   *   - "delete"     → notificación marcada como leída
   *   - "instant_command" → comandos a aplicar (revolts, etc.)
   *
   * Si NO reenviamos las no-backbone, el juego no recibe el aviso —
   * desaparece el sonido y el badge de "tenés un ataque entrante" porque
   * el server las marcó como entregadas a NUESTRA request (el cliente
   * normal del juego no las recibe en su /game/notify).
   *
   * Estrategia:
   *   1. Para "backbone": model.set() como antes (lo hacemos nosotros).
   *   2. Para todo el resto: intentamos llamar al dispatcher nativo del
   *      juego si lo encontramos. Probamos rutas comunes — el primero que
   *      exista gana, el resto se loguea una vez para diagnóstico.
   */
  //Identificado en sesión real (probe de DevTools): el dispatcher nativo
  //de Grepolis es `MM.handleNotification(notif)` — toma UNA notif y la
  //rutea internamente según su `type` (backbone → update de modelo, new →
  //banner/sonido/badge, raw → mensaje en bandeja, delete → marcar leído).
  //
  //Llamándolo replicamos exactamente lo que el juego hace cuando una
  //response de AJAX vuelve con `notifications[]` — incluida la
  //actualización de modelos Backbone Y los efectos secundarios (sonido del
  //ataque entrante, badge del topbar, refresh del bandeja de mensajes,
  //etc.). Sin esto el server nos las entrega y se las pierde el juego.
  let avisoSinHandler = false;
  function dispatchNotifications(notifications) {
    if (!Array.isArray(notifications) || !notifications.length) return;
    if (!window.MM) return;

    if (typeof window.MM.handleNotification === "function") {
      for (const notif of notifications) {
        if (!notif) continue;
        try {
          window.MM.handleNotification(notif);
        } catch (e) {
          console.warn("[JamBot bridge] MM.handleNotification tiró:", e, notif);
        }
      }
      return;
    }

    //Fallback histórico: si MM.handleNotification no existe (versión vieja
    //de Grepolis o changeset), seguimos haciendo model.set manual para
    //al menos las notifs `type:"backbone"`. Las otras se pierden — log una
    //sola vez para diagnóstico.
    if (!avisoSinHandler) {
      avisoSinHandler = true;
      console.warn(
        "[JamBot bridge] MM.handleNotification no existe — fallback al " +
        "dispatcher manual de backbone. Avisos de ataque/mensaje pueden " +
        "perderse."
      );
    }
    if (typeof window.MM.getModels !== "function") return;
    const allModels = window.MM.getModels();
    for (const notif of notifications) {
      if (!notif || notif.type !== "backbone") continue;
      if (!notif.subject || notif.param_id == null) continue;
      let payload;
      try { payload = JSON.parse(notif.param_str); } catch (_) { continue; }
      const subjectData = payload && payload[notif.subject];
      if (!subjectData) continue;
      const subjectModels = allModels[notif.subject];
      if (!subjectModels) continue;
      const model = subjectModels[notif.param_id];
      if (model && typeof model.set === "function") model.set(subjectData);
    }
  }

  window.addEventListener("JamBot:dispatchNotifications", function (e) {
    const notifications = e && e.detail && e.detail.notifications;
    dispatchNotifications(notifications);
  });

  /**
   * Marca una FarmTownPlayerRelation como recién claimeada y reinicia su
   * cooldown visual. El response del endpoint de claim no incluye una
   * notification para este modelo, así que el ícono verde de "disponible"
   * sobre la aldea quedaba visible hasta que el jugador cambiara de ciudad
   * (eso reinyecta las relaciones desde island_info). Acá replicamos ese
   * efecto seteando lootable_at / last_looted_at — Backbone dispara `change`
   * y la vista del mapa se re-renderea sola.
   *
   * El cooldown se infiere del propio modelo (lootable_at - last_looted_at),
   * que es estable por ciudad (5 o 10 min). Así el bridge no tiene que
   * conocer la config del bot.
   */
  window.addEventListener("JamBot:markFarmTownClaimed", function (e) {
    const relationId = e && e.detail && e.detail.relationId;
    if (relationId == null) return;
    if (!window.MM || typeof window.MM.getModels !== "function") return;
    const rels = window.MM.getModels().FarmTownPlayerRelation;
    if (!rels) return;
    const rel = rels[relationId] || rels[String(relationId)];
    if (!rel || typeof rel.set !== "function") return;
    const a = rel.attributes || {};
    const cooldown = (a.lootable_at || 0) - (a.last_looted_at || 0);
    if (cooldown <= 0) return;
    const nowSec = Math.floor(Date.now() / 1000);
    rel.set({
      last_looted_at: nowSec,
      lootable_at: nowSec + cooldown,
      updated_at: nowSec,
    });
  });

  /**
   * Permite al content script preguntar los recursos actuales de un Town
   * cargado en MM. Útil para refrescar el baseline del diff al inicio de
   * cada ciclo (recolección) y para que la feature `comercio` calcule
   * cuánto puede enviar desde un origen y cuánto puede recibir un destino.
   *
   * Devuelve además:
   *   - storage: cap del almacén por recurso (mismo número los 3).
   *   - maxTradeCapacity: tope del mercado del origen (available_traders ×
   *     load_per_trader cuando todos los comerciantes están en casa).
   *   - availableTradeCapacity: capacidad libre AHORA del mercado del origen.
   *
   * Si el modelo Town no está cargado en MM (la ciudad nunca fue abierta en
   * la sesión y no llegó por notification), los campos vienen como null —
   * el content script decide qué hacer (refetch al server, saltar el ciclo).
   */
  window.addEventListener("JamBot:queryTownResources", function (e) {
    const townId = e && e.detail && e.detail.townId;
    let resources = null;
    let storage = null;
    let maxTradeCapacity = null;
    let availableTradeCapacity = null;
    if (window.MM && typeof window.MM.getModels === "function") {
      const towns = window.MM.getModels().Town;
      const town = towns && (towns[townId] || towns[String(townId)]);
      const a = town && town.attributes;
      if (a) {
        const r = a.resources;
        if (r) resources = { wood: r.wood, stone: r.stone, iron: r.iron };
        if (typeof a.storage === "number") storage = a.storage;
        if (typeof a.max_trade_capacity === "number") maxTradeCapacity = a.max_trade_capacity;
        if (typeof a.available_trade_capacity === "number") availableTradeCapacity = a.available_trade_capacity;
      }
    }
    window.postMessage(
      { type: "JamBot:townResources", townId, resources, storage, maxTradeCapacity, availableTradeCapacity },
      "*"
    );
  });

  /**
   * Devuelve la lista de comercios (modelo `Trade`) cargados en MM, filtrados
   * por jugador. Útil para que la feature `comercio` muestre los envíos en
   * vuelo y calcule cuándo vuelven los comerciantes. El response del POST
   * /game/town_info?action=trade ya viene con una notification `Trade` que
   * el bridge inyecta a MM via dispatchNotifications, así que la colección
   * está siempre fresca después de un envío del bot.
   */
  window.addEventListener("JamBot:queryTrades", function (e) {
    const playerId = e && e.detail && e.detail.playerId;
    const trades = [];
    if (window.MM && typeof window.MM.getModels === "function") {
      const all = window.MM.getModels().Trade || {};
      for (const id of Object.keys(all)) {
        const t = all[id];
        const a = t && t.attributes;
        if (!a) continue;
        if (playerId != null && a.origin_town_player_id != null &&
            String(a.origin_town_player_id) !== String(playerId)) continue;
        trades.push({
          id: a.id,
          originTownId: a.origin_town_id,
          originTownName: a.origin_town_name,
          destinationTownId: a.destination_town_id,
          wood: a.wood || 0,
          stone: a.stone || 0,
          iron: a.iron || 0,
          startedAt: a.started_at,
          arrivalAt: a.arrival_at,
          cancelable: !!a.cancelable,
        });
      }
    }
    window.postMessage({ type: "JamBot:tradesResult", trades }, "*");
  });

  /**
   * Permite al content script preguntar las unidades que pertenecen y están
   * en una ciudad — es decir, el modelo Units con
   * `home_town_id == current_town_id == townId`. Eso filtra: tropas en otra
   * ciudad como apoyo (current_town_id != home), tropas en movimiento
   * (current_town_id null), y tropas extranjeras estacionadas (home != town).
   *
   * Devuelve el atributo crudo (sword, slinger, archer, …) o null si el
   * modelo no está cargado en MM (la ciudad no fue abierta en la sesión).
   * El feature ataques usa esto para saber cuántas unidades del tipo
   * elegido están disponibles antes de cada ataque.
   */
  window.addEventListener("JamBot:queryUnits", function (e) {
    const townId = e && e.detail && e.detail.townId;
    let units = null;
    if (window.MM && typeof window.MM.getModels === "function") {
      const all = window.MM.getModels().Units;
      if (all) {
        for (const id of Object.keys(all)) {
          const u = all[id];
          const a = u && u.attributes;
          if (!a) continue;
          if (a.home_town_id == townId && a.current_town_id == townId) {
            units = Object.assign({}, a);
            break;
          }
        }
      }
    }
    window.postMessage({ type: "JamBot:unitsResult", townId, units }, "*");
  });

  /**
   * Vigila Game.bot_check. En estado normal vale null; cuando Grepolis exige
   * un challenge anti-bot pasa a un objeto con la info del CAPTCHA. Cualquier
   * cambio se notifica al content script vía postMessage para que pause el
   * scheduler y avise al usuario.
   */
  let lastBotCheck = null;
  function leerBotCheck() {
    return window.Game ? window.Game.bot_check : undefined;
  }
  lastBotCheck = leerBotCheck() || null;

  setInterval(function () {
    const actual = leerBotCheck();
    const ahoraActivo = actual != null;
    const antesActivo = lastBotCheck != null;
    if (ahoraActivo !== antesActivo) {
      lastBotCheck = actual || null;
      window.postMessage(
        {
          type: "JamBot:captchaState",
          active: ahoraActivo,
        },
        "*"
      );
      console.log(
        "[JamBot bridge] cambio bot_check:",
        antesActivo ? "ACTIVO" : "limpio",
        "→",
        ahoraActivo ? "ACTIVO" : "limpio"
      );
    }
  }, 2000);
})();
