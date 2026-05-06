/* features/ataques.js — envía ataques periódicos desde cada ciudad propia
 * a una ciudad objetivo, esperando que las tropas vuelvan antes del
 * siguiente disparo.
 *
 * Cada ciudad tiene config independiente (target, tipo de unidad, on/off).
 * Por ciclo:
 *   1. Lee unidades en la ciudad (modelo Units con home==current==town)
 *      via JamBot:queryUnits del gameBridge.
 *   2. Manda TODO lo disponible del tipo elegido al target.
 *   3. Lee `started_at` y `arrival_at` de la notification MovementsUnits.
 *   4. Agenda el siguiente ataque a `2*(arrival_at - started_at) + 20s`
 *      desde started_at (ida + vuelta + margen para que las tropas
 *      vuelvan, dado que algunas mueren y el conteo cambia).
 *
 * Endpoint capturado del cliente:
 *   POST .../town_info?town_id=<ATTACKER>&action=send_units&h=<csrf>
 *   body: json={"<unitType>":<count>,"id":<TARGET>,"type":"attack",
 *               "town_id":<ATTACKER>,"nl_init":true}
 *
 * Botón Iniciar/Detener PROPIO en el tab Ataques (separado del play/pause
 * global). Cuando el global pausa o hay CAPTCHA, los timers se cancelan
 * igual — el usuario no quiere que el bot dispare ataques durante un
 * challenge.
 */
