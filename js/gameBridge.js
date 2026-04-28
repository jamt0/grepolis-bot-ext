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
})();
