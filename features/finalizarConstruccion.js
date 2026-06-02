/* features/finalizarConstruccion.js — finaliza órdenes de construcción gratis
 * cuando entran en la ventana de <5 minutos restantes (mecánica nativa del
 * juego: el botón "Gratis" en la cola).
 *
 * Ciclo INDEPENDIENTE del resto de features. No depende del play/pause
 * global ni de `data.ciudadesConAldeas` (que poblá recoleccion). Tiene su
 * propio toggle Iniciar/Detener en la tab "Construcción" del panel, y
 * obtiene la lista de ciudades vía un refetch HTTP propio (cacheado 30
 * min). Persiste su flag en chrome.storage con su key propia.
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
 */
(function () {
  const JamBot = (window.JamBot = window.JamBot || {});
  JamBot.features = JamBot.features || {};

  /**
   * `ctx` viene del core.init(): { data, game, core }.
   */
  async function init(ctx) {
    const { data, game, core } = ctx;
    const { csrfToken, world_id, townId } = game;

    //Margen de seguridad: el juego permite "free finish" si quedan <5min
    //(300s). Disparamos a los 290s para evitar race conditions con el reloj
    //del servidor.
    const VENTANA_SEGUNDOS = data.tiempoRestanteMaxSegundos || 290;

    //—— Estado ————————————————————————————————————————————————————————

    let proximoTickId = null;
    let corriendo = false;
    let proximoTickAt = null;

    //Persistencia del flag de habilitada. Key propia (no compartida con
    //jambotConfig) para que el módulo sea autónomo. Migra del shape viejo
    //(`jambotConfig.finalizarHabilitado`) la primera vez que se lee, así
    //los usuarios existentes mantienen su preferencia.
    //Declarado ACÁ (antes del await) porque cargarHabilitada lo referencia
    //internamente — moverlo más abajo cae en TDZ y rompe el init.
    const STORAGE_KEY_HABILITADA = `jambotFinalizarHabilitada_${world_id}`;

    function cargarHabilitada() {
      return new Promise((resolve) => {
        chrome.storage.local.get(
          [STORAGE_KEY_HABILITADA, "jambotConfig"],
          (obj) => {
            const propio = obj && obj[STORAGE_KEY_HABILITADA];
            if (typeof propio === "boolean") { resolve(propio); return; }
            //Migración del shape viejo (jambotConfig.finalizarHabilitado).
            //Lo leemos una sola vez y lo guardamos bajo la nueva key — la
            //fuente del flag pasa a ser propia de este módulo.
            const cfg = obj && obj.jambotConfig;
            const viejo = cfg && typeof cfg.finalizarHabilitado === "boolean"
              ? cfg.finalizarHabilitado
              : data.finalizarGratis === true;
            try { chrome.storage.local.set({ [STORAGE_KEY_HABILITADA]: viejo }); } catch (_) {}
            resolve(viejo);
          }
        );
      });
    }

    //La feature se habilita/deshabilita desde el botón Iniciar/Detener
    //de la tab "Construcción". El valor inicial viene de chrome.storage
    //(si el usuario ya lo configuró alguna vez) o cae al default de
    //data.json (`finalizarGratis: true`).
    let habilitada = await cargarHabilitada();

    //—— Estado expuesto al panel (data.construccion) —————————————————————
    //
    //La tab "Construcción" del panel ⚙ lee este objeto. Lo refrescamos en
    //cada ciclo. `ultimoCiclo` y `finalizadas` también persisten en
    //chrome.storage.local para sobrevivir al reload — `ultimaCola` se
    //recalcula al primer tick, no vale la pena persistirla.
    const FINALIZADAS_MAX = 20;
    const STORAGE_KEY_CONSTR = `jambotConstruccion_${world_id}`;
    data.construccion = data.construccion || {
      habilitada,
      proximoTickAt: null,
      ultimoCiclo: null,
      ultimaCola: [],
      finalizadas: [],
    };

    //Restaurar persistencia. Solo persiste el último ciclo (resumen mínimo).
    //La lista de `finalizadas` vive en RAM por la sesión actual — no
    //persistimos el historial para mantener el storage liviano.
    await new Promise((resolve) => {
      try {
        chrome.storage.local.get(STORAGE_KEY_CONSTR, (obj) => {
          const blob = (obj && obj[STORAGE_KEY_CONSTR]) || {};
          data.construccion.ultimoCiclo = blob.ultimoCiclo || null;
          data.construccion.finalizadas = [];
          resolve();
        });
      } catch (_) { resolve(); }
    });

    function persistirConstruccion() {
      try {
        chrome.storage.local.set({
          [STORAGE_KEY_CONSTR]: {
            ultimoCiclo: data.construccion.ultimoCiclo,
          },
        });
      } catch (e) {
        core.logWarn("finalizar", "no pude persistir estado de construcción", e);
      }
    }

    function registrarFinalizada(orden, mensaje, town_nombre) {
      data.construccion.finalizadas.push({
        ts: Date.now(),
        town_id: orden.town_id,
        town_nombre: town_nombre || String(orden.town_id),
        id: orden.id,
        building_type: orden.building_type,
        mensaje: mensaje || "",
      });
      while (data.construccion.finalizadas.length > FINALIZADAS_MAX) {
        data.construccion.finalizadas.shift();
      }
      persistirConstruccion();
    }

    function nombreCiudad(town_id) {
      //Preferimos el nombre propio (poblado por nuestro refetch de Towns);
      //fallback a la lista de recoleccion por si todavía no corrimos
      //refetch propio.
      const propio = nombrePorCiudad.get(Number(town_id));
      if (propio) return propio;
      const c = (data.ciudadesConAldeas || []).find((x) => x.codigoCiudad == town_id);
      return c ? (c.nombreCiudad || String(town_id)) : String(town_id);
    }

    //Reconciliar el scheduler con el estado actual del flag. NO mira el
    //play/pause global: este módulo corre independiente. Si está habilitado,
    //hay timer / ciclo activo. Si no, todo se cancela.
    function reconciliar() {
      data.construccion.habilitada = habilitada;
      if (habilitada && !proximoTickId && !corriendo) {
        ejecutarCiclo();
      } else if (!habilitada && proximoTickId) {
        clearTimeout(proximoTickId);
        proximoTickId = null;
        proximoTickAt = null;
        data.construccion.proximoTickAt = null;
      }
    }

    //API expuesta al panel para que la tab "Construcción" pueda alternar el
    //estado desde su botón Iniciar/Detener. Cambia el flag, lo persiste y
    //arranca o frena el ciclo.
    function setHabilitada(nuevo) {
      const v = !!nuevo;
      if (v === habilitada) return;
      habilitada = v;
      try { chrome.storage.local.set({ [STORAGE_KEY_HABILITADA]: habilitada }); } catch (_) {}
      core.log(
        "finalizar",
        habilitada ? "INICIADO desde el panel" : "DETENIDO desde el panel",
        habilitada ? "ok" : "info"
      );
      reconciliar();
    }

    if (!habilitada) {
      core.log("finalizar", "feature deshabilitada — apretá Iniciar en la tab Construcción para arrancar");
    }

    //—— Scheduler ———————————————————————————————————————————————————————

    function programarSiguienteTick(ms) {
      if (proximoTickId) clearTimeout(proximoTickId);
      proximoTickAt = Date.now() + ms;
      data.construccion.proximoTickAt = proximoTickAt;
      proximoTickId = setTimeout(async () => {
        proximoTickId = null;
        proximoTickAt = null;
        data.construccion.proximoTickAt = null;
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
      if (!habilitada) return;
      corriendo = true;
      const inicioCiclo = Date.now();
      try {
        const colas = await obtenerColasConstruccion();
        const ahora = Math.floor(Date.now() / 1000);

        //Snapshot de la cola actual para el panel (Construcción → Cola
        //actual). Anotamos restante y si está en ventana de "free finish"
        //para que el render no recompute en cada refresh.
        data.construccion.ultimaCola = colas
          .filter((o) => o.finish_time && (o.finish_time - ahora) > 0)
          .map((o) => ({
            id: o.id,
            town_id: o.town_id,
            town_nombre: nombreCiudad(o.town_id),
            building_type: o.building_type,
            finish_time: o.finish_time,
            segundosRestantes: o.finish_time - ahora,
            enVentana: (o.finish_time - ahora) <= VENTANA_SEGUNDOS,
          }))
          .sort((a, b) => a.segundosRestantes - b.segundosRestantes);

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
            core.logWarn("finalizar", "CAPTCHA activo — abortando ciclo");
            break;
          }
          //Si el usuario deshabilitó la feature mid-tanda, parar
          //inmediatamente sin procesar la siguiente orden.
          if (!habilitada) {
            core.log("finalizar", "deshabilitación detectada mid-ciclo — corto");
            break;
          }
          const ok = await finalizarGratis(orden);
          if (ok) finalizadas += 1;
        }

        const segundosHastaProximo = proximaEnVentana != null
          ? Math.max(30, proximaEnVentana - VENTANA_SEGUNDOS + 5)
          : 5 * 60;
        const msEspera = core.isCaptchaActive() ? 30 * 1000 : segundosHastaProximo * 1000;

        core.log(
          "finalizar",
          `ciclo OK: ${colas.length} órdenes en cola, ${finalizadas}/${aFinalizar.length} finalizadas · próximo tick en ${core.formatDuracion(msEspera / 1000)}${core.isCaptchaActive() ? " (modo CAPTCHA)" : ""}`,
          finalizadas > 0 ? "ok" : "info"
        );

        //Snapshot del último ciclo para el panel.
        const finCiclo = Date.now();
        data.construccion.ultimoCiclo = {
          inicio: inicioCiclo,
          fin: finCiclo,
          duracion: finCiclo - inicioCiclo,
          ordenesEnCola: colas.length,
          ordenesEnVentana: aFinalizar.length,
          finalizadas: finalizadas,
          captchaDurante: core.isCaptchaActive(),
        };
        persistirConstruccion();

        //Si se deshabilitó mid-ciclo, no reagendamos. Igual respeta CAPTCHA.
        if (habilitada) {
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

    //Cache de la lista de ciudades propias. Refetch HTTP propio cada
    //LISTA_TTL — no dependemos de que recoleccion haya corrido. Si por la
    //razón que sea recoleccion ya cargó `data.ciudadesConAldeas` la usamos
    //como dato inicial barato, pero el refresco lo manejamos nosotros.
    const LISTA_TTL_MS = 30 * 60 * 1000;
    let listaCiudadesCache = [];
    let listaCiudadesTs = 0;
    //Mapa townId → nombre, para que `nombreCiudad()` siga funcionando sin
    //depender de recoleccion. Si recoleccion también la tiene, las dos
    //fuentes coexisten — `nombreCiudad()` consulta primero la propia.
    const nombrePorCiudad = new Map();

    async function obtenerListaCiudades() {
      const ahora = Date.now();
      if (listaCiudadesCache.length && ahora - listaCiudadesTs < LISTA_TTL_MS) {
        return listaCiudadesCache;
      }
      //Refetch propio de la colección Towns. Igual patrón que mercadoOro:
      //un GET por mundo, dispatchea las notifs (Town, BuildingOrders, etc.)
      //para que la UI del juego se mantenga al día.
      try {
        const json = `{"collections":{"Towns":[]},"town_id":${townId},"nl_init":false}`;
        const url = `https://${world_id}.grepolis.com/game/frontend_bridge?town_id=${townId}&action=refetch&h=${csrfToken}&json=${encodeURIComponent(json)}`;
        const res = await fetch(url, {
          method: "GET",
          headers: {
            "X-Requested-With": "XMLHttpRequest",
            accept: "text/plain, */*; q=0.01",
          },
        });
        const parsed = await res.json();
        const notifs = parsed && parsed.json && parsed.json.notifications;
        if (Array.isArray(notifs) && notifs.length) {
          window.dispatchEvent(new CustomEvent("JamBot:dispatchNotifications", {
            detail: { notifications: notifs },
          }));
        }
        const items =
          (parsed && parsed.json && parsed.json.collections &&
           parsed.json.collections.Towns && parsed.json.collections.Towns.data) || [];
        const lista = [];
        for (const it of items) {
          const c = it.d || it;
          if (c && c.id) {
            lista.push(c.id);
            if (c.name) nombrePorCiudad.set(Number(c.id), String(c.name));
          }
        }
        if (lista.length) {
          listaCiudadesCache = lista;
          listaCiudadesTs = ahora;
          return lista;
        }
      } catch (e) {
        core.logWarn("finalizar", `refetch lista de ciudades falló: ${e.message}`);
      }
      //Fallback: si el refetch falló y recoleccion ya tiene la lista, usarla
      //para no quedar bloqueados. Se reintentará en el próximo ciclo.
      if (Array.isArray(data.ciudadesConAldeas) && data.ciudadesConAldeas.length) {
        return data.ciudadesConAldeas.map((c) => c.codigoCiudad);
      }
      return listaCiudadesCache; //puede ser []
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

      //Re-dispatch las notifications a Backbone. CRÍTICO: este refetch corre
      //por cada ciudad cada ciclo, y la respuesta incluye notifs de Town,
      //BuildingOrders, UnitOrders, Units, etc. Si las consumimos sin reenviar,
      //el juego no se entera de:
      //  - edificios que terminaron (cola congelada en la UI)
      //  - free completion (5 min) o compra con oro (cola sigue mostrando)
      //  - unidades que se terminaron de reclutar en el cuartel
      //El server las marca como entregadas a la sesión: si no las pasamos al
      //MM, esa info se pierde hasta que el jugador cambie de ciudad.
      const notifs = parsed && parsed.json && parsed.json.notifications;
      if (Array.isArray(notifs) && notifs.length) {
        window.dispatchEvent(new CustomEvent("JamBot:dispatchNotifications", {
          detail: { notifications: notifs },
        }));
      }

      const items =
        (parsed &&
          parsed.json &&
          parsed.json.collections &&
          parsed.json.collections[NOMBRE_COLECCION] &&
          parsed.json.collections[NOMBRE_COLECCION].data) ||
        [];

      //El bridge devuelve TODAS las órdenes del jugador desde cualquier
      //ciudad consultada, no solo las de `cityId`. Filtramos para que cada
      //ciudad aporte únicamente las suyas; sin esto las órdenes se duplican
      //×N (una por cada ciudad consultada) y el ciclo intenta finalizar la
      //misma orden varias veces — la 1ra OK, las siguientes "ya no existe".
      return items
        .map((item) => {
          const o = item.d || item;
          return {
            id: o.id,
            town_id: o.town_id,
            finish_time: o.to_be_completed_at,
            building_type: o.building_type,
            tear_down: !!o.tear_down,
          };
        })
        .filter((o) => o.town_id === cityId);
    }

    async function obtenerColasConstruccion() {
      const ciudades = await obtenerListaCiudades();
      if (!ciudades.length) {
        core.logWarn(
          "finalizar",
          "no obtuve ninguna ciudad del refetch — reintento próximo ciclo"
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
          core.logWarn("finalizar", "CAPTCHA activo — corto la consulta de colas");
          break;
        }
        const cityId = orden[i];
        try {
          const ordenes = await fetchColaCiudad(cityId);
          if (ordenes.length) conOrdenes += 1;
          todas.push(...ordenes);
        } catch (e) {
          errores += 1;
          core.logWarn("finalizar", `error leyendo cola town=${cityId}`, e);
        }
        //Espacio entre fetches para suavizar la huella. Sin delay tras la última.
        if (i < orden.length - 1) await delayMs(jitter(300, 800));
      }

      //Dedupe defensivo por id. Con el filtro por town_id en fetchColaCiudad
      //no debería haber duplicados, pero si el server cambia el shape de la
      //respuesta evitamos volver a disparar buyInstant sobre la misma orden.
      const unicas = Array.from(new Map(todas.map((o) => [o.id, o])).values());

      core.log(
        "finalizar",
        `colas consultadas: ${ciudades.length} ciudades, ${conOrdenes} con órdenes, ${unicas.length} órdenes totales` +
          (errores ? ` (${errores} con error)` : "")
      );
      return unicas;
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
        core.logError("finalizar", `fetch falló (town=${orden.town_id} id=${orden.id})`, e);
        return false;
      }

      if (!response || !response.json || !response.json.success) {
        core.logWarn(
          "finalizar",
          `respuesta sin success (town=${orden.town_id} id=${orden.id})`,
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

      const town_nombre = nombreCiudad(orden.town_id);
      core.log(
        "finalizar",
        `✓ ${town_nombre} ← ${orden.building_type} (id ${orden.id}) — "${response.json.success}"`,
        "ok"
      );
      registrarFinalizada(orden, String(response.json.success || ""), town_nombre);
      return true;
    }

    //—— API expuesta al panel ————————————————————————————————————————————
    //La tab "Construcción" llama estas funciones para encender/apagar el
    //ciclo desde su propio botón. No usa el play/pause global.
    JamBot.features.finalizarConstruccion.api = {
      setHabilitada,
      isHabilitada: () => habilitada,
    };

    //Arranque automático si el flag persistido estaba en true. Igual que el
    //resto de features autónomas (mercadoOro, ataquesEntrantes).
    reconciliar();
  }

  JamBot.features.finalizarConstruccion = { init };
})();
