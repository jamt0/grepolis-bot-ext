/* features/recoleccionUnidades.js — reclutamiento de unidades en aldeas.
 *
 * Endpoint idéntico al de recolección de recursos, solo cambia `type:"units"`
 * y `option`:
 *   1 = infante (espadachín)
 *   2 = hondero
 *   3 = arquero
 *   4 = hoplita
 * El orden es fijo y todas las aldeas ofrecen siempre lo mismo.
 *
 * Por aldea el server solo deja reclutar UN tipo cada 3h (cooldown
 * compartido). El usuario elige cuál tipo quiere por ciudad, y esa
 * preferencia aplica a las 6 aldeas de esa ciudad. Si la ciudad está en
 * "Apagada", no se toca ninguna de sus aldeas.
 *
 * Dos modos de disparo (compatibles entre sí):
 *
 *   1. MANUAL — botón "Reclutar en N ciudades". Recorre todas las ciudades
 *      activas inmediatamente. No respeta horario (manual = manual).
 *
 *   2. AUTO — toggle persistido. recoleccion.js emite
 *      `JamBot:ciudadLimiteDiario` cuando una ciudad pega el cap diario de
 *      recursos. Si el toggle está prendido Y faltan ≥3h hasta medianoche
 *      Madrid Y la ciudad tiene config activa, se encola un ciclo para esa
 *      ciudad. El corte de 3h evita reclutar tan tarde que el cooldown de
 *      las unidades termine después del reset de medianoche (perderíamos
 *      tiempo de recolección de recursos del día siguiente).
 *
 * Cadencia: 500–1000 ms de jitter entre aldeas. Un único POST por aldea.
 * (El resto del bot usa 2–2.5s; acá es más rápido a pedido del usuario
 * porque el ciclo es on-demand — quiere ver el resultado pronto.)
 *
 * Persistencia (chrome.storage.local, namespaceada por world_id):
 *   - jambotUnidadesConfig_${world_id}      → { [codigoCiudad]: 0|1|2|3|4 }
 *   - jambotUnidadesAutoEnabled_${world_id} → bool
 *
 * Reutiliza `data.relacionPorAldea` que publica recoleccion.init() durante
 * el bootstrap — por eso este script va después de recoleccion.js en el
 * manifest.
 */