(function () {
  const JamBot = (window.JamBot = window.JamBot || {});
  JamBot.features = JamBot.features || {};

  //Lista cerrada de unidades enviables. Se agrupan en categorías para que
  //el panel pueda separarlas visualmente. Las claves coinciden 1:1 con los
  //atributos del modelo Units del juego (slinger, sword, big_transporter, …).
  const TIPOS_UNIDAD = [
    //—— Terrestres ——
    { key: "slinger",         label: "Honderos",     cat: "tierra" },
    { key: "sword",           label: "Espadachines", cat: "tierra" },
    { key: "archer",          label: "Arqueros",     cat: "tierra" },
    { key: "hoplite",         label: "Hoplitas",     cat: "tierra" },
    { key: "rider",           label: "Jinetes",      cat: "tierra" },
    { key: "chariot",         label: "Carros",       cat: "tierra" },
    { key: "catapult",        label: "Catapultas",   cat: "tierra" },
    //—— Míticas (terrestres) ——
    { key: "minotaur",        label: "Minotauros",   cat: "mitica" },
    { key: "manticore",       label: "Mantícoras",   cat: "mitica" },
    { key: "zyklop",          label: "Cíclopes",     cat: "mitica" },
    { key: "harpy",           label: "Harpías",      cat: "mitica" },
    { key: "medusa",          label: "Medusas",      cat: "mitica" },
    { key: "centaur",         label: "Centauros",    cat: "mitica" },
    { key: "pegasus",         label: "Pegasos",      cat: "mitica" },
    { key: "cerberus",        label: "Cerberos",     cat: "mitica" },
    { key: "fury",            label: "Furias",       cat: "mitica" },
    { key: "griffin",         label: "Grifos",       cat: "mitica" },
    { key: "calydonian_boar", label: "Jabalíes",     cat: "mitica" },
    { key: "satyr",           label: "Sátiros",      cat: "mitica" },
    { key: "spartoi",         label: "Spartoi",      cat: "mitica" },
    { key: "ladon",           label: "Ladón",        cat: "mitica" },
    //—— Navales — transportes ——
    { key: "small_transporter", label: "Transp. rápido", cat: "naval" },
    { key: "big_transporter",   label: "Transp. grande", cat: "naval" },
    //—— Navales — guerra ——
    { key: "bireme",          label: "Birreme",       cat: "naval" },
    { key: "attack_ship",     label: "Barco de luz",  cat: "naval" },
    { key: "demolition_ship", label: "Brulote",       cat: "naval" },
    { key: "trireme",         label: "Trirreme",      cat: "naval" },
    { key: "colonize_ship",   label: "Colono",        cat: "naval" },
    //—— Navales — míticas ——
    { key: "sea_monster",     label: "Monstr. mar.",  cat: "naval" },
    { key: "siren",           label: "Sirena",        cat: "naval" },
  ];

  function labelUnidad(key) {
    const t = TIPOS_UNIDAD.find((u) => u.key === key);
    return t ? t.label : key;
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function jitter(minMs, maxMs) {
    return minMs + Math.random() * (maxMs - minMs);
  }

  async function init(ctx) {
    const { data, game, core } = ctx;
    const { csrfToken, world_id } = game;

    const STORAGE_KEY = `jambotAtaques_${world_id}`;
    //Margen post-arrival_at*2 para asegurar que las tropas hayan vuelto
    //(algunas mueren en el ataque, así que el conteo del próximo ciclo es
    //variable; +20s da aire para que MM se sincronice antes de leer Units).
    const MARGEN_SEGUNDOS = 20;
    const HISTORIAL_MAX = 50;

    //—— Estado expuesto al panel ———————————————————————————————————————
    //
    //  habilitada:        master switch (botón Iniciar/Detener)
    //  configPorCiudad:   { [townId]: { enabled, targetTownId, unitType } }
    //  ultimoPorCiudad:   { [townId]: { ts, enviadas, oneWaySeg,
    //                                   unitType, targetTownId, error? } }
    //  proximoPorCiudad:  { [townId]: timestamp ms } (no persiste)
    //  historial:         lista FIFO de últimos ataques OK
    //  unitsCache:        { [townId]: Units atributos } (no persiste, lo
    //                     llena renderTab cada segundo via queryUnits)
    data.ataques = data.ataques || {
      habilitada: false,
      configPorCiudad: {},
      ultimoPorCiudad: {},
      proximoPorCiudad: {},
      historial: [],
      unitsCache: {},
    };

    //—— Persistencia ————————————————————————————————————————————————————

    await new Promise((resolve) => {
      try {
        chrome.storage.local.get(STORAGE_KEY, (obj) => {
          const blob = (obj && obj[STORAGE_KEY]) || {};
          if (typeof blob.habilitada === "boolean") data.ataques.habilitada = blob.habilitada;
          if (blob.configPorCiudad && typeof blob.configPorCiudad === "object") {
            data.ataques.configPorCiudad = blob.configPorCiudad;
          }
          if (blob.ultimoPorCiudad && typeof blob.ultimoPorCiudad === "object") {
            data.ataques.ultimoPorCiudad = blob.ultimoPorCiudad;
          }
          if (Array.isArray(blob.historial)) data.ataques.historial = blob.historial;
          //Migración: versiones viejas guardaban `unitType` (string único).
          //Nuevo formato es `unitTypes` (array) — multi-unidad por ataque.
          //Si encontramos el campo viejo, lo convertimos in-place.
          for (const tid of Object.keys(data.ataques.configPorCiudad)) {
            const cfg = data.ataques.configPorCiudad[tid];
            if (!cfg) continue;
            if (cfg.unitType && !Array.isArray(cfg.unitTypes)) {
              cfg.unitTypes = [cfg.unitType];
              delete cfg.unitType;
            }
            if (!Array.isArray(cfg.unitTypes)) cfg.unitTypes = [];
          }
          //Los timers en proximoPorCiudad NO sobreviven a reload — al
          //reanudar el feature programa todo desde cero respetando si las
          //tropas todavía están viajando (el server simplemente rechaza el
          //attack si no hay unidades en casa).
          resolve();
        });
      } catch (_) { resolve(); }
    });

    //Throttle de la escritura — varios cambios de config seguidos se
    //colapsan en 1 sola escritura (mismo patrón que core.persistirErroresBuffer).
    let saveTimer = null;
    function persistir() {
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        saveTimer = null;
        try {
          chrome.storage.local.set({
            [STORAGE_KEY]: {
              habilitada: data.ataques.habilitada,
              configPorCiudad: data.ataques.configPorCiudad,
              ultimoPorCiudad: data.ataques.ultimoPorCiudad,
              historial: data.ataques.historial,
            },
          });
        } catch (e) {
          core.logWarn("ataques", "no pude persistir estado", e);
        }
      }, 300);
    }

    //—— Bridge: lectura de tropas ——————————————————————————————————————
    //
    //postMessage round-trip: dispatchEvent (sincrónico) → bridge handler
    //responde con window.postMessage (async) → handler local resuelve la
    //promesa. Timeout 2s defensivo.

    function queryUnits(townId) {
      return new Promise((resolve) => {
        const handler = (e) => {
          if (e.source !== window) return;
          const m = e.data;
          if (!m || m.type !== "JamBot:unitsResult") return;
          if (m.townId != townId) return;
          window.removeEventListener("message", handler);
          clearTimeout(toid);
          resolve(m.units || null);
        };
        window.addEventListener("message", handler);
        const toid = setTimeout(() => {
          window.removeEventListener("message", handler);
          resolve(null);
        }, 2000);
        window.dispatchEvent(new CustomEvent("JamBot:queryUnits", {
          detail: { townId },
        }));
      });
    }

    //—— Scheduler por ciudad ——————————————————————————————————————————
    //
    //Cada ciudad tiene su propio setTimeout independiente. Iniciar arranca
    //todas (con stagger para no disparar simultáneo); Detener cancela todas.
    //Cambios per-city (target/unitType/enable) cancelan SOLO esa ciudad y
    //la reagendan rápido si corresponde.

    const timers = new Map(); //townId → setTimeout id

    function cancelarTimer(townId) {
      const t = timers.get(townId);
      if (t) {
        clearTimeout(t);
        timers.delete(townId);
      }
      delete data.ataques.proximoPorCiudad[townId];
    }

    function cancelarTodos() {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
      data.ataques.proximoPorCiudad = {};
    }

    function programarCiudad(townId, ms) {
      cancelarTimer(townId);
      data.ataques.proximoPorCiudad[townId] = Date.now() + ms;
      const tid = setTimeout(() => {
        timers.delete(townId);
        delete data.ataques.proximoPorCiudad[townId];
        ejecutarCiudad(townId).catch((e) => {
          core.logError("ataques", `ciudad ${townId} falló`, e);
          if (debeCorrer(townId)) programarCiudad(townId, 60_000);
        });
      }, ms);
      timers.set(townId, tid);
    }

    function debeCorrer(townId) {
      if (!data.ataques.habilitada) return false;
      //Ataques tiene su propio botón Iniciar/Detener — NO se acopla al
      //play/pause global del bot. Solo CAPTCHA detiene los timers (porque
      //ahí es la integridad del flujo lo que está en juego, no preferencia).
      if (core.isCaptchaActive()) return false;
      const cfg = data.ataques.configPorCiudad[townId];
      if (!cfg || !cfg.enabled) return false;
      if (!cfg.targetTownId) return false;
      if (Number(cfg.targetTownId) === Number(townId)) return false; //auto-ataque sin sentido
      if (!Array.isArray(cfg.unitTypes) || cfg.unitTypes.length === 0) return false;
      return true;
    }

    function arrancarTodas() {
      const ciudades = obtenerListaCiudadesPropias();
      let i = 0;
      const programadas = [];
      const omitidas = [];
      for (const townId of ciudades) {
        if (!debeCorrer(townId)) {
          //Diagnóstico: por qué se omite. Útil cuando el usuario apreta
          //Iniciar y no ve nada — explica si fue por toggle, target, units
          //o (raro) captcha.
          const cfg = data.ataques.configPorCiudad[townId];
          let razon;
          if (!cfg || !cfg.enabled) razon = "ATACAR off";
          else if (!cfg.targetTownId) razon = "sin target";
          else if (Number(cfg.targetTownId) === Number(townId)) razon = "target = ciudad propia";
          else if (!Array.isArray(cfg.unitTypes) || cfg.unitTypes.length === 0) razon = "sin unidades elegidas";
          else if (core.isCaptchaActive()) razon = "captcha activo";
          else razon = "?";
          omitidas.push(`${nombreCiudad(townId)} (${razon})`);
          continue;
        }
        //Stagger 1.5-3s + i*1.5s entre ciudades para no disparar todos los
        //ataques al mismo segundo. Mismo principio que el jitter de
        //recolección.
        const ms = jitter(1500, 3000) + i * 1500;
        programarCiudad(townId, ms);
        programadas.push(`${nombreCiudad(townId)} en ${Math.round(ms/1000)}s`);
        i += 1;
      }
      if (programadas.length) {
        core.log("ataques", `arrancarTodas: ${programadas.length} programada(s) → ${programadas.join(", ")}`, "ok");
      } else {
        core.logWarn(
          "ataques",
          `arrancarTodas: NINGUNA ciudad programada. Omitidas: ${omitidas.length ? omitidas.join("; ") : "(0)"}. Verificá ATACAR/target/unidades.`
        );
      }
    }

    function obtenerListaCiudadesPropias() {
      if (Array.isArray(data.ciudadesConAldeas) && data.ciudadesConAldeas.length) {
        return data.ciudadesConAldeas.map((c) => c.codigoCiudad);
      }
      return [];
    }

    function nombreCiudad(townId) {
      const c = (data.ciudadesConAldeas || []).find((x) => x.codigoCiudad == townId);
      return c ? (c.nombreCiudad || String(townId)) : String(townId);
    }

    //—— Ciclo: una ciudad envía un ataque ————————————————————————————

    async function ejecutarCiudad(townId, opts) {
      const forzar = !!(opts && opts.forzar);
      if (!forzar && !debeCorrer(townId)) {
        core.log("ataques", `tick town=${townId} ignorado (debeCorrer=false)`, "info");
        return;
      }
      const cfg = data.ataques.configPorCiudad[townId];
      core.log(
        "ataques",
        `→ disparando town=${nombreCiudad(townId)} target=${cfg.targetTownId} tipos=[${(cfg.unitTypes || []).join(",")}]${forzar ? " [MANUAL]" : ""}`,
        "info"
      );

      const units = await queryUnits(townId);
      if (units) data.ataques.unitsCache[townId] = units;
      if (!units) {
        core.logWarn("ataques", `town=${nombreCiudad(townId)} sin modelo Units en MM — abrí la ciudad en el juego al menos una vez`);
        registrarUltimo(townId, { error: "Units no cargado" });
        if (!forzar && debeCorrer(townId)) programarCiudad(townId, 60_000);
        return;
      }
      core.log("ataques", `town=${nombreCiudad(townId)} Units leído OK · slinger=${units.slinger||0} sword=${units.sword||0} archer=${units.archer||0} hoplite=${units.hoplite||0}`, "info");

      //Construir el counts a enviar: para cada unitType seleccionado en la
      //config, leer el conteo disponible en Units. Solo se incluyen tipos
      //con count > 0 — los que están a 0 se omiten silenciosamente del
      //payload (mandar `slinger:0` no tiene sentido).
      const counts = {};
      let total = 0;
      for (const ut of cfg.unitTypes) {
        const n = Number(units[ut] || 0);
        if (n > 0) {
          counts[ut] = n;
          total += n;
        }
      }
      if (total <= 0) {
        const lbls = cfg.unitTypes.map(labelUnidad).join("/");
        core.logWarn("ataques", `town=${nombreCiudad(townId)} sin tropas (${lbls}) — reintento en 5min`);
        registrarUltimo(townId, { error: `sin tropas (${lbls})` });
        //Sin tropas → reintento cada 5min por si algún cíclo de producción
        //o de retorno deja unidades nuevas.
        if (!forzar && debeCorrer(townId)) programarCiudad(townId, 5 * 60_000);
        return;
      }

      const r = await enviarAtaque(townId, Number(cfg.targetTownId), counts);
      if (!r.ok) {
        registrarUltimo(townId, { error: r.error || "fallo desconocido" });
        if (!forzar && debeCorrer(townId)) programarCiudad(townId, 60_000);
        return;
      }

      const oneWaySeg = r.arrivalAt - r.startedAt;
      //Round trip = 2*one_way (vuelta = ida tras combate instantáneo) +
      //margen 20s. Calculamos desde started_at del server, no Date.now(),
      //para no acumular drift de reloj cliente a lo largo de muchos
      //ciclos.
      const proximoServerTs = r.startedAt + 2 * oneWaySeg + MARGEN_SEGUNDOS;
      const ahoraSeg = Math.floor(Date.now() / 1000);
      const proximoSeg = Math.max(MARGEN_SEGUNDOS, proximoServerTs - ahoraSeg);

      registrarUltimo(townId, {
        counts,
        total,
        oneWaySeg,
        targetTownId: cfg.targetTownId,
      });
      registrarHistorial({
        ts: Date.now(),
        town_id: townId,
        target_town_id: cfg.targetTownId,
        counts,
        total,
        oneWaySeg,
      });

      const enviadoTxt = formatCountsCorto(counts);
      core.log(
        "ataques",
        `✓ ${nombreCiudad(townId)} → ${cfg.targetTownId} · ${enviadoTxt} · viaje ${core.formatDuracion(oneWaySeg)} · siguiente en ${core.formatDuracion(proximoSeg)}`,
        "ok"
      );

      if (!forzar && debeCorrer(townId)) programarCiudad(townId, proximoSeg * 1000);
    }

    //Formatea un counts {slinger:192, sword:50} como "192 Honderos + 50 Espadachines".
    //Usado tanto en logs como en el panel.
    function formatCountsCorto(counts) {
      const partes = Object.entries(counts || {})
        .filter(([, n]) => Number(n) > 0)
        .map(([ut, n]) => `${n} ${labelUnidad(ut)}`);
      return partes.length ? partes.join(" + ") : "—";
    }

    function registrarUltimo(townId, info) {
      data.ataques.ultimoPorCiudad[townId] = { ts: Date.now(), ...info };
      persistir();
    }

    function registrarHistorial(entry) {
      data.ataques.historial.push(entry);
      while (data.ataques.historial.length > HISTORIAL_MAX) data.ataques.historial.shift();
      persistir();
    }

    //—— Request HTTP ————————————————————————————————————————————————————
    //
    //Replica el click en "Atacar" del cliente. Body capturado de DevTools:
    //   {"slinger":192,"id":95,"type":"attack","town_id":91,"nl_init":true}
    //La clave del unitType es dinámica — coincide con el atributo del modelo
    //Units (slinger, sword, archer, …).

    async function enviarAtaque(attackerTownId, targetTownId, counts) {
      //Jitter pre-fetch — evita patrón de "exactamente N ms tras el tick".
      await new Promise((r) => setTimeout(r, jitter(800, 1400)));

      //Multi-unidad: cada unitType con su cantidad va como key del JSON.
      //Body capturado del cliente para `send_units` acepta varias claves
      //a la vez, ej: {"slinger":192,"sword":50,"id":95,"type":"attack",...}.
      const json = {
        ...counts,
        id: targetTownId,
        type: "attack",
        town_id: attackerTownId,
        nl_init: true,
      };
      const datos = new URLSearchParams();
      datos.append("json", JSON.stringify(json));

      let response;
      try {
        const res = await fetch(
          `https://${world_id}.grepolis.com/game/town_info?town_id=${attackerTownId}&action=send_units&h=${csrfToken}`,
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
        core.logError("ataques", `fetch falló (town=${attackerTownId} → ${targetTownId})`, e);
        return { ok: false, error: "fetch falló" };
      }

      const j = response && response.json;
      if (!j || !j.success) {
        core.logWarn("ataques", `respuesta sin success (town=${attackerTownId} → ${targetTownId})`, response);
        //Heurística captcha: si el response no trae notification "Units"
        //(que indica que el modelo se movió), lo más probable es que el
        //server haya pedido un challenge. Avisamos para que el cartel del
        //panel se prenda; mismo patrón que recolección.
        const tieneUnits = j && Array.isArray(j.notifications) &&
          j.notifications.some((n) => n.subject === "Units");
        if (!tieneUnits && core.onCaptchaDetectado) {
          core.onCaptchaDetectado({
            feature: "ataques",
            ciudad: { id: attackerTownId, nombre: nombreCiudad(attackerTownId) },
          });
        }
        return { ok: false, error: j && j.error ? String(j.error) : "sin success" };
      }

      //Refrescar Backbone con las notifications — Units (home count -=
      //cantidad), MovementsUnits (nuevo movimiento), Attack (incoming en
      //target). La UI del juego se sincroniza sola.
      if (Array.isArray(j.notifications)) {
        window.dispatchEvent(new CustomEvent("JamBot:dispatchNotifications", {
          detail: { notifications: j.notifications },
        }));
      }

      //Extraer started_at + arrival_at del MovementsUnits para calcular el
      //tiempo de ida. Si no aparece, fallback conservador 5min — evita que
      //la ciudad quede frita reagendando inmediato.
      let startedAt = null, arrivalAt = null;
      for (const n of j.notifications || []) {
        if (n.subject !== "MovementsUnits") continue;
        try {
          const p = JSON.parse(n.param_str);
          const m = p && p.MovementsUnits;
          if (!m) continue;
          startedAt = Number(m.started_at);
          arrivalAt = Number(m.arrival_at);
          break;
        } catch (_) { /* sigue */ }
      }
      if (!startedAt || !arrivalAt) {
        core.logWarn("ataques", "respuesta OK pero sin MovementsUnits — fallback 5min", response);
        startedAt = Math.floor(Date.now() / 1000);
        arrivalAt = startedAt + 5 * 60;
      }

      return { ok: true, startedAt, arrivalAt };
    }

    //—— API expuesta al panel ———————————————————————————————————————————

    function setHabilitada(b) {
      if (data.ataques.habilitada === !!b) return;
      data.ataques.habilitada = !!b;
      persistir();
      if (b) {
        core.log("ataques", "INICIADO desde el panel", "ok");
        if (!core.isCaptchaActive()) arrancarTodas();
      } else {
        core.log("ataques", "DETENIDO desde el panel", "warn");
        cancelarTodos();
      }
    }

    function setConfigCiudad(townId, cfg) {
      const prev = data.ataques.configPorCiudad[townId] || {};
      data.ataques.configPorCiudad[townId] = { ...prev, ...cfg };
      persistir();
      //Si está corriendo el master, reagendar esta ciudad inmediato (con
      //jitter chico) para que el cambio se note enseguida. Si la nueva
      //config no debe correr (e.g. enabled:false o sin target), simplemente
      //cancelamos.
      cancelarTimer(townId);
      if (debeCorrer(townId)) programarCiudad(townId, jitter(800, 2000));
    }

    //—— Reaccionar a captcha global ——————————————————————————————————
    //
    //Ataques NO escucha onPlayPauseChange — es feature independiente del
    //play/pause global. Solo CAPTCHA detiene/reanuda los timers.

    core.onCaptcha((active) => {
      if (!data.ataques.habilitada) return;
      if (active) {
        cancelarTodos();
      } else {
        arrancarTodas();
      }
    });

    //Si arrancamos con habilitada=true (persistido), esperar a que
    //recoleccion termine de poblar data.ciudadesConAldeas. Esa carga es
    //async (depende de modelos del juego) y puede tardar más que el await
    //de feature.init. Hacemos hasta 6 intentos cada 5s; si en 30s no hay
    //ciudades (mundo recién creado, problema con MM, etc), abortamos y
    //dejamos que el usuario arranque manualmente.
    function bootArrancar(intentos) {
      if (!data.ataques.habilitada) return;
      if (core.isCaptchaActive()) return;
      if (obtenerListaCiudadesPropias().length) {
        arrancarTodas();
        return;
      }
      if (intentos <= 0) {
        core.logWarn("ataques", "no hay ciudades cargadas tras 30s — apretá Iniciar manualmente cuando estén listas");
        return;
      }
      setTimeout(() => bootArrancar(intentos - 1), 5000);
    }
    if (data.ataques.habilitada && !core.isCaptchaActive()) {
      setTimeout(() => bootArrancar(6), 4000);
    }

    //—— Render del tab Ataques ——————————————————————————————————————————
    //
    //Self-contained: usa solo DOM + estilos inline, no depende de helpers
    //internos de recoleccion.js. El panel de recoleccion delega acá via
    //JamBot.features.ataques.api.renderTab(body).

    function renderTab(body) {
      //Si el usuario está tipiando el ID objetivo o seleccionando unidad,
      //un re-render full destruye el input y le borra el foco/cursor. Saltar
      //el refresh mientras hay foco dentro del tab. Los countdowns quedan
      //congelados unos segundos hasta que el usuario hace blur — aceptable.
      const ae = document.activeElement;
      if (ae && body.contains(ae) && (ae.tagName === "INPUT" || ae.tagName === "SELECT")) {
        return;
      }
      body.innerHTML = "";
      const dsa = data.ataques;

      body.appendChild(renderHeaderMaster(dsa));

      //Lista de ciudades propias — si recoleccion todavía no las cargó,
      //mostrar placeholder.
      const ciudades = (data.ciudadesConAldeas || []).slice().sort((a, b) =>
        (a.nombreCiudad || "").localeCompare(b.nombreCiudad || "", undefined, { numeric: true })
      );
      if (!ciudades.length) {
        const v = document.createElement("div");
        v.textContent = "Cargando ciudades…";
        v.style.cssText = "opacity:0.7;font-style:italic;padding:10px 0;font-size:11.5px";
        body.appendChild(v);
        return;
      }

      //Subtítulo
      const subt = document.createElement("div");
      subt.textContent = "CONFIGURACIÓN POR CIUDAD";
      subt.style.cssText =
        "font-size:10.5px;font-weight:bold;margin:14px 0 8px;color:#7a8aa0;" +
        "text-transform:uppercase;letter-spacing:1.2px;" +
        "border-bottom:1px solid #2c3a4d;padding-bottom:5px";
      body.appendChild(subt);

      const lista = document.createElement("div");
      lista.style.cssText = "display:flex;flex-direction:column;gap:8px";
      ciudades.forEach((c) => lista.appendChild(renderCardCiudad(c)));
      body.appendChild(lista);

      //Asincrónicamente refrescar el cache de tropas. Cada respuesta
      //actualiza el span de tropas de su tarjeta sin re-renderear todo.
      ciudades.forEach((c) => {
        queryUnits(c.codigoCiudad).then((units) => {
          if (units) data.ataques.unitsCache[c.codigoCiudad] = units;
          const span = document.querySelector(`[data-jb-tropas="${c.codigoCiudad}"]`);
          if (span) span.innerHTML = renderTropasInline(c.codigoCiudad);
        });
      });

      //Sección historial reciente (colapsada por default)
      body.appendChild(renderHistorial(dsa));
    }

    function renderHeaderMaster(dsa) {
      const wrap = document.createElement("div");
      wrap.style.cssText =
        "display:flex;align-items:center;gap:12px;padding:10px 12px;" +
        "background:#172029;border:1px solid #2c3a4d;border-radius:4px;" +
        `border-left:3px solid ${dsa.habilitada ? "#27ae60" : "#7a8aa0"}`;

      const left = document.createElement("div");
      left.style.cssText = "flex:1;min-width:0";
      const titulo = document.createElement("div");
      titulo.textContent = "Loop de ataques";
      titulo.style.cssText = "font-weight:bold;color:#e6e9ee;font-size:12.5px";
      const sub = document.createElement("div");
      const ciudadesActivas = Object.values(dsa.configPorCiudad)
        .filter((c) => c.enabled && c.targetTownId &&
          Array.isArray(c.unitTypes) && c.unitTypes.length > 0).length;
      //Ataques es independiente del play/pause global — solo CAPTCHA lo
      //pausa. Por eso el sub-text NO menciona el bot global.
      const corriendo = dsa.habilitada && !core.isCaptchaActive();
      sub.textContent = corriendo
        ? `Activo · ${ciudadesActivas} ciudad(es) configurada(s)`
        : !dsa.habilitada
          ? "Detenido — apretá Iniciar para arrancar"
          : "En espera — CAPTCHA activo";
      sub.style.cssText = "color:#7a8aa0;font-size:10.5px;margin-top:1px";
      left.appendChild(titulo);
      left.appendChild(sub);
      wrap.appendChild(left);

      const btn = document.createElement("button");
      const accion = dsa.habilitada ? "Detener" : "Iniciar";
      btn.textContent = (dsa.habilitada ? "⏸  " : "▶  ") + accion;
      const colorBtn = dsa.habilitada ? "#e74c3c" : "#27ae60";
      btn.style.cssText =
        `padding:7px 16px;background:${colorBtn};color:#fff;border:none;` +
        "border-radius:4px;cursor:pointer;font-weight:bold;font-size:12px;" +
        "letter-spacing:0.3px;flex-shrink:0";
      btn.addEventListener("click", () => {
        setHabilitada(!dsa.habilitada);
        renderTab(document.querySelector("#panelConfigJam .pcj-body"));
      });
      wrap.appendChild(btn);
      return wrap;
    }

    function renderCardCiudad(ciudad) {
      const tid = ciudad.codigoCiudad;
      const cfg = data.ataques.configPorCiudad[tid] || { enabled: false, targetTownId: "", unitTypes: [] };
      if (!Array.isArray(cfg.unitTypes)) cfg.unitTypes = [];
      const ult = data.ataques.ultimoPorCiudad[tid];
      const proximoAt = data.ataques.proximoPorCiudad[tid];

      const colorAcento = !cfg.enabled
        ? "#5a6776"
        : (proximoAt ? "#3498db" : (ult && !ult.error ? "#27ae60" : (ult && ult.error ? "#e74c3c" : "#3498db")));

      const card = document.createElement("div");
      card.style.cssText =
        "padding:10px 12px;background:#172029;border:1px solid #2c3a4d;" +
        `border-left:3px solid ${colorAcento};border-radius:4px`;

      //Fila 1: nombre + toggle "Atacar" más visible (label + switch)
      const row1 = document.createElement("div");
      row1.style.cssText = "display:flex;align-items:center;gap:10px;margin-bottom:8px";
      const nombre = document.createElement("div");
      nombre.style.cssText = "flex:1;min-width:0";
      nombre.innerHTML =
        `<div style="font-weight:bold;color:#e6e9ee;font-size:13px">${escapeHtml(ciudad.nombreCiudad || "")}</div>` +
        `<div style="color:#7a8aa0;font-size:10px;font-family:monospace">id ${tid}</div>`;
      row1.appendChild(nombre);

      //Toggle "Atacar" — label explícito a la izquierda del switch para que
      //quede claro qué hace (antes solo era un switch sin texto).
      const togWrap = document.createElement("div");
      togWrap.style.cssText = "display:flex;align-items:center;gap:8px;flex-shrink:0";
      const togLbl = document.createElement("span");
      togLbl.textContent = "Atacar";
      togLbl.style.cssText =
        `color:${cfg.enabled ? "#27ae60" : "#7a8aa0"};font-size:11.5px;font-weight:bold;` +
        "text-transform:uppercase;letter-spacing:0.5px";
      togWrap.appendChild(togLbl);
      const sw = crearToggle(!!cfg.enabled, (nuevo) => {
        setConfigCiudad(tid, { enabled: nuevo });
        renderTab(document.querySelector("#panelConfigJam .pcj-body"));
      });
      togWrap.appendChild(sw);
      row1.appendChild(togWrap);
      card.appendChild(row1);

      //Fila 2: ID ciudad objetivo (full-width — antes compartía con el
      //dropdown que ya no existe).
      const targetWrap = document.createElement("label");
      targetWrap.style.cssText = "display:flex;flex-direction:column;gap:2px;margin-bottom:8px";
      const tlbl = document.createElement("span");
      tlbl.textContent = "ID ciudad objetivo";
      tlbl.style.cssText = "color:#7a8aa0;font-size:10px;letter-spacing:0.3px;text-transform:uppercase";
      //type="text" + inputmode="numeric" en vez de type="number": evita las
      //flechas spinner del nativo (inútiles con miles de ciudades como
      //target posible) y permite pegar/tipear largo sin restricciones.
      const tinp = document.createElement("input");
      tinp.type = "text";
      tinp.inputMode = "numeric";
      tinp.placeholder = "ej: 95";
      tinp.value = cfg.targetTownId == null ? "" : String(cfg.targetTownId);
      tinp.style.cssText =
        "padding:6px 8px;background:#0f1620;color:#e6e9ee;" +
        "border:1px solid #2c3a4d;border-radius:3px;font-size:12px;font-family:monospace";
      tinp.addEventListener("change", () => {
        const v = tinp.value.replace(/\D/g, "");
        tinp.value = v;
        setConfigCiudad(tid, { targetTownId: v ? Number(v) : null });
      });
      targetWrap.appendChild(tlbl);
      targetWrap.appendChild(tinp);
      card.appendChild(targetWrap);

      //Fila 3: chips multi-select de unidades. Cada tipo es un chip
      //toggleable: click activa/desactiva. Verde = seleccionado, gris
      //oscuro = disponible (count>0) pero no seleccionado, gris muy oscuro
      //= sin tropas y no seleccionado.
      const unitWrap = document.createElement("div");
      unitWrap.style.cssText = "display:flex;flex-direction:column;gap:4px";
      const seleccionados = cfg.unitTypes.length;
      const ulbl = document.createElement("div");
      ulbl.style.cssText = "display:flex;align-items:center;gap:6px;flex-wrap:wrap";
      //Aviso visible cuando ATACAR está ON pero el usuario no eligió tipos.
      //Sin esto el bot queda silencioso (debeCorrer=false) y el usuario no
      //sabe por qué no pasa nada — el primer reporte de bug fue exactamente
      //ese caso.
      if (cfg.enabled && seleccionados === 0) {
        ulbl.innerHTML =
          `<span style="color:#e74c3c;font-size:10.5px;font-weight:bold;letter-spacing:0.3px">` +
          `⚠  Toca un chip para elegir qué unidades enviar` +
          `</span>`;
      } else {
        ulbl.innerHTML =
          `<span style="color:#7a8aa0;font-size:10px;letter-spacing:0.3px;text-transform:uppercase">Unidades a enviar</span>` +
          `<span style="color:#7a8aa0;font-size:10px">(${seleccionados} seleccionada${seleccionados === 1 ? "" : "s"} — manda todo lo disponible)</span>`;
      }
      unitWrap.appendChild(ulbl);
      unitWrap.appendChild(renderUnitChips(tid, cfg, card));
      card.appendChild(unitWrap);

      //Fila 4: estado del último ataque + countdown del próximo
      const row4 = document.createElement("div");
      row4.style.cssText =
        "display:flex;align-items:center;gap:10px;margin-top:8px;padding-top:8px;" +
        "border-top:1px dashed #2c3a4d;font-size:10.5px;color:#7a8aa0;font-family:monospace";

      const ultimoTxt = document.createElement("span");
      ultimoTxt.style.cssText = "flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
      if (!ult) {
        ultimoTxt.textContent = "Último: —";
      } else if (ult.error) {
        ultimoTxt.innerHTML = `Último: <span style="color:#e74c3c">${escapeHtml(ult.error)}</span> · ${formatHora(ult.ts)}`;
      } else {
        ultimoTxt.innerHTML =
          `Último: <span style="color:#27ae60">${escapeHtml(formatCountsCorto(ult.counts))} → ${ult.targetTownId}</span> · ` +
          `viaje ${core.formatDuracion(ult.oneWaySeg)} · ${formatHora(ult.ts)}`;
      }
      row4.appendChild(ultimoTxt);

      const proximoTxt = document.createElement("span");
      proximoTxt.style.cssText = "flex-shrink:0;color:#3498db;font-weight:bold";
      if (proximoAt) {
        const seg = Math.max(0, Math.round((proximoAt - Date.now()) / 1000));
        proximoTxt.textContent = `próx ${core.formatDuracion(seg)}`;
      } else if (cfg.enabled && data.ataques.habilitada) {
        //Loop encendido + ciudad ON pero no hay timer agendado: o está
        //ejecutándose ahora mismo, o falló y aún no reagendó. Mostrar
        //pulsando para que el usuario sepa que el bot la está procesando.
        proximoTxt.style.color = "#f39c12";
        proximoTxt.textContent = "procesando…";
      } else {
        proximoTxt.textContent = "";
      }
      row4.appendChild(proximoTxt);

      card.appendChild(row4);
      return card;
    }

    //Chips multi-select. Click toggle el tipo en cfg.unitTypes. Mostramos
    //los 21 tipos siempre — ordenados por: seleccionados primero, luego
    //con tropas, luego vacíos. Así el usuario ve la selección actual de un
    //vistazo y los chips relevantes quedan al frente.
    function renderUnitChips(townId, cfg) {
      const wrap = document.createElement("div");
      wrap.style.cssText = "display:flex;flex-wrap:wrap;gap:4px";
      wrap.setAttribute("data-jb-chips", String(townId));

      const cache = data.ataques.unitsCache[townId] || {};
      const selSet = new Set(cfg.unitTypes || []);

      const ordenados = TIPOS_UNIDAD.slice().sort((a, b) => {
        const aSel = selSet.has(a.key) ? 0 : 1;
        const bSel = selSet.has(b.key) ? 0 : 1;
        if (aSel !== bSel) return aSel - bSel;
        const aN = Number(cache[a.key] || 0);
        const bN = Number(cache[b.key] || 0);
        if ((aN > 0) !== (bN > 0)) return bN - aN;
        return 0;
      });

      for (const t of ordenados) {
        const count = Number(cache[t.key] || 0);
        const isSel = selSet.has(t.key);
        const tieneTropas = count > 0;

        const colorBg = isSel ? "#27ae60" : (tieneTropas ? "#1c2733" : "#0f1620");
        const colorTxt = isSel ? "#fff" : (tieneTropas ? "#cdd5e0" : "#5a6776");
        const colorBorder = isSel ? "#27ae60" : "#2c3a4d";

        const chip = document.createElement("button");
        chip.type = "button";
        chip.style.cssText =
          `padding:3px 8px;background:${colorBg};color:${colorTxt};` +
          `border:1px solid ${colorBorder};border-radius:11px;` +
          `font-size:10.5px;cursor:pointer;font-family:'Segoe UI',sans-serif;` +
          `font-weight:${isSel ? "bold" : "normal"};transition:all 0.1s`;
        chip.title = `${t.label}${tieneTropas ? ` · ${count} disponibles` : " · sin tropas"}` +
          ` (click para ${isSel ? "deseleccionar" : "seleccionar"})`;
        chip.innerHTML =
          (isSel ? "✓ " : "") +
          escapeHtml(t.label) +
          (tieneTropas ? ` <span style="opacity:0.75;font-family:monospace;font-size:10px">${count}</span>` : "");
        chip.addEventListener("click", (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          const newSet = new Set(cfg.unitTypes || []);
          if (newSet.has(t.key)) newSet.delete(t.key);
          else newSet.add(t.key);
          setConfigCiudad(townId, { unitTypes: Array.from(newSet) });
          renderTab(document.querySelector("#panelConfigJam .pcj-body"));
        });
        wrap.appendChild(chip);
      }
      return wrap;
    }

    function crearToggle(estadoInicial, onChange) {
      const sw = document.createElement("button");
      sw.style.cssText =
        "position:relative;width:42px;height:22px;border:none;border-radius:11px;" +
        `background:${estadoInicial ? "#27ae60" : "#2c3a4d"};cursor:pointer;` +
        "transition:background 0.2s;flex-shrink:0;padding:0;outline:none";
      const knob = document.createElement("span");
      knob.style.cssText =
        "position:absolute;top:2px;width:18px;height:18px;border-radius:50%;" +
        "background:#fff;transition:left 0.2s;box-shadow:0 1px 3px rgba(0,0,0,0.3);" +
        `left:${estadoInicial ? "22px" : "2px"}`;
      sw.appendChild(knob);
      let estado = !!estadoInicial;
      sw.addEventListener("click", () => {
        estado = !estado;
        sw.style.background = estado ? "#27ae60" : "#2c3a4d";
        knob.style.left = estado ? "22px" : "2px";
        try { onChange(estado); } catch (e) { core.logError("ataques", "toggle handler falló", e); }
      });
      return sw;
    }

    function renderHistorial(dsa) {
      const cont = document.createElement("div");
      cont.style.cssText = "margin-top:14px";

      const header = document.createElement("div");
      header.style.cssText =
        "display:flex;align-items:center;cursor:pointer;padding:6px 8px;" +
        "background:#172029;border-left:3px solid #9b59b6;border-radius:3px;" +
        "user-select:none;font-size:11.5px";
      let abierto = false;
      const arrow = document.createElement("span");
      arrow.textContent = "▶";
      arrow.style.cssText = "margin-right:6px;font-size:9px;color:#7a8aa0;width:10px;display:inline-block";
      const titulo = document.createElement("span");
      titulo.textContent = `Historial reciente (${(dsa.historial || []).length})`;
      titulo.style.cssText = "font-weight:bold;color:#cdd5e0";
      header.appendChild(arrow);
      header.appendChild(titulo);
      cont.appendChild(header);

      const body = document.createElement("div");
      body.style.cssText = "padding:6px 0;display:none";
      cont.appendChild(body);

      header.addEventListener("click", () => {
        abierto = !abierto;
        arrow.textContent = abierto ? "▼" : "▶";
        body.style.display = abierto ? "block" : "none";
        if (abierto) renderHistorialBody(body, dsa);
      });

      return cont;
    }

    function renderHistorialBody(body, dsa) {
      body.innerHTML = "";
      const items = (dsa.historial || []).slice().reverse();
      if (!items.length) {
        const v = document.createElement("div");
        v.textContent = "(todavía no se envió ningún ataque)";
        v.style.cssText = "opacity:0.6;font-style:italic;padding:6px 0;font-size:11px";
        body.appendChild(v);
        return;
      }
      for (const e of items) {
        const fila = document.createElement("div");
        fila.className = "pcj-row";
        fila.style.cssText =
          "display:flex;align-items:center;gap:8px;padding:5px 8px;margin:2px 0;" +
          "background:#172029;border-radius:3px;border-left:3px solid #27ae60;" +
          "font-family:monospace;font-size:10.5px";
        fila.innerHTML =
          `<span style="color:#27ae60;min-width:18px;text-align:center">→</span>` +
          `<span style="color:#7a8aa0;min-width:50px">${formatHora(e.ts)}</span>` +
          `<span style="flex:1;color:#e6e9ee">${escapeHtml(nombreCiudad(e.town_id))} → ${e.target_town_id}</span>` +
          `<span style="color:#f39c12">${e.enviadas} ${escapeHtml(labelUnidad(e.unitType))}</span>` +
          `<span style="color:#7a8aa0;min-width:60px;text-align:right">${core.formatDuracion(e.oneWaySeg)}</span>`;
        body.appendChild(fila);
      }
    }

    function formatHora(ts) {
      if (!ts) return "—";
      const d = new Date(ts);
      const pad = (n) => String(n).padStart(2, "0");
      return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }

    //Atacar manualmente una ciudad — bypassa scheduler y debeCorrer. Útil
    //para testing desde el botón "Atacar ahora" del panel y desde DevTools
    //(`JamBot.features.ataques.api.testAttack(91)`).
    function testAttack(townId) {
      return ejecutarCiudad(Number(townId), { forzar: true });
    }

    //Exponer API para el panel (recoleccion.js delega el render acá).
    JamBot.features.ataques.api = {
      TIPOS_UNIDAD,
      labelUnidad,
      setHabilitada,
      setConfigCiudad,
      queryUnits,
      renderTab,
      testAttack,
      MARGEN_SEGUNDOS,
    };
  }

  JamBot.features.ataques = { init };
})();
