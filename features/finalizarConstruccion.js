/* features/finalizarConstruccion.js — finaliza órdenes de construcción gratis
 * cuando entran en la ventana de <5 minutos restantes (mecánica nativa del
 * juego: el botón "Gratis" en la cola).
 *
 * Para activarla, poner `"finalizarGratis": true` en data.json.
 *
 * Endpoint usado (capturado del botón Gratis del juego):
 *   POST .../frontend_bridge?town_id=<TOWN>&action=execute&h=<token>
 *   body: json={
 *     model_url: "BuildingOrder/<ID>",
 *     action_name: "buyInstant",
 *     arguments: { order_id: <ID> },
 *     town_id: <TOWN>, nl_init: true, captcha: null
 *   }
 *   response.success ⇒ "La construcción se ha completado correctamente."
 *   notifications[]: BuildingOrder × N (cola actualizada) + BuildingBuildData
 *
 * Limitación: la cola se lee de MM (modelos cargados en cliente). Si el
 * jugador no abrió una ciudad en la sesión, sus órdenes no aparecen — habría
 * que agregar un refetch HTTP por ciudad. Por ahora trabajamos sobre lo que
 * el cliente tiene en memoria.
 */
(function () {
  const JamBot = (window.JamBot = window.JamBot || {});
  JamBot.features = JamBot.features || {};

  /**
   * `ctx` viene del core.init(): { data, game, core }.
   */
  async function init(ctx) {
    const { data, game, core } = ctx;
    const { csrfToken, world_id } = game;

    //Margen de seguridad: el juego permite "free finish" si quedan <5min
    //(300s). Disparamos a los 290s para evitar race conditions con el reloj
    //del servidor.
    const VENTANA_SEGUNDOS = data.tiempoRestanteMaxSegundos || 290;

    //—— Estado ————————————————————————————————————————————————————————

    let proximoTickId = null;
    let corriendo = false;
    //La feature se habilita/deshabilita desde el toggle del panel ⚙. El
    //valor inicial viene de chrome.storage (si el usuario ya lo configuró
    //alguna vez) o cae al default de data.json (`finalizarGratis: true`).
    let habilitada = await cargarHabilitada();

    function cargarHabilitada() {
      return new Promise((resolve) => {
        chrome.storage.local.get("jambotConfig", (obj) => {
          const cfg = obj && obj.jambotConfig;
          if (cfg && typeof cfg.finalizarHabilitado === "boolean") {
            resolve(cfg.finalizarHabilitado);
          } else {
            resolve(data.finalizarGratis === true);
          }
        });
      });
    }

    //Reaccionar al play/pause global y al toggle del panel. La feature
    //corre solo cuando ambas condiciones se dan: habilitada Y bot no
    //pausado. Cualquier cambio dispara reconciliar().
    function reconciliar() {
      const debeCorrer = habilitada && !core.isPaused();
      if (debeCorrer && !proximoTickId && !corriendo) {
        ejecutarCiclo();
      } else if (!debeCorrer && proximoTickId) {
        clearTimeout(proximoTickId);
        proximoTickId = null;
      }
    }

    core.onPlayPauseChange(() => reconciliar());

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local" || !changes.jambotConfig) return;
      const nuevo = changes.jambotConfig.newValue;
      const flag = nuevo && typeof nuevo.finalizarHabilitado === "boolean"
        ? nuevo.finalizarHabilitado
        : data.finalizarGratis === true;
      if (flag === habilitada) return;
      habilitada = flag;
      console.log(`[JamBot/finalizar] feature ${habilitada ? "habilitada" : "deshabilitada"} desde el panel`);
      reconciliar();
    });

    if (!habilitada) {
      console.log("[JamBot/finalizar] feature deshabilitada — no arrancará hasta que se active en el panel ⚙");
    }

    //—— Scheduler ———————————————————————————————————————————————————————

    function programarSiguienteTick(ms) {
      if (proximoTickId) clearTimeout(proximoTickId);
      proximoTickId = setTimeout(async () => {
        proximoTickId = null;
        await ejecutarCiclo();
      }, ms);
    }

    /**
     * Un ciclo completo:
     * 1. Pide la cola de construcción al bridge.
     * 2. Para cada orden con `finish_time - now < VENTANA_SEGUNDOS`, dispara
     *    la finalización gratis (buyInstant).
     * 3. Reagenda según la próxima orden que entre en ventana, o un fallback
     *    de 5 minutos para refrescar la cola por si el jugador encoló algo
     *    nuevo desde la UI del juego.
     */
    async function ejecutarCiclo() {
      if (corriendo) return; //evitar reentradas
      if (!habilitada || core.isPaused()) return;
      corriendo = true;
      try {
        const colas = await obtenerColasConstruccion();
        const ahora = Math.floor(Date.now() / 1000);

        //Separar en dos grupos: las que hay que finalizar ya, y la siguiente
        //que va a entrar en ventana (para reagendar).
        let proximaEnVentana = null;
        const aFinalizar = [];

        for (const orden of colas) {
          if (!orden.finish_time) continue;
          const restante = orden.finish_time - ahora;
          if (restante <= 0) continue; //ya terminada, el cliente la limpia solo
          if (restante <= VENTANA_SEGUNDOS) {
            aFinalizar.push(orden);
          } else if (proximaEnVentana == null || restante < proximaEnVentana) {
            proximaEnVentana = restante;
          }
        }

        //Aleatorizar el orden de finalización por lo mismo que mezclamos las
        //consultas: no presentar al server una secuencia de cities siempre
        //ordenada igual.
        const ordenFinalizacion = shuffle(aFinalizar);
        let finalizadas = 0;

        for (const orden of ordenFinalizacion) {
          if (core.isCaptchaActive()) {
            console.warn("[JamBot/finalizar] CAPTCHA activo — abortando ciclo");
            break;
          }
          //Si el usuario pausó o deshabilitó la feature mid-tanda, parar
          //inmediatamente sin procesar la siguiente orden.
          if (core.isPaused() || !habilitada) {
            console.log("[JamBot/finalizar] pausa/deshabilitación detectada mid-ciclo — corto");
            break;
          }
          const ok = await finalizarGratis(orden);
          if (ok) finalizadas += 1;
        }

        const segundosHastaProximo = proximaEnVentana != null
          ? Math.max(30, proximaEnVentana - VENTANA_SEGUNDOS + 5)
          : 5 * 60;
        const msEspera = core.isCaptchaActive() ? 30 * 1000 : segundosHastaProximo * 1000;

        console.log(
          `[JamBot/finalizar] ciclo OK: ${colas.length} órdenes en cola, ${finalizadas}/${aFinalizar.length} finalizadas. Próximo tick en ${Math.round(msEspera / 1000)}s${core.isCaptchaActive() ? " (modo CAPTCHA)" : ""}`
        );
        //Respetar pausa/deshabilitación que pudo ocurrir durante el ciclo.
        if (habilitada && !core.isPaused()) {
          programarSiguienteTick(msEspera);
        }
      } finally {
        corriendo = false;
      }
    }

    //—— Helpers anti-detección ————————————————————————————————————————————

    function jitter(minMs, maxMs) {
      return minMs + Math.random() * (maxMs - minMs);
    }

    function shuffle(arr) {
      const copia = arr.slice();
      for (let i = copia.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [copia[i], copia[j]] = [copia[j], copia[i]];
      }
      return copia;
    }

    function delayMs(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms));
    }

    //—— Refetch HTTP de la cola por ciudad ————————————————————————————————
    //
    //MM solo tiene cargada la cola de la ciudad activa. Para soportar todas
    //las ciudades del jugador hacemos un refetch HTTP por cada una — mismo
    //patrón que usa obtenerMapaRelaciones() en recoleccion.js.
    //
    //Hidratamos los modelos Backbone con dispatchNotifications para que la
    //UI del juego (cola visible al cambiar de ciudad) quede consistente.
    //
    //Si la colección "BuildingOrders" no existe con ese nombre, la respuesta
    //vendrá vacía y se logueará un aviso. Cambiar a la variante correcta
    //ajustando NOMBRE_COLECCION abajo.

    const NOMBRE_COLECCION = "BuildingOrders";

    function obtenerListaCiudades() {
      //recoleccion poblá data.ciudadesConAldeas en su init. Como el bootstrap
      //ejecuta recoleccion.init antes que el nuestro, debería estar lista.
      if (Array.isArray(data.ciudadesConAldeas) && data.ciudadesConAldeas.length) {
        return data.ciudadesConAldeas.map((c) => c.codigoCiudad);
      }
      return [];
    }

    async function fetchColaCiudad(cityId) {
      const json = `{"collections":{"${NOMBRE_COLECCION}":[]},"town_id":${cityId},"nl_init":false}`;
      const url = `https://${world_id}.grepolis.com/game/frontend_bridge?town_id=${cityId}&action=refetch&h=${csrfToken}&json=${encodeURIComponent(json)}`;

      const res = await fetch(url, {
        method: "GET",
        headers: {
          "X-Requested-With": "XMLHttpRequest",
          accept: "text/plain, */*; q=0.01",
        },
      });
      const parsed = await res.json();

      const items =
        (parsed &&
          parsed.json &&
          parsed.json.collections &&
          parsed.json.collections[NOMBRE_COLECCION] &&
          parsed.json.collections[NOMBRE_COLECCION].data) ||
        [];

      return items.map((item) => {
        const o = item.d || item;
        return {
          id: o.id,
          town_id: o.town_id,
          finish_time: o.to_be_completed_at,
          building_type: o.building_type,
          tear_down: !!o.tear_down,
        };
      });
    }

    async function obtenerColasConstruccion() {
      const ciudades = obtenerListaCiudades();
      if (!ciudades.length) {
        console.warn(
          "[JamBot/finalizar] no hay ciudades en data.ciudadesConAldeas — recoleccion todavía no las cargó?"
        );
        return [];
      }

      //Mezclar el orden de consulta para no levantar patrones en el detector.
      const orden = shuffle(ciudades);
      const todas = [];
      let conOrdenes = 0;
      let errores = 0;

      for (let i = 0; i < orden.length; i++) {
        if (core.isCaptchaActive()) {
          console.warn("[JamBot/finalizar] CAPTCHA activo — corto la consulta de colas");
          break;
        }
        const cityId = orden[i];
        try {
          const ordenes = await fetchColaCiudad(cityId);
          if (ordenes.length) conOrdenes += 1;
          todas.push(...ordenes);
        } catch (e) {
          errores += 1;
          console.warn(`[JamBot/finalizar] error leyendo cola town=${cityId}:`, e);
        }
        //Espacio entre fetches para suavizar la huella. Sin delay tras la última.
        if (i < orden.length - 1) await delayMs(jitter(300, 800));
      }

      console.log(
        `[JamBot/finalizar] colas consultadas: ${ciudades.length} ciudades, ${conOrdenes} con órdenes, ${todas.length} órdenes totales` +
          (errores ? ` (${errores} con error)` : "")
      );
      return todas;
    }

    //—— Disparo de la finalización gratis ————————————————————————————————

    /**
     * Replica el click en el botón "Gratis" del juego. Devuelve true si el
     * server confirmó la operación.
     *
     * El response trae notifications con BuildingOrder actualizadas (la cola
     * se desplaza al finalizar) y BuildingBuildData. El dispatch al bridge
     * actualiza los modelos Backbone y la UI del juego se refresca sola.
     *
     * NOTA sobre CAPTCHA: a diferencia de los claims de farm, el response de
     * buyInstant NO incluye una notification "Town", así que NO usamos esa
     * heurística. La detección sigue viniendo del polling de Game.bot_check
     * que ya hace el bridge.
     */
    async function finalizarGratis(orden) {
      //Jitter 1.0-1.5s entre buyInstant — alinea con recoleccion. Un delay
      //fijo de 1s era patrón detectable cuando hay varias órdenes en una
      //sola tanda.
      await delayMs(jitter(1000, 1500));

      const json = {
        model_url: `BuildingOrder/${orden.id}`,
        action_name: "buyInstant",
        captcha: null,
        arguments: { order_id: orden.id },
        town_id: orden.town_id,
        nl_init: true,
      };

      const datos = new URLSearchParams();
      datos.append("json", JSON.stringify(json));

      let response;
      try {
        const res = await fetch(
          `https://${world_id}.grepolis.com/game/frontend_bridge?town_id=${orden.town_id}&action=execute&h=${csrfToken}`,
          {
            method: "POST",
            headers: {
              "X-Requested-With": "XMLHttpRequest",
              accept: "text/plain, */*; q=0.01",
            },
            body: datos,
          }
        );
        response = await res.json();
      } catch (e) {
        console.error(`[JamBot/finalizar] fetch falló (town=${orden.town_id} id=${orden.id}):`, e);
        return false;
      }

      if (!response || !response.json || !response.json.success) {
        console.warn(
          `[JamBot/finalizar] respuesta sin success (town=${orden.town_id} id=${orden.id}):`,
          response
        );
        return false;
      }

      //Refrescar la UI del juego propagando las notifications a Backbone.
      if (Array.isArray(response.json.notifications)) {
        window.dispatchEvent(
          new CustomEvent("JamBot:dispatchNotifications", {
            detail: { notifications: response.json.notifications },
          })
        );
      }

      console.log(
        `[JamBot/finalizar] ✓ town=${orden.town_id} id=${orden.id} (${orden.building_type}) — "${response.json.success}"`
      );
      return true;
    }
  }

  JamBot.features.finalizarConstruccion = { init };
})();
