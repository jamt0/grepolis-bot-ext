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
   * Despacha las notifications de un response de claim a los modelos Backbone.
   * Cada notification trae:
   *   - subject: nombre del modelo (ej "Town", "FarmTownPlayerRelation")
   *   - param_id: id del modelo dentro de su namespace
   *   - param_str: JSON con los nuevos atributos
   *   - type: "backbone"
   * Si el modelo está cargado en MM, se le hace .set() con los atributos
   * nuevos; si no, se ignora silenciosamente (no podemos refrescar lo que
   * no está cargado).
   */
  function dispatchNotifications(notifications) {
    if (!Array.isArray(notifications)) return;
    if (!window.MM || typeof window.MM.getModels !== "function") return;

    const allModels = window.MM.getModels();

    for (const notif of notifications) {
      if (!notif || notif.type !== "backbone") continue;
      if (!notif.subject || notif.param_id == null) continue;

      let payload;
      try {
        payload = JSON.parse(notif.param_str);
      } catch (e) {
        console.warn("[JamBot bridge] param_str no parseable:", e, notif);
        continue;
      }

      const subjectData = payload && payload[notif.subject];
      if (!subjectData) continue;

      const subjectModels = allModels[notif.subject];
      if (!subjectModels) continue;

      const model = subjectModels[notif.param_id];
      if (model && typeof model.set === "function") {
        model.set(subjectData);
      }
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
   * cada ciclo y evitar que el primer claim arrastre 5 minutos de
   * producción + acciones del jugador.
   */
  window.addEventListener("JamBot:queryTownResources", function (e) {
    const townId = e && e.detail && e.detail.townId;
    let resources = null;
    if (window.MM && typeof window.MM.getModels === "function") {
      const towns = window.MM.getModels().Town;
      const town = towns && (towns[townId] || towns[String(townId)]);
      const r = town && town.attributes && town.attributes.resources;
      if (r) {
        resources = { wood: r.wood, stone: r.stone, iron: r.iron };
      }
    }
    window.postMessage(
      { type: "JamBot:townResources", townId, resources },
      "*"
    );
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