(function () {
  const JamBot = (window.JamBot = window.JamBot || {});
  JamBot.features = JamBot.features || {};

  const TIPOS_UNIDAD = [
    { option: 0, label: "Apagada", colorPill: "#7a8aa0" },
    { option: 1, label: "Infante", colorPill: "#cdd5e0" },
    { option: 2, label: "Hondero", colorPill: "#e6a86b" },
    { option: 3, label: "Arquero", colorPill: "#3498db" },
    { option: 4, label: "Hoplita", colorPill: "#9b59b6" },
  ];
  const LABEL_POR_OPTION = Object.fromEntries(TIPOS_UNIDAD.map((t) => [t.option, t.label]));

  async function init(ctx) {
    const { data, game, core } = ctx;
    const { csrfToken, world_id } = game;

    const STORAGE_KEY_CONFIG = `jambotUnidadesConfig_${world_id}`;
    // { [codigoCiudad:string|number]: 0|1|2|3|4 } — 0 = apagada.
    let configPorCiudad = {};

    // Toggle del modo automático: cuando una ciudad pega cap diario en
    // recolección de recursos, recoleccion.js emite `JamBot:ciudadLimiteDiario`.
    // Si autoEnabled === true Y faltan ≥3h hasta medianoche Madrid Y la
    // ciudad tiene config activa, encolamos un ciclo de reclutamiento.
    const STORAGE_KEY_AUTO = `jambotUnidadesAutoEnabled_${world_id}`;
    let autoEnabled = false;

    // Dedup de "ya intenté reclutar en esta ciudad hoy" (TZ Madrid). Persistido
    // para sobrevivir reloads — si no, prender el toggle después de un reload
    // dispararía un nuevo ciclo aunque ya hubieras reclutado a la mañana.
    // Lo manejamos acá (no en recoleccion.js) para que recoleccion pueda
    // re-emitir el evento sin que se pierda cuando el toggle estaba apagado:
    // recoleccion solo sabe "está saturada", recoleccionUnidades sabe "ya la
    // procesé". Se llena cuando ejecutarCiclo arranca para una ciudad,
    // independientemente del resultado por aldea (cooldown / sin pob /
    // reclutado cuentan todos como "ya la atendí hoy").
    const STORAGE_KEY_PROCESADAS = `jambotUnidadesProcesadasHoy_${world_id}`;
    const ciudadesProcesadasHoy = new Set();
    let diaProcesadasActual = null;

    function diaActualMadrid() {
      try {
        return new Intl.DateTimeFormat("en-CA", {
          timeZone: "Europe/Madrid",
          year: "numeric", month: "2-digit", day: "2-digit",
        }).format(new Date());
      } catch (_) {
        return new Date().toISOString().slice(0, 10);
      }
    }

    // Margen de seguridad antes de medianoche Madrid. Las unidades tardan
    // 3 h en estar disponibles después del claim; si claimeamos con <3 h
    // hasta el reset, perderíamos tiempo de recolección de recursos del
    // día siguiente (las aldeas quedarían en cooldown de unidades cuando
    // ya se reseteó el cap).
    const MARGEN_MEDIANOCHE_HORAS = 3;

    let cicloEnCurso = false;
    let cancelar = false;
    let progreso = nuevoProgreso(0);

    // Cola FIFO de codigoCiudad pendientes para reclutar en modo auto.
    // Se llena cuando llegan eventos durante un ciclo en curso, y se drena
    // al cerrar el ciclo. Set para deduplicar — si la misma ciudad entra
    // dos veces (poco probable: notificarHoy ya filtra), se procesa una sola.
    const colaAuto = new Set();

    function nuevoProgreso(totalAldeas) {
      return {
        aldeasProcesadas: 0,
        totalAldeas,
        aldeasOk: 0,
        aldeasEnCooldown: 0,
        aldeasSaltadas: 0,
        aldeasConError: 0,
        errores: [],
      };
    }

    function jitter(minMs, maxMs) {
      return minMs + Math.random() * (maxMs - minMs);
    }
    function delayMs(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms));
    }

    //—— Persistencia ————————————————————————————————————————————————————

    async function cargarConfig() {
      try {
        const obj = await new Promise((resolve) => {
          chrome.storage.local.get([STORAGE_KEY_CONFIG], (o) => resolve(o || {}));
        });
        const raw = obj[STORAGE_KEY_CONFIG];
        if (raw && typeof raw === "object") {
          const limpio = {};
          for (const [k, v] of Object.entries(raw)) {
            const n = Number(v);
            if (Number.isInteger(n) && n >= 0 && n <= 4) limpio[k] = n;
          }
          configPorCiudad = limpio;
        }
      } catch (_) { /* sin storage — config queda vacía */ }
    }

    function persistirConfig() {
      try {
        chrome.storage.local.set({ [STORAGE_KEY_CONFIG]: configPorCiudad });
      } catch (_) {}
    }

    async function cargarAuto() {
      try {
        const obj = await new Promise((resolve) => {
          chrome.storage.local.get([STORAGE_KEY_AUTO], (o) => resolve(o || {}));
        });
        if (typeof obj[STORAGE_KEY_AUTO] === "boolean") {
          autoEnabled = obj[STORAGE_KEY_AUTO];
        }
      } catch (_) { /* default false */ }
    }

    function persistirAuto() {
      try {
        chrome.storage.local.set({ [STORAGE_KEY_AUTO]: autoEnabled });
      } catch (_) {}
    }

    async function cargarProcesadasHoy() {
      try {
        const obj = await new Promise((resolve) => {
          chrome.storage.local.get([STORAGE_KEY_PROCESADAS], (o) => resolve(o || {}));
        });
        const raw = obj[STORAGE_KEY_PROCESADAS];
        const hoy = diaActualMadrid();
        if (raw && typeof raw === "object" && raw.dia === hoy && Array.isArray(raw.ciudades)) {
          diaProcesadasActual = hoy;
          for (const c of raw.ciudades) ciudadesProcesadasHoy.add(String(c));
        } else {
          // Día distinto (o sin datos) → arrancamos limpio.
          diaProcesadasActual = hoy;
        }
      } catch (_) {
        diaProcesadasActual = diaActualMadrid();
      }
    }

    function persistirProcesadasHoy() {
      try {
        chrome.storage.local.set({
          [STORAGE_KEY_PROCESADAS]: {
            dia: diaProcesadasActual,
            ciudades: Array.from(ciudadesProcesadasHoy),
          },
        });
      } catch (_) {}
    }

    function rolloverProcesadasSiCorresponde() {
      const hoy = diaActualMadrid();
      if (hoy !== diaProcesadasActual) {
        diaProcesadasActual = hoy;
        ciudadesProcesadasHoy.clear();
        persistirProcesadasHoy();
      }
    }

    function marcarProcesadas(codigosCiudad) {
      rolloverProcesadasSiCorresponde();
      let cambio = false;
      for (const c of codigosCiudad) {
        const k = String(c);
        if (!ciudadesProcesadasHoy.has(k)) {
          ciudadesProcesadasHoy.add(k);
          cambio = true;
        }
      }
      if (cambio) persistirProcesadasHoy();
    }

    //—— Hora Madrid ———————————————————————————————————————————————————
    //
    // El server del juego está en hora española (Europe/Madrid). El cap
    // diario de recursos se resetea a las 00:00 de Madrid. Usamos `Intl`
    // con `timeZone: "Europe/Madrid"` para que el cálculo sea correcto
    // sin importar la TZ del navegador del usuario y respete DST.
    function segundosHastaMedianocheMadrid() {
      try {
        const parts = new Intl.DateTimeFormat("en-GB", {
          timeZone: "Europe/Madrid",
          hourCycle: "h23",
          hour: "2-digit", minute: "2-digit", second: "2-digit",
        }).formatToParts(new Date());
        const h = Number(parts.find((p) => p.type === "hour").value);
        const m = Number(parts.find((p) => p.type === "minute").value);
        const s = Number(parts.find((p) => p.type === "second").value);
        return 86400 - ((h % 24) * 3600 + m * 60 + s);
      } catch (_) {
        // Fallback: hora local del navegador.
        const d = new Date();
        return 86400 - (d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds());
      }
    }

    function formatearHorasMinutos(segundos) {
      const h = Math.floor(segundos / 3600);
      const m = Math.floor((segundos % 3600) / 60);
      return `${h}h ${String(m).padStart(2, "0")}m`;
    }

    // Orden alfabético-natural por nombre de ciudad (mismo criterio que
    // recoleccion.js — `numeric:true` ordena "002 Jam" antes que "010 Jam").
    function ciudadesOrdenadas() {
      const ciudades = (data && data.ciudadesConAldeas) || [];
      return ciudades.slice().sort((a, b) =>
        (a.nombreCiudad || "").localeCompare(b.nombreCiudad || "", undefined, { numeric: true })
      );
    }

    function ciudadesActivas() {
      return ciudadesOrdenadas().filter((c) => {
        const opt = configPorCiudad[c.codigoCiudad];
        return Number.isInteger(opt) && opt > 0;
      });
    }

    //—— Ciclo ———————————————————————————————————————————————————————————

    async function reclutarAldea(ciudad, aldea, option) {
      const relationId = data.relacionPorAldea && data.relacionPorAldea[aldea.id];
      if (relationId == null) {
        return { ok: false, motivo: "sin-relation_id", errorMsg: "sin relation_id" };
      }

      const json = {
        model_url: `FarmTownPlayerRelation/${relationId}`,
        action_name: "claim",
        captcha: null,
        arguments: { farm_town_id: aldea.id, type: "units", option },
        town_id: ciudad.codigoCiudad,
        nl_init: true,
      };
      const datos = new URLSearchParams();
      datos.append("json", JSON.stringify(json));

      const ctrl = new AbortController();
      const abortId = setTimeout(() => ctrl.abort(), 30 * 1000);
      let response;
      try {
        response = await fetch(
          `https://${world_id}.grepolis.com/game/frontend_bridge?town_id=${ciudad.codigoCiudad}&action=execute&h=${csrfToken}`,
          {
            method: "POST",
            headers: {
              "X-Requested-With": "XMLHttpRequest",
              accept: "text/plain, */*; q=0.01",
            },
            body: datos,
            signal: ctrl.signal,
          }
        );
      } catch (e) {
        clearTimeout(abortId);
        return { ok: false, motivo: "fetch-error", errorMsg: (e && e.message) || "fetch-error" };
      }
      clearTimeout(abortId);

      let payload;
      try {
        payload = await response.json();
      } catch (e) {
        return { ok: false, motivo: "json-parse", errorMsg: (e && e.message) || "json-parse" };
      }

      const r = (payload && payload.json) || {};
      if (!r.success) {
        const errorMsg =
          (r.errors && r.errors[0]) ||
          r.error_msg ||
          r.error ||
          "success=false";
        // Mismo regex de cooldown que recoleccion de recursos — el server usa
        // la misma frase para ambos tipos.
        const esCooldown = typeof errorMsg === "string" &&
          /no est[áa] lista|not ready|cooldown|already claim/i.test(errorMsg);
        // Población libre es a nivel ciudad: si una aldea responde esto,
        // las 5 hermanas van a responder igual. ejecutarCiclo usa este
        // motivo para abortar el resto de las aldeas de la ciudad y pasar
        // a la siguiente — evita 5 POSTs y 5 jitters por nada.
        const esSinPoblacion = typeof errorMsg === "string" &&
          /no hay suficiente poblaci[óo]n|not enough.*population|insufficient.*population/i.test(errorMsg);
        let motivo = "error";
        if (esCooldown) motivo = "cooldown";
        else if (esSinPoblacion) motivo = "sin-poblacion";
        return { ok: false, motivo, errorMsg };
      }

      // Re-dispatch a Backbone para que la UI del juego (recursos, población,
      // tropas en cola) se mantenga sincronizada sin recargar la página.
      if (Array.isArray(r.notifications) && r.notifications.length) {
        window.dispatchEvent(new CustomEvent("JamBot:dispatchNotifications", {
          detail: { notifications: r.notifications },
        }));
      }
      return { ok: true };
    }

    // opts.ciudadesEspecificas — si se pasa, ignora `configPorCiudad` para el
    //   filtro de cuáles ciudades correr y usa solo esas (igual respeta la
    //   config para resolver qué `option` mandar). Lo usa el modo auto.
    // opts.origen — "manual" | "auto" para el log inicial.
    async function ejecutarCiclo(opts = {}) {
      if (cicloEnCurso) return;
      let ciudades;
      if (Array.isArray(opts.ciudadesEspecificas)) {
        const ids = new Set(opts.ciudadesEspecificas.map(String));
        ciudades = ciudadesOrdenadas().filter((c) => {
          const opt = configPorCiudad[c.codigoCiudad];
          return ids.has(String(c.codigoCiudad)) && Number.isInteger(opt) && opt > 0;
        });
      } else {
        ciudades = ciudadesActivas();
      }
      if (!ciudades.length) {
        if (opts.origen !== "auto") {
          core.logWarn(
            "recoleccionUnidades",
            "no hay ciudades activas — elegí un tipo de unidad por ciudad antes de reclutar"
          );
        }
        return;
      }

      cicloEnCurso = true;
      cancelar = false;
      const totalAldeas = ciudades.reduce(
        (acc, c) => acc + (Array.isArray(c.aldeas) ? c.aldeas.length : 0), 0
      );
      progreso = nuevoProgreso(totalAldeas);
      const origen = opts.origen === "auto" ? "auto" : "manual";
      core.log(
        "recoleccionUnidades",
        `iniciando ciclo ${origen}: ${ciudades.length} ciudad(es), ${totalAldeas} aldeas`
      );
      // Solo el modo auto persiste "ya procesé esta ciudad hoy". El manual
      // es disparado a mano por el usuario; si quiere correrlo otra vez
      // mientras está open, lo deja correr. El gating "1 vez por día" es
      // específicamente para evitar bucles del auto.
      if (origen === "auto") {
        marcarProcesadas(ciudades.map((c) => c.codigoCiudad));
      }

      try {
        for (const ciudad of ciudades) {
          if (cancelar) break;
          const option = configPorCiudad[ciudad.codigoCiudad];
          if (!option) continue; // por si la config cambió mientras corría
          const tipoLabel = LABEL_POR_OPTION[option] || `option ${option}`;
          const aldeas = Array.isArray(ciudad.aldeas) ? ciudad.aldeas : [];
          const ciudadNombre = ciudad.nombreCiudad || `ciudad ${ciudad.codigoCiudad}`;
          for (let i = 0; i < aldeas.length; i++) {
            if (cancelar) break;
            const aldea = aldeas[i];

            const aldeaNombre = aldea.name || `farm_${aldea.id}`;
            const r = await reclutarAldea(ciudad, aldea, option);
            progreso.aldeasProcesadas += 1;
            const prefijo = `[${progreso.aldeasProcesadas}/${progreso.totalAldeas}] ${ciudadNombre}/${aldeaNombre} (${tipoLabel})`;
            if (r.ok) {
              progreso.aldeasOk += 1;
              core.log("recoleccionUnidades", `${prefijo}: ✓ reclutado`, "ok");
            } else if (r.motivo === "cooldown") {
              progreso.aldeasEnCooldown += 1;
              core.log("recoleccionUnidades", `${prefijo}: en cooldown`);
            } else if (r.motivo === "sin-poblacion") {
              // La población libre es a nivel ciudad: las aldeas hermanas van
              // a fallar igual. Cuento la actual como saltada, marco el resto
              // de las aldeas de esta ciudad como saltadas (sin POST) y paso
              // a la siguiente ciudad.
              progreso.aldeasSaltadas += 1;
              const restantes = aldeas.length - 1 - i;
              progreso.aldeasProcesadas += restantes;
              progreso.aldeasSaltadas += restantes;
              core.logWarn(
                "recoleccionUnidades",
                `${prefijo}: sin población libre — salteando las ${restantes} aldea(s) restantes de ${ciudadNombre}`
              );
              break;
            } else {
              progreso.aldeasConError += 1;
              core.logWarn("recoleccionUnidades", `${prefijo}: ${r.errorMsg}`);
              if (progreso.errores.length < 20) {
                progreso.errores.push(`${ciudadNombre}/${aldeaNombre} (${tipoLabel}): ${r.errorMsg}`);
              }
            }

            if (!cancelar) await delayMs(jitter(500, 1000));
          }
        }
      } catch (e) {
        core.logError("recoleccionUnidades", "ciclo falló inesperadamente", e);
      } finally {
        const estado = cancelar ? "cancelado" : "finalizado";
        core.log(
          "recoleccionUnidades",
          `ciclo ${origen} ${estado}: ${progreso.aldeasProcesadas}/${progreso.totalAldeas} aldeas · ${progreso.aldeasOk} OK · ${progreso.aldeasEnCooldown} en cooldown · ${progreso.aldeasSaltadas} sin pob. · ${progreso.aldeasConError} con error`,
          cancelar ? "warn" : "ok"
        );
        cicloEnCurso = false;
      }
      // Si quedaron ciudades en la cola del auto, drenarlas ahora — fuera
      // del bloque finally para que el flag `cicloEnCurso` ya esté en false.
      if (colaAuto.size > 0 && !cancelar) {
        drenarColaAuto();
      }
    }

    //—— Modo auto: listener + cola ————————————————————————————————————

    function modoAutoElegible(motivoOut) {
      if (!autoEnabled) {
        if (motivoOut) motivoOut.razon = "toggle apagado";
        return false;
      }
      const seg = segundosHastaMedianocheMadrid();
      if (seg < MARGEN_MEDIANOCHE_HORAS * 3600) {
        if (motivoOut) motivoOut.razon = `quedan ${formatearHorasMinutos(seg)} hasta medianoche Madrid (mínimo ${MARGEN_MEDIANOCHE_HORAS}h)`;
        return false;
      }
      return true;
    }

    function manejarEventoCiudadLimite(ev) {
      const detalle = (ev && ev.detail) || {};
      const codigo = detalle.codigoCiudad;
      const nombre = detalle.nombreCiudad || `ciudad ${codigo}`;
      if (codigo == null) {
        core.logWarn("recoleccionUnidades", "evento JamBot:ciudadLimiteDiario recibido sin codigoCiudad — ignorado");
        return;
      }

      // Log de "evento recibido" siempre — sin esto, los paths que retornan
      // temprano (deduped, sin config, etc.) son invisibles y parece que el
      // evento nunca llegó.
      core.log("recoleccionUnidades", `evento recibido: ${nombre} (cap diario) — evaluando gates`);

      rolloverProcesadasSiCorresponde();
      if (ciudadesProcesadasHoy.has(String(codigo))) {
        core.log("recoleccionUnidades", `evento ${nombre} descartado: ya procesada hoy`);
        return;
      }

      const motivo = {};
      if (!modoAutoElegible(motivo)) {
        // Importante: NO marcamos como procesada — si el usuario prende el
        // toggle más tarde con la ventana abierta, el scan tiene que poder
        // recuperar esta ciudad.
        core.log("recoleccionUnidades", `evento ${nombre} descartado: ${motivo.razon}`);
        return;
      }
      const option = configPorCiudad[codigo];
      if (!Number.isInteger(option) || option <= 0) {
        core.log("recoleccionUnidades", `evento ${nombre} descartado: sin config activa (ciudad en "Apagada")`);
        return;
      }
      const tipoLabel = LABEL_POR_OPTION[option] || `option ${option}`;
      core.log("recoleccionUnidades", `evento ${nombre} aceptado: encolada para reclutar ${tipoLabel}`, "ok");
      colaAuto.add(String(codigo));
      if (!cicloEnCurso) drenarColaAuto();
    }

    // Scan defensivo: si el usuario prende el toggle Auto después de que
    // recolección ya emitió los eventos del día, esos eventos se perdieron.
    // Pedimos a recoleccion el set actual de ciudades saturadas y encolamos
    // las que tengan config activa y no estén ya procesadas.
    function escanearSaturadasYEncolar(origenLog) {
      const api = JamBot.features.recoleccion && JamBot.features.recoleccion.api;
      if (!api || typeof api.ciudadesSaturadasHoy !== "function") return;

      const motivo = {};
      if (!modoAutoElegible(motivo)) {
        core.log("recoleccionUnidades", `auto/${origenLog}: no escaneo saturadas (${motivo.razon})`);
        return;
      }
      rolloverProcesadasSiCorresponde();
      const saturadas = api.ciudadesSaturadasHoy() || [];
      const candidatas = saturadas.filter((c) => {
        if (ciudadesProcesadasHoy.has(String(c.codigoCiudad))) return false;
        const opt = configPorCiudad[c.codigoCiudad];
        return Number.isInteger(opt) && opt > 0;
      });
      if (!candidatas.length) {
        if (saturadas.length) {
          core.log("recoleccionUnidades", `auto/${origenLog}: ${saturadas.length} ciudad(es) saturada(s) pero ninguna pendiente (ya procesadas o sin config)`);
        }
        return;
      }
      const nombres = candidatas.map((c) => c.nombreCiudad).join(", ");
      core.log("recoleccionUnidades", `auto/${origenLog}: recupero ${candidatas.length} ciudad(es) saturada(s): ${nombres}`, "ok");
      for (const c of candidatas) colaAuto.add(String(c.codigoCiudad));
      if (!cicloEnCurso) drenarColaAuto();
    }

    function drenarColaAuto() {
      if (cicloEnCurso || colaAuto.size === 0) return;
      // Re-chequear el horario en el momento de drenar — si la cola entró
      // antes pero ahora ya pasamos la ventana de 3h, descartamos.
      const motivo = {};
      if (!modoAutoElegible(motivo)) {
        if (colaAuto.size > 0) {
          core.log("recoleccionUnidades", `auto: ${colaAuto.size} ciudad(es) en cola descartadas (${motivo.razon})`);
          colaAuto.clear();
        }
        return;
      }
      rolloverProcesadasSiCorresponde();
      // Filtrar las que ya hayan sido procesadas hoy (sucede si la misma
      // ciudad entró por evento + scan, o si el día rolló entre encolar y drenar).
      const ids = Array.from(colaAuto).filter((id) => !ciudadesProcesadasHoy.has(String(id)));
      colaAuto.clear();
      if (!ids.length) return;
      ejecutarCiclo({ ciudadesEspecificas: ids, origen: "auto" });
    }

    window.addEventListener("JamBot:ciudadLimiteDiario", manejarEventoCiudadLimite);

    //—— UI ———————————————————————————————————————————————————————————————
    //
    // El panel re-llama renderTab cada ~1s mientras está abierto. Mantengo
    // refs al montaje inicial para actualizar in-place sin reconstruir el DOM
    // (evita flicker en dropdowns y perder clicks). Re-monto solo si el body
    // fue limpiado por el switch de tab.

    let rootEl = null;
    let btnEl = null;
    let progresoEl = null;
    let erroresEl = null;
    let listaCiudadesEl = null;
    let autoToggleInputEl = null;
    let autoEstadoEl = null;

    function actualizarBoton() {
      if (!btnEl) return;
      const nActivas = ciudadesActivas().length;
      if (cicloEnCurso) {
        btnEl.textContent = "⏹ Cancelar ciclo";
        btnEl.style.background = "#c0392b";
        btnEl.disabled = false;
        btnEl.style.opacity = "1";
      } else if (nActivas === 0) {
        btnEl.textContent = "(sin ciudades activas)";
        btnEl.style.background = "#3498db";
        btnEl.disabled = true;
        btnEl.style.opacity = "0.5";
      } else {
        btnEl.textContent = `▶ Reclutar en ${nActivas} ciudad${nActivas === 1 ? "" : "es"}`;
        btnEl.style.background = "#3498db";
        btnEl.disabled = false;
        btnEl.style.opacity = "1";
      }
    }

    function actualizarEstadoAuto() {
      if (!autoEstadoEl) return;
      const seg = segundosHastaMedianocheMadrid();
      const enVentana = seg >= MARGEN_MEDIANOCHE_HORAS * 3600;
      const colaLen = colaAuto.size;
      let texto;
      let color;
      if (!autoEnabled) {
        texto = `Auto apagado · faltan ${formatearHorasMinutos(seg)} hasta medianoche Madrid`;
        color = "#7a8aa0";
      } else if (enVentana) {
        texto = `Auto activo · ventana abierta (${formatearHorasMinutos(seg)} hasta medianoche Madrid)`;
        color = "#27ae60";
      } else {
        texto = `Auto activo · ventana cerrada (solo ${formatearHorasMinutos(seg)} hasta medianoche, mínimo ${MARGEN_MEDIANOCHE_HORAS}h)`;
        color = "#e67e22";
      }
      if (colaLen > 0) texto += ` · ${colaLen} en cola`;
      autoEstadoEl.textContent = texto;
      autoEstadoEl.style.color = color;
    }

    function actualizarProgreso() {
      if (!progresoEl || !erroresEl) return;
      if (!cicloEnCurso && progreso.totalAldeas === 0) {
        progresoEl.innerHTML = "";
        erroresEl.innerHTML = "";
        return;
      }
      progresoEl.innerHTML =
        `<div>Aldeas: <b>${progreso.aldeasProcesadas}/${progreso.totalAldeas}</b></div>` +
        `<div>OK: <b style="color:#27ae60">${progreso.aldeasOk}</b></div>` +
        `<div>En cooldown: <b style="color:#7a8aa0">${progreso.aldeasEnCooldown}</b></div>` +
        `<div>Sin población (ciudad salteada): <b style="color:#e67e22">${progreso.aldeasSaltadas}</b></div>` +
        `<div>Con error: <b style="color:#e74c3c">${progreso.aldeasConError}</b></div>`;
      erroresEl.innerHTML = progreso.errores.length
        ? `<div style="font-weight:bold;margin-top:8px;color:#cdd5e0">Errores recientes:</div>` +
          progreso.errores.map((e) => `<div>· ${e}</div>`).join("")
        : "";
    }

    function crearFilaCiudad(ciudad) {
      const fila = document.createElement("div");
      fila.className = "pcj-row";
      fila.style.cssText =
        "display:flex;align-items:center;gap:10px;padding:6px 8px;" +
        "border-bottom:1px solid #2c3a4d;";

      const nombre = document.createElement("div");
      nombre.textContent = ciudad.nombreCiudad || `ciudad ${ciudad.codigoCiudad}`;
      nombre.style.cssText = "flex:1;color:#cdd5e0;font-weight:bold;font-size:12px";
      fila.appendChild(nombre);

      const aldeasInfo = document.createElement("div");
      const nAldeas = Array.isArray(ciudad.aldeas) ? ciudad.aldeas.length : 0;
      aldeasInfo.textContent = `${nAldeas} aldea${nAldeas === 1 ? "" : "s"}`;
      aldeasInfo.style.cssText = "color:#7a8aa0;font-size:11px;min-width:70px;text-align:right";
      fila.appendChild(aldeasInfo);

      const select = document.createElement("select");
      select.style.cssText =
        "background:#172029;color:#e6e9ee;border:1px solid #2c3a4d;" +
        "border-radius:3px;padding:4px 6px;font-size:12px;cursor:pointer;min-width:110px";
      for (const t of TIPOS_UNIDAD) {
        const opt = document.createElement("option");
        opt.value = String(t.option);
        opt.textContent = t.label;
        select.appendChild(opt);
      }
      const actual = configPorCiudad[ciudad.codigoCiudad] || 0;
      select.value = String(actual);
      select.addEventListener("change", () => {
        const v = Number(select.value);
        if (v === 0) delete configPorCiudad[ciudad.codigoCiudad];
        else configPorCiudad[ciudad.codigoCiudad] = v;
        persistirConfig();
        actualizarBoton();
      });
      fila.appendChild(select);

      return fila;
    }

    function montarUI(body) {
      body.innerHTML = "";
      rootEl = document.createElement("div");
      rootEl.style.cssText = "display:flex;flex-direction:column;gap:12px";

      const titulo = document.createElement("div");
      titulo.textContent = "Reclutamiento de unidades en aldeas";
      titulo.style.cssText = "font-size:13px;font-weight:bold;color:#cdd5e0";
      rootEl.appendChild(titulo);

      const descripcion = document.createElement("div");
      descripcion.innerHTML =
        "Elegí un tipo de unidad <b>por ciudad</b> — aplica a las 6 aldeas. " +
        "Por aldea solo se puede reclutar un tipo cada 3 h. " +
        "La configuración se guarda automáticamente.";
      descripcion.style.cssText = "font-size:11px;color:#7a8aa0;line-height:1.5";
      rootEl.appendChild(descripcion);

      // Toggle del modo automático.
      const autoBox = document.createElement("div");
      autoBox.style.cssText =
        "background:#172029;border:1px solid #2c3a4d;border-radius:4px;" +
        "padding:8px 10px;display:flex;flex-direction:column;gap:6px";

      const autoLabel = document.createElement("label");
      autoLabel.style.cssText =
        "display:flex;align-items:center;gap:8px;cursor:pointer;font-size:12px;color:#cdd5e0";
      autoToggleInputEl = document.createElement("input");
      autoToggleInputEl.type = "checkbox";
      autoToggleInputEl.checked = autoEnabled;
      autoToggleInputEl.style.cssText = "cursor:pointer;accent-color:#3498db";
      autoToggleInputEl.addEventListener("change", () => {
        autoEnabled = autoToggleInputEl.checked;
        persistirAuto();
        actualizarEstadoAuto();
        if (autoEnabled) {
          core.log("recoleccionUnidades", "modo auto activado — escucho eventos de recolección", "ok");
          if (!cicloEnCurso && colaAuto.size > 0) drenarColaAuto();
          // Recuperar ciudades que se saturaron antes de que el toggle
          // estuviera prendido — sin esto, los eventos perdidos quedaban
          // perdidos hasta mañana.
          escanearSaturadasYEncolar("toggle-on");
        } else {
          core.log("recoleccionUnidades", "modo auto desactivado");
        }
      });
      autoLabel.appendChild(autoToggleInputEl);
      const autoLabelTxt = document.createElement("span");
      autoLabelTxt.innerHTML =
        `<b>Modo automático</b> — disparar reclutamiento cuando una ciudad pega el ` +
        `cap diario de recursos (solo si quedan ≥${MARGEN_MEDIANOCHE_HORAS}h hasta medianoche Madrid)`;
      autoLabel.appendChild(autoLabelTxt);
      autoBox.appendChild(autoLabel);

      autoEstadoEl = document.createElement("div");
      autoEstadoEl.style.cssText = "font-size:11px;line-height:1.5;padding-left:22px";
      autoBox.appendChild(autoEstadoEl);

      rootEl.appendChild(autoBox);

      // Lista de ciudades con dropdown por ciudad.
      listaCiudadesEl = document.createElement("div");
      listaCiudadesEl.style.cssText =
        "background:#172029;border-radius:4px;border:1px solid #2c3a4d;" +
        "max-height:50vh;overflow-y:auto";
      rootEl.appendChild(listaCiudadesEl);

      // Botón disparador.
      btnEl = document.createElement("button");
      btnEl.style.cssText =
        "padding:10px 16px;color:#fff;border:none;border-radius:4px;" +
        "font-weight:bold;font-size:13px;cursor:pointer;align-self:flex-start;" +
        "transition:background 0.15s";
      btnEl.addEventListener("click", () => {
        if (cicloEnCurso) {
          cancelar = true;
          actualizarBoton();
        } else {
          ejecutarCiclo();
          actualizarBoton();
          actualizarProgreso();
        }
      });
      rootEl.appendChild(btnEl);

      progresoEl = document.createElement("div");
      progresoEl.style.cssText = "font-size:12px;color:#cdd5e0;line-height:1.6";
      rootEl.appendChild(progresoEl);

      erroresEl = document.createElement("div");
      erroresEl.style.cssText =
        "font-size:11px;color:#e74c3c;max-height:200px;overflow-y:auto;line-height:1.5";
      rootEl.appendChild(erroresEl);

      body.appendChild(rootEl);
    }

    function actualizarListaCiudades() {
      if (!listaCiudadesEl) return;
      const ciudades = ciudadesOrdenadas();

      // Si hay un <select> con foco (el usuario está eligiendo), NO re-render.
      // Eso preservaría el dropdown abierto. Reincorporamos en el siguiente tick.
      const ae = document.activeElement;
      if (ae && ae.tagName === "SELECT" && listaCiudadesEl.contains(ae)) return;

      if (!ciudades.length) {
        listaCiudadesEl.innerHTML =
          `<div style="padding:14px;color:#7a8aa0;font-size:11px;text-align:center">` +
          `Aún no se cargaron las ciudades — esperá a que recolección termine el bootstrap.` +
          `</div>`;
        return;
      }

      // Render incremental: solo reconstruye si la cantidad cambió o si una
      // fila desincronizó su <select> con configPorCiudad (ej. config cargada
      // del storage después de la primera render).
      const filasExistentes = listaCiudadesEl.children.length;
      const necesitaRebuild = filasExistentes !== ciudades.length;
      if (necesitaRebuild) {
        listaCiudadesEl.innerHTML = "";
        for (const ciudad of ciudades) {
          listaCiudadesEl.appendChild(crearFilaCiudad(ciudad));
        }
      } else {
        // Sincronizar el value de cada select con configPorCiudad — útil
        // cuando la config se carga del storage o se cambia desde DevTools.
        const filas = listaCiudadesEl.children;
        for (let i = 0; i < ciudades.length; i++) {
          const select = filas[i] && filas[i].querySelector("select");
          if (!select) continue;
          const esperado = String(configPorCiudad[ciudades[i].codigoCiudad] || 0);
          if (select.value !== esperado) select.value = esperado;
        }
      }
    }

    function renderTab(body) {
      if (!rootEl || !body.contains(rootEl)) {
        montarUI(body);
      }
      // Sincronizar el checkbox con el estado actual (puede haber cambiado
      // desde DevTools o desde otro tick — el panel monta una vez y queda
      // vivo, no querés que se desincronice).
      if (autoToggleInputEl && autoToggleInputEl.checked !== autoEnabled) {
        autoToggleInputEl.checked = autoEnabled;
      }
      actualizarListaCiudades();
      actualizarBoton();
      actualizarProgreso();
      actualizarEstadoAuto();
    }

    //—— Bootstrap del módulo ————————————————————————————————————————————
    await cargarConfig();
    await cargarAuto();
    await cargarProcesadasHoy();

    JamBot.features.recoleccionUnidades = JamBot.features.recoleccionUnidades || {};
    JamBot.features.recoleccionUnidades.api = { renderTab };

    const nConfig = Object.keys(configPorCiudad).length;
    core.log(
      "recoleccionUnidades",
      `iniciado · ${nConfig} ciudad(es) activa(s) · modo auto: ${autoEnabled ? "ON" : "OFF"} · procesadas hoy: ${ciudadesProcesadasHoy.size}`,
      "ok"
    );

    // Si el toggle está prendido al bootear, hacer un scan inicial — caso
    // típico: usuario refresca la página cuando ya hay ciudades saturadas.
    // El recoleccion.api recién va a tener datos después de que recoleccion
    // corra su primer ciclo, así que demoramos un poco y dejamos que el
    // scan se dispare desde el primer evento de cap también.
    if (autoEnabled) {
      setTimeout(() => escanearSaturadasYEncolar("bootstrap"), 30 * 1000);
    }
  }

  JamBot.features.recoleccionUnidades = { init };
})();
