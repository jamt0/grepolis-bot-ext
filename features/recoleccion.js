/* features/recoleccion.js — recolección de recursos en aldeas (farm towns).
 *
 * Mantiene el comportamiento previo del bot: al hacer click en su botón se
 * dispara un ciclo que recorre todas las ciudades y reclama recursos en
 * cada aldea. Tras terminar reagenda el siguiente ciclo según
 * data.tiempoRecoleccion (con margen) o 30s si hay CAPTCHA activo.
 */
(function () {
  const JamBot = (window.JamBot = window.JamBot || {});
  JamBot.features = JamBot.features || {};

  /**
   * Inicializa la feature. `ctx` viene del core.init() y tiene
   * { data, game: {csrfToken, world_id, townId, player_id}, core: {…} }.
   */
  async function init(ctx) {
    const { data, game, core } = ctx;
    const { csrfToken, world_id, townId } = game;

    //—— Estado de la feature ———————————————————————————————————————————

    const ciudadesConAldeas = [];
    const recursosPrevPorCiudad = {};
    //Última vez que cada ciudad completó al menos un claim. Se usa como gate
    //de cooldown 5/10min antes de volver a procesarla en un tick.
    const lastClaimAtPorCiudad = {};
    let proximoTickId = null;
    //Timestamp del próximo tick programado — el panel lo usa para mostrar
    //un countdown. null cuando no hay tick programado (pausado o en curso).
    let proximoTickAt = null;
    //Interval handle para el auto-refresh del header del panel mientras está
    //abierto. null cuando el panel está cerrado.
    let intervalActualizarPanel = null;

    //—— Carga inicial ———————————————————————————————————————————————————
    //
    //Cargamos primero los datos del juego y recién después insertamos el
    //botón. Si el usuario lo clickea con la lista vacía no haría nada útil.

    console.log("[JamBot/recoleccion] obteniendo info...");
    await obtenerCiudadesConAldeas();
    data.relacionPorAldea = await obtenerMapaRelaciones();
    //Config por ciudad persistida en chrome.storage.local. Cada entrada:
    //{ minutos: 5|10, opcion: 1|2 }. Sin override → se usa el default de
    //data.json (opcionRecoleccion / tiempoRecoleccion).
    const configPorCiudad = await cargarConfigPorCiudad();
    console.log("[JamBot/recoleccion] carga OK", {
      ciudades: ciudadesConAldeas.length,
      relaciones: Object.keys(data.relacionPorAldea || {}).length,
      configCiudades: Object.keys(configPorCiudad).length,
    });

    //—— Storage de config por ciudad ———————————————————————————————————

    function cargarConfigPorCiudad() {
      return new Promise((resolve) => {
        chrome.storage.local.get("jambotConfig", (obj) => {
          const cfg = (obj && obj.jambotConfig && obj.jambotConfig.porCiudad) || {};
          resolve(cfg);
        });
      });
    }

    function guardarConfigPorCiudad() {
      //Merge contra lo que haya en storage para no pisar otras claves
      //(e.g. finalizarHabilitado del toggle del panel).
      return new Promise((resolve) => {
        chrome.storage.local.get("jambotConfig", (obj) => {
          const cfgPrev = (obj && obj.jambotConfig) || {};
          chrome.storage.local.set(
            { jambotConfig: { ...cfgPrev, porCiudad: configPorCiudad } },
            resolve
          );
        });
      });
    }

    function getConfigCiudad(codigoCiudad) {
      const override = configPorCiudad[codigoCiudad];
      const minutos =
        override && (override.minutos === 5 || override.minutos === 10)
          ? override.minutos
          : data.tiempoRecoleccion || 5;
      //IMPORTANTE: option=1 SIEMPRE — es el primer botón "Recoger" del juego,
      //el más corto y más rentable. Su duración real depende de si la ciudad
      //estudió la habilidad de academia "Lealtad de los Aldeanos" (duplica
      //tiempos, +115% recursos): sin habilidad rinde 5min, con habilidad
      //rinde 10min. La elección 5/10 del panel sirve para que el usuario
      //le indique al bot el cooldown real de cada ciudad. Las opciones 2-4
      //del juego (10/20/4h sin habilidad, 40min/3h/8h con habilidad) no se
      //usan nunca: rinden peor por hora y se acumula riesgo de almacén lleno.
      return { minutos, opcion: 1 };
    }

    /**
     * Retorna el tiempo (en minutos) que debe usar el ciclo global del bot.
     * Es el MÍNIMO entre todos los tiempos configurados por ciudad — así
     * el bot tickea con la frecuencia de la ciudad más rápida y deja que
     * el cooldown gating salte a las que aún están bloqueadas. Si no hay
     * ciudades configuradas, usa el default de data.json.
     */
    function tiempoCicloMinutos() {
      let min = Infinity;
      for (const ciudad of ciudadesConAldeas) {
        const cfg = getConfigCiudad(ciudad.codigoCiudad);
        if (cfg.minutos < min) min = cfg.minutos;
      }
      return min === Infinity ? data.tiempoRecoleccion || 5 : min;
    }

    //—— Anti-CAPTCHA: helpers de aleatoriedad ——————————————————————————
    //
    //La detección bot del juego se dispara por *patrones*: intervalos exactos,
    //orden fijo de aldeas, mismo payload repetido. Estos helpers rompen esos
    //ejes:
    //  - jitter() varía el tiempo entre claims y entre ciclos
    //  - shuffle() Fisher-Yates baraja ciudades y aldeas en cada ciclo
    //
    //Tradeoff: yields un poquito menores (los tiempos se estiran ~1-2s por
    //claim) a cambio de huella mucho menos detectable.

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

    //—— UI ——————————————————————————————————————————————————————————————

    const boton = core.registrarBoton({
      id: "botonRecolectarRecursos",
      label: "▶",
      onClick: () => core.togglePlayPause(),
    });
    pintarEstadoBoton("pausado");

    //Reaccionar al play/pause global: cancelar tick al pausar, arrancar al
    //despausar. El estado se sincroniza con `core.isPaused()`.
    core.onPlayPauseChange((p) => {
      if (p) {
        if (proximoTickId) clearTimeout(proximoTickId);
        proximoTickId = null;
        proximoTickAt = null;
        pintarEstadoBoton("pausado");
      } else {
        pintarEstadoBoton("corriendo");
        recolectarRecursos();
      }
    });

    //Botón ⚙ + panel de config por ciudad
    const panelConfig = crearPanelConfig();
    core.registrarBoton({
      id: "botonConfigJam",
      label: "⚙",
      onClick: () => togglePanelConfig(panelConfig),
    });

    function crearPanelConfig() {
      const panel = document.createElement("div");
      panel.id = "panelConfigJam";
      panel.style.cssText =
        "position:absolute;bottom:120px;left:80px;z-index:1000;" +
        "background:#2a2a2a;color:#fff;padding:10px;border:1px solid #555;" +
        "border-radius:4px;display:none;min-width:220px;max-height:60vh;" +
        "overflow-y:auto;font-family:sans-serif;font-size:12px;" +
        "box-shadow:0 2px 8px rgba(0,0,0,0.4)";
      document.body.appendChild(panel);
      return panel;
    }

    function togglePanelConfig(panel) {
      const visible = panel.style.display !== "none";
      if (visible) {
        panel.style.display = "none";
        if (intervalActualizarPanel) {
          clearInterval(intervalActualizarPanel);
          intervalActualizarPanel = null;
        }
      } else {
        panel.style.display = "block";
        renderPanelConfig(panel);
        //Auto-refresh del header (estado + countdown) cada 1s mientras el
        //panel esté abierto. Se cancela al cerrarlo para no gastar CPU.
        intervalActualizarPanel = setInterval(() => {
          actualizarHeaderPanel(panel);
        }, 1000);
      }
    }

    function renderPanelConfig(panel) {
      panel.innerHTML = "";

      //Header con estado del bot y countdown del próximo ciclo
      const header = document.createElement("div");
      header.id = "panelHeaderEstado";
      header.style.cssText =
        "margin-bottom:8px;padding-bottom:6px;border-bottom:1px solid #555;font-size:11px;line-height:1.5";
      panel.appendChild(header);
      actualizarHeaderPanel(panel);

      //Sección: features globales (toggles)
      const tituloFeatures = document.createElement("div");
      tituloFeatures.textContent = "Funciones";
      tituloFeatures.style.cssText = "font-weight:bold;margin-bottom:4px";
      panel.appendChild(tituloFeatures);
      panel.appendChild(crearFilaToggleFinalizar());

      const sep = document.createElement("div");
      sep.style.cssText = "border-top:1px solid #555;margin:8px 0";
      panel.appendChild(sep);

      const titulo = document.createElement("div");
      titulo.textContent = "Tiempo de recolección por ciudad";
      titulo.style.cssText =
        "font-weight:bold;margin-bottom:4px";
      panel.appendChild(titulo);

      if (!ciudadesConAldeas.length) {
        const vacio = document.createElement("div");
        vacio.textContent = "Cargando ciudades...";
        vacio.style.opacity = "0.7";
        panel.appendChild(vacio);
        return;
      }

      for (const ciudad of ciudadesConAldeas) {
        const cfg = getConfigCiudad(ciudad.codigoCiudad);
        const fila = document.createElement("div");
        fila.style.cssText =
          "display:flex;justify-content:space-between;align-items:center;gap:8px;margin:4px 0";

        const nombre = document.createElement("span");
        nombre.textContent = ciudad.nombreCiudad || ciudad.codigoCiudad;
        nombre.style.cssText = "flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";

        const select = document.createElement("select");
        select.style.cssText =
          "background:#1a1a1a;color:#fff;border:1px solid #555;padding:2px 4px";
        const op5 = document.createElement("option");
        op5.value = "5"; op5.textContent = "5 min";
        const op10 = document.createElement("option");
        op10.value = "10"; op10.textContent = "10 min";
        select.appendChild(op5);
        select.appendChild(op10);
        select.value = String(cfg.minutos);

        select.addEventListener("change", async () => {
          const minutos = parseInt(select.value, 10);
          //Solo guardamos `minutos` — el `opcion` siempre es 1 (forzado en
          //getConfigCiudad). El usuario elige aquí la frecuencia del ciclo
          //de cada ciudad, no la opción del juego.
          configPorCiudad[ciudad.codigoCiudad] = { minutos, opcion: 1 };
          await guardarConfigPorCiudad();
          console.log(
            `[JamBot/recoleccion] config ${ciudad.nombreCiudad || ciudad.codigoCiudad}: ${minutos}min`
          );
        });

        fila.appendChild(nombre);
        fila.appendChild(select);
        panel.appendChild(fila);
      }
    }

    function actualizarHeaderPanel(panel) {
      const header = panel.querySelector("#panelHeaderEstado");
      if (!header) return;

      let estadoTexto, estadoColor;
      if (core.isCaptchaActive()) {
        estadoTexto = "⚠ CAPTCHA";
        estadoColor = "#c0392b";
      } else if (core.isPaused()) {
        estadoTexto = "▶ Pausado";
        estadoColor = "#27ae60";
      } else {
        estadoTexto = "⏸ Corriendo";
        estadoColor = "#3498db";
      }

      let proximoTexto = "—";
      if (proximoTickAt) {
        const restanteSeg = Math.max(0, Math.round((proximoTickAt - Date.now()) / 1000));
        const min = Math.floor(restanteSeg / 60);
        const seg = restanteSeg % 60;
        proximoTexto = `${min}m ${String(seg).padStart(2, "0")}s`;
      }

      header.innerHTML =
        `<div><strong>Estado:</strong> <span style="color:${estadoColor}">${estadoTexto}</span></div>` +
        `<div><strong>Próximo ciclo:</strong> ${proximoTexto}</div>`;
    }

    /**
     * Fila con un checkbox "Finalizar construcción gratis". Lee el estado
     * desde chrome.storage.local (jambotConfig.finalizarHabilitado), con
     * fallback al default de data.json (data.finalizarGratis). Al cambiar,
     * persiste la decisión — la feature finalizarConstruccion escucha
     * chrome.storage.onChanged y reacciona automáticamente.
     */
    function crearFilaToggleFinalizar() {
      const fila = document.createElement("div");
      fila.style.cssText =
        "display:flex;justify-content:space-between;align-items:center;gap:8px;margin:4px 0";

      const label = document.createElement("span");
      label.textContent = "Finalizar construcción gratis";
      label.style.cssText = "flex:1";

      const check = document.createElement("input");
      check.type = "checkbox";
      check.style.cssText = "width:16px;height:16px;cursor:pointer";

      //Carga inicial async — el checkbox arranca apagado y se actualiza
      //apenas leemos el storage.
      chrome.storage.local.get("jambotConfig", (obj) => {
        const cfg = obj && obj.jambotConfig;
        const enabled =
          cfg && typeof cfg.finalizarHabilitado === "boolean"
            ? cfg.finalizarHabilitado
            : data.finalizarGratis === true;
        check.checked = enabled;
      });

      check.addEventListener("change", () => {
        chrome.storage.local.get("jambotConfig", (obj) => {
          const cfgPrev = (obj && obj.jambotConfig) || {};
          const cfgNuevo = { ...cfgPrev, finalizarHabilitado: check.checked };
          chrome.storage.local.set({ jambotConfig: cfgNuevo }, () => {
            console.log(
              `[JamBot/panel] finalizar construcción ${check.checked ? "ON" : "OFF"}`
            );
          });
        });
      });

      fila.appendChild(label);
      fila.appendChild(check);
      return fila;
    }

    function pintarEstadoBoton(estado) {
      switch (estado) {
        case "pausado":
          boton.setLabel("▶");
          boton.setStyle({ bg: "#27ae60", fg: "#fff" });
          break;
        case "corriendo":
          boton.setLabel("⏸");
          boton.setStyle({ bg: "#3498db", fg: "#fff" });
          break;
        case "captcha":
          boton.setLabel("⚠");
          boton.setStyle({ bg: "#c0392b", fg: "#fff" });
          break;
      }
    }

    //Reflejar cambios de CAPTCHA en el botón. Cuando se resuelve, volver
    //al estado anterior según core.isPaused().
    core.onCaptcha((active) => {
      if (active) pintarEstadoBoton("captcha");
      else pintarEstadoBoton(core.isPaused() ? "pausado" : "corriendo");
    });

    //—— Bridge: pedir recursos actuales del Town cargado en MM ———————————

    function queryTownResources(townId) {
      return new Promise((resolve) => {
        const handler = (e) => {
          if (e.source !== window) return;
          const msg = e.data;
          if (!msg || msg.type !== "JamBot:townResources") return;
          if (msg.townId != townId) return;
          window.removeEventListener("message", handler);
          clearTimeout(timeoutId);
          resolve(msg.resources || null);
        };
        window.addEventListener("message", handler);
        const timeoutId = setTimeout(() => {
          window.removeEventListener("message", handler);
          resolve(null);
        }, 1000);
        window.dispatchEvent(
          new CustomEvent("JamBot:queryTownResources", { detail: { townId } })
        );
      });
    }

    //—— Scheduler ———————————————————————————————————————————————————————

    function programarSiguienteTick(ms) {
      if (proximoTickId) clearTimeout(proximoTickId);
      proximoTickAt = Date.now() + ms;
      proximoTickId = setTimeout(async () => {
        proximoTickId = null;
        proximoTickAt = null;
        await recolectarRecursos();
      }, ms);
    }

    async function recolectarRecursos() {
      if (core.isPaused()) return;
      pintarEstadoBoton(core.isCaptchaActive() ? "captcha" : "corriendo");

      const inicioCiclo = Date.now();
      await recolectarCiudades();
      const duracionCiclo = Date.now() - inicioCiclo;

      //Si el usuario pausó durante el ciclo, no programamos el siguiente.
      if (core.isPaused()) return;

      //Compensación de duración del ciclo: el siguiente tick se programa
      //para que el INICIO del ciclo siguiente caiga (en promedio) a
      //tiempoCicloMinutos del inicio del actual, no de su fin. Sin esto,
      //cada vuelta acumula `duracionCiclo` como gap permanente vs el
      //cooldown del server (5/10min reales).
      //
      //Base = mínimo de tiempos configurados (5 o 10). Si todas las
      //ciudades están en 10min, el ciclo tickea cada 10 — no nos
      //despertamos cada 5min para no hacer nada.
      //
      //Margen de seguridad +3-30s: el server libera el cooldown EXACTAMENTE
      //a los 5 o 10min desde el último claim de cada aldea. Si el ciclo se
      //solapa demasiado (peor caso: aldea procesada al final del ciclo N
      //y al principio del N+1), el server rechaza el claim y el bot lo
      //interpreta como CAPTCHA falso. El margen mínimo de 3s cubre eso.
      const baseMs = tiempoCicloMinutos() * 60 * 1000;
      const tiempoEspera = core.isCaptchaActive()
        ? 30 * 1000
        : Math.max(30 * 1000, baseMs - duracionCiclo + jitter(3 * 1000, 30 * 1000));

      console.log(
        `[JamBot/recoleccion] ciclo duró ${Math.round(duracionCiclo / 1000)}s, siguiente en ${Math.round(tiempoEspera / 1000)}s${core.isCaptchaActive() ? " (modo CAPTCHA)" : ""}`
      );

      //Warning si el ciclo se está acercando al cooldown — a partir del 70%
      //hay riesgo de chocar con el cooldown del server cuando una ciudad
      //procesada al final del ciclo aparezca al principio del siguiente.
      //La solución es subir esas ciudades a 10min en el panel.
      if (duracionCiclo > baseMs * 0.7) {
        const pct = Math.round((duracionCiclo / baseMs) * 100);
        console.warn(
          `[JamBot/recoleccion] ⚠ ciclo (${Math.round(duracionCiclo / 1000)}s) ocupa el ${pct}% del cooldown (${Math.round(baseMs / 1000)}s). Riesgo de rechazo del server — subí ciudades a 10min.`
        );
      }

      pintarEstadoBoton(core.isCaptchaActive() ? "captcha" : "corriendo");
      programarSiguienteTick(tiempoEspera);
    }

    //—— Lógica de recolección ——————————————————————————————————————————

    async function recolectarCiudades() {
      let horaActual = new Date();
      console.log(
        `[JamBot/recoleccion] recolectando aldeas - ${horaActual.getHours()}:${horaActual.getMinutes()}:${horaActual.getSeconds()}`
      );

      //Reset por ciclo: si en un ciclo previo se cacheó "recursos llenos",
      //volvemos a intentar — quizá el jugador construyó cosas y bajaron.
      for (const c of ciudadesConAldeas) c.recursosLlenos = false;

      //Refresca el baseline del diff con el estado actual del Town en MM.
      //Sin esto, el primer claim del ciclo arrastra los 5 minutos transcurridos
      //(producción + acciones del jugador) y el diff sale absurdo.
      for (const c of ciudadesConAldeas) {
        const fresco = await queryTownResources(c.codigoCiudad);
        if (fresco) recursosPrevPorCiudad[c.codigoCiudad] = fresco;
      }

      const acumuladoCiclo = {};

      //Importante: NO hacer early-skip aquí aunque captcha esté activo.
      //Necesitamos hacer al menos un claim de "probe" para detectar si el
      //CAPTCHA ya se resolvió. La detección post-claim cortará el ciclo si
      //sigue activo.
      //Shuffle del orden de ciudades en cada ciclo — un humano no farmea
      //siempre A→B→C→D, varía el orden naturalmente.
      const ahora = Date.now();
      for (const ciudad of shuffle(ciudadesConAldeas)) {
        const cfg = getConfigCiudad(ciudad.codigoCiudad);
        const last = lastClaimAtPorCiudad[ciudad.codigoCiudad] || 0;
        const transcurrido = ahora - last;
        //Margen de 30s para no saltar una ciudad "casi vencida" por jitter
        //del setTimeout. No mandamos request si aún está en cooldown — el
        //server lo rechazaría sin notification 'Town' y dispararía falso
        //positivo de CAPTCHA.
        const cooldownMs = cfg.minutos * 60 * 1000 - 30 * 1000;
        if (last > 0 && transcurrido < cooldownMs) {
          const restante = Math.round((cooldownMs - transcurrido) / 1000);
          console.log(
            `[JamBot/recoleccion] ${ciudad.nombreCiudad || ciudad.codigoCiudad}: en cooldown (${cfg.minutos}min) — ${restante}s restantes, saltando`
          );
          continue;
        }

        acumuladoCiclo[ciudad.codigoCiudad] = { wood: 0, stone: 0, iron: 0, claims: 0 };
        await recolectarCiudad(ciudad, acumuladoCiclo[ciudad.codigoCiudad], cfg.opcion);
        if (acumuladoCiclo[ciudad.codigoCiudad].claims > 0) {
          lastClaimAtPorCiudad[ciudad.codigoCiudad] = Date.now();
        }
        if (core.isCaptchaActive()) {
          console.warn("[JamBot/recoleccion] CAPTCHA activo — abortando ciclo");
          break;
        }
      }

      //Resumen por ciudad (solo las que tuvieron al menos un claim contado)
      for (const ciudad of ciudadesConAldeas) {
        const acc = acumuladoCiclo[ciudad.codigoCiudad];
        if (!acc || acc.claims === 0) continue;
        const nombre = ciudad.nombreCiudad || ciudad.codigoCiudad;
        console.log(
          `[JamBot/recoleccion] === ${nombre} (tanda): ${acc.claims} aldeas → +${acc.wood} madera, +${acc.stone} piedra, +${acc.iron} plata ===`
        );
      }
    }

    async function recolectarCiudad(ciudad, acumulador, opcion) {
      const { aldeas } = ciudad;
      //Shuffle del orden de aldeas dentro de la ciudad — mismo argumento
      //que ciudades: rompe el patrón "siempre claim 1, después 2, después 3…".
      for (const aldea of shuffle(aldeas)) {
        try {
          await recolectarAldea(ciudad, aldea, acumulador, opcion);
        } catch (e) {
          console.error("[JamBot/recoleccion] falló aldea", aldea && aldea.id, e);
        }
        if (core.isCaptchaActive()) break;
      }
    }

    async function recolectarAldea(ciudad, aldea, acumulador, opcion) {
      const { recursosLlenos, codigoCiudad } = ciudad;

      if (recursosLlenos) return;

      const farmTownId = aldea.id;
      const relationId = data.relacionPorAldea && data.relacionPorAldea[farmTownId];
      if (relationId == null) {
        console.warn("[JamBot/recoleccion] sin relation_id para farm_town_id", farmTownId, "— saltada");
        return;
      }

      //Jitter 1.0-1.5s entre claims. Variabilidad mínima necesaria para
      //romper el patrón "delay exacto entre requests" sin alargar el ciclo
      //(cada segundo extra se acumula como gap permanente vs. el cooldown
      //del server).
      await delayMs(jitter(1000, 1500));

      const json = {
        model_url: `FarmTownPlayerRelation/${relationId}`,
        action_name: "claim",
        captcha: null,
        arguments: {
          farm_town_id: farmTownId,
          type: "resources",
          option: opcion,
        },
        town_id: codigoCiudad,
        nl_init: true,
      };

      const datos = new URLSearchParams();
      datos.append("json", JSON.stringify(json));

      let response = await fetch(
        `https://${world_id}.grepolis.com/game/frontend_bridge?town_id=${codigoCiudad}&action=execute&h=${csrfToken}`,
        {
          method: "POST",
          headers: {
            "X-Requested-With": "XMLHttpRequest",
            accept: "text/plain, */*; q=0.01",
          },
          body: datos,
        }
      );
      response = await response.json();

      if (!response.json["success"]) return;

      window.dispatchEvent(
        new CustomEvent("JamBot:dispatchNotifications", {
          detail: { notifications: response.json.notifications },
        })
      );

      const townNotification = response.json.notifications.find(
        (element) => element.subject == "Town"
      );

      if (!townNotification) {
        console.warn(
          "[JamBot/recoleccion] sin notificación 'Town' para aldea", farmTownId,
          "— probable CAPTCHA. Notifications:", response.json.notifications
        );
        core.onCaptchaDetectado();
        return;
      }

      if (core.isCaptchaActive()) core.onCaptchaResuelto();

      const town = JSON.parse(townNotification.param_str)["Town"];
      const { storage, last_wood, last_iron, last_stone, resources } = town;

      const nombreCiudad = ciudad.nombreCiudad || codigoCiudad;
      const nombreAldea = aldea.name || `farm_${farmTownId}`;
      const prev = recursosPrevPorCiudad[codigoCiudad];
      if (prev && resources) {
        const dW = resources.wood - prev.wood;
        const dS = resources.stone - prev.stone;
        const dI = resources.iron - prev.iron;
        console.log(
          `[JamBot/recoleccion] ${nombreCiudad} ← ${nombreAldea} (id ${farmTownId}): +${dW} madera, +${dS} piedra, +${dI} plata · total ${resources.wood}/${resources.stone}/${resources.iron}`
        );
        if (acumulador) {
          acumulador.wood += dW;
          acumulador.stone += dS;
          acumulador.iron += dI;
          acumulador.claims += 1;
        }
      } else if (resources) {
        console.log(
          `[JamBot/recoleccion] ${nombreCiudad} ← ${nombreAldea} (id ${farmTownId}): recolectada · total ${resources.wood}/${resources.stone}/${resources.iron}`
        );
        if (acumulador) acumulador.claims += 1;
      }
      if (resources) recursosPrevPorCiudad[codigoCiudad] = { ...resources };

      const idx = ciudadesConAldeas.findIndex((c) => c.codigoCiudad == codigoCiudad);
      if (idx >= 0) {
        ciudadesConAldeas[idx].recursosLlenos =
          storage == last_wood && storage == last_iron && storage == last_stone;
      }
    }

    //—— Loaders ————————————————————————————————————————————————————————

    async function obtenerMapaRelaciones() {
      const json = `{"collections":{"FarmTownPlayerRelations":[]},"town_id":${townId},"nl_init":false}`;
      const url = `https://${world_id}.grepolis.com/game/frontend_bridge?town_id=${townId}&action=refetch&h=${csrfToken}&json=${encodeURIComponent(json)}`;

      let res = await fetch(url, {
        method: "GET",
        headers: {
          "X-Requested-With": "XMLHttpRequest",
          accept: "text/plain, */*; q=0.01",
        },
      });
      res = await res.json();

      const items =
        (res.json &&
          res.json.collections &&
          res.json.collections.FarmTownPlayerRelations &&
          res.json.collections.FarmTownPlayerRelations.data) ||
        [];

      const mapa = {};
      for (const item of items) {
        const rel = item.d || item;
        if (rel && rel.farm_town_id != null && rel.id != null) {
          mapa[rel.farm_town_id] = rel.id;
        }
      }
      return mapa;
    }

    async function obtenerCiudadesConAldeas() {
      let ciudadesJugador = await fetch(
        `https://${world_id}.grepolis.com/game/frontend_bridge?town_id=${townId}&action=refetch&h=${csrfToken}&json={"collections":{"Towns":[]},"town_id":${townId},"nl_init":false}`,
        {
          method: "GET",
          headers: {
            "X-Requested-With": "XMLHttpRequest",
            accept: "text/plain, */*; q=0.01",
          },
        }
      );
      ciudadesJugador = await ciudadesJugador.json();
      ciudadesJugador = ciudadesJugador.json.collections.Towns.data;

      for (const ciudadJugador of ciudadesJugador) {
        const ciudad = ciudadJugador.d;
        await core.delaySeconds(0.2);
        let aldeasCiudad = await fetch(
          `https://${world_id}.grepolis.com/game/island_info?town_id=${ciudad.id}&action=index&h=${csrfToken}&json={"island_id":${ciudad.island_id},"fetch_tmpl":1,"town_id":${ciudad.id},"nl_init":true}`,
          {
            method: "GET",
            headers: {
              "X-Requested-With": "XMLHttpRequest",
              accept: "text/plain, */*; q=0.01",
            },
          }
        );
        aldeasCiudad = await aldeasCiudad.json();
        aldeasCiudad = aldeasCiudad.json.json.farm_town_list;

        ciudadesConAldeas.push({
          codigoCiudad: ciudad.id,
          nombreCiudad: ciudad.name,
          aldeas: aldeasCiudad,
        });

        data.ciudadesConAldeas = ciudadesConAldeas;
      }
    }
  }

  JamBot.features.recoleccion = { init };
})();
