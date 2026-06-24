/* pollWorker.js — Web Worker para timers de polling sin throttling.
 *
 * Chrome throttea setInterval/setTimeout en pestañas background a ~1s+
 * mínimo, y con múltiples timers activos el delay se amplifica. Este
 * Worker corre en su propio thread (aislado del page-context) y sus timers
 * NO son throttled por el browser.
 *
 * Protocolo:
 *   register   → {action:"register",   feature:"mercadoOro", intervalMs:1000}
 *   unregister → {action:"unregister", feature:"mercadoOro"}
 *   unregisterAll → {action:"unregisterAll"}
 *
 * El Worker responde con:
 *   {type:"JamBot:workerTick", feature:"mercadoOro"}
 *
 * Usa setTimeout recursivo + drift compensation para mantener precisión
 * sin drift acumulado.
 */
(function () {
  const timers = new Map(); // feature → {timeoutId, intervalMs, lastTick}

  function startTimer(feature, intervalMs) {
    if (timers.has(feature)) {
      clearTimeout(timers.get(feature).timeoutId);
    }

    const state = { timeoutId: null, intervalMs, lastTick: Date.now() };
    timers.set(feature, state);

    function tick() {
      const now = Date.now();
      const elapsed = now - state.lastTick;
      state.lastTick = now;

      // Drift compensation: si elapsed > intervalMs (throttling, tab sleep),
      // el próximo tick se dispara inmediatamente en vez de esperar intervalMs
      // completo. Esto garantiza que al despertar, el primer tick sea rápido.
      const nextDelay = Math.max(0, intervalMs - (elapsed - intervalMs));

      state.timeoutId = setTimeout(tick, nextDelay);

      // Notificar al content script
      try {
        self.postMessage({ type: "JamBot:workerTick", feature });
      } catch (_) {
        // Si el content script murió (extensión recargada), el postMessage
        // tira. Limpiamos el timer para no acumular errores.
        clearTimeout(state.timeoutId);
        timers.delete(feature);
      }
    }

    // Primer tick después de intervalMs
    state.timeoutId = setTimeout(tick, intervalMs);
  }

  function stopTimer(feature) {
    const state = timers.get(feature);
    if (state) {
      clearTimeout(state.timeoutId);
      timers.delete(feature);
    }
  }

  function stopAll() {
    for (const [feature, state] of timers) {
      clearTimeout(state.timeoutId);
    }
    timers.clear();
  }

  self.onmessage = function (e) {
    const msg = e.data;
    if (!msg || typeof msg.action !== "string") return;

    switch (msg.action) {
      case "register":
        if (msg.feature && typeof msg.intervalMs === "number" && msg.intervalMs > 0) {
          startTimer(msg.feature, msg.intervalMs);
        }
        break;
      case "unregister":
        if (msg.feature) stopTimer(msg.feature);
        break;
      case "unregisterAll":
        stopAll();
        break;
    }
  };
})();
