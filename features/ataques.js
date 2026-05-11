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
    //  configPorCiudad:   { [townId]: {
    //                        enabled, unitTypes,                 // round-trip
    //                        spamEnabled, spamUnitTypes,         // spam
    //                        spamCounts: { [unit]: cantidad },
    //                        spamIntervalMin,
    //                        targetTownId                        // compartido
    //                      } }
    //  ultimoPorCiudad:   { [townId]: { rt: {ts,counts,...,error?},
    //                                   sp: {ts,counts,...,error?} } }
    //  proximoPorCiudad:  { [townId]: { rt: ts ms, sp: ts ms } } (no persiste)
    //  historial:         lista FIFO de últimos ataques OK (con `modo`)
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
          //Migración config:
          // - Versiones viejas guardaban `unitType` (string único). Nuevo es
          //   `unitTypes` (array). Convertimos in-place.
          // - El modo spam se agrega como modo PARALELO al round-trip: cada
          //   ciudad tiene `enabled+unitTypes` (round-trip, manda todo y
          //   espera la vuelta) y `spamEnabled+spamUnitTypes+spamCounts+
          //   spamIntervalMin` (spam, manda cantidad fija cada N min). Pueden
          //   correr simultáneo, solo uno, o ninguno. Comparten targetTownId.
          for (const tid of Object.keys(data.ataques.configPorCiudad)) {
            const cfg = data.ataques.configPorCiudad[tid];
            if (!cfg) continue;
            if (cfg.unitType && !Array.isArray(cfg.unitTypes)) {
              cfg.unitTypes = [cfg.unitType];
              delete cfg.unitType;
            }
            if (!Array.isArray(cfg.unitTypes)) cfg.unitTypes = [];
            //Cap opcional por unidad para round-trip: si no hay entrada,
            //manda TODO lo disponible (default histórico). Si hay valor > 0,
            //manda min(disponible, cap).
            if (!cfg.maxCounts || typeof cfg.maxCounts !== "object") cfg.maxCounts = {};
            if (typeof cfg.spamEnabled !== "boolean") cfg.spamEnabled = false;
            if (!Array.isArray(cfg.spamUnitTypes)) cfg.spamUnitTypes = [];
            if (!cfg.spamCounts || typeof cfg.spamCounts !== "object") cfg.spamCounts = {};
            if (typeof cfg.spamIntervalMin !== "number" || cfg.spamIntervalMin <= 0) cfg.spamIntervalMin = 4;
            delete cfg.mode; //limpieza de un intento previo de implementación
          }
          //Migración estado runtime persistido:
          // ultimoPorCiudad[townId] antes era el último round-trip plano.
          // Ahora es { rt: {...}, sp: {...} } — un slot por modo.
          for (const tid of Object.keys(data.ataques.ultimoPorCiudad)) {
            const u = data.ataques.ultimoPorCiudad[tid];
            if (u && typeof u === "object" && !u.rt && !u.sp && (u.ts || u.error || u.counts)) {
              data.ataques.ultimoPorCiudad[tid] = { rt: u };
            }
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

    //Scheduler: dos timers paralelos por ciudad (round-trip y spam). Clave
    //compuesta para que un Map único maneje ambos sin colisión:
    //   "rt:91"  → timer del modo round-trip de la town 91
    //   "sp:91"  → timer del modo spam        de la town 91
    //proximoPorCiudad sigue indexado por townId, pero ahora con sub-keys
    //{rt, sp} para que el panel pueda mostrar el countdown de cada modo.
    const timers = new Map(); //"modo:townId" → setTimeout id

    function timerKey(townId, modo) { return `${modo}:${townId}`; }

    function cancelarTimer(townId, modo) {
      const k = timerKey(townId, modo);
      const t = timers.get(k);
      if (t) { clearTimeout(t); timers.delete(k); }
      const px = data.ataques.proximoPorCiudad[townId];
      if (px) {
        delete px[modo];
        if (Object.keys(px).length === 0) delete data.ataques.proximoPorCiudad[townId];
      }
    }

    function cancelarTodos() {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
      data.ataques.proximoPorCiudad = {};
    }

    function programarCiudad(townId, modo, ms) {
      cancelarTimer(townId, modo);
      const px = (data.ataques.proximoPorCiudad[townId] = data.ataques.proximoPorCiudad[townId] || {});
      px[modo] = Date.now() + ms;
      const k = timerKey(townId, modo);
      const tid = setTimeout(() => {
        timers.delete(k);
        const px2 = data.ataques.proximoPorCiudad[townId];
        if (px2) {
          delete px2[modo];
          if (Object.keys(px2).length === 0) delete data.ataques.proximoPorCiudad[townId];
        }
        ejecutarCiudad(townId, modo).catch((e) => {
          core.logError("ataques", `ciudad ${townId} modo=${modo} falló`, e);
          if (debeCorrer(townId, modo)) programarCiudad(townId, modo, 60_000);
        });
      }, ms);
      timers.set(k, tid);
    }

    function debeCorrer(townId, modo) {
      if (!data.ataques.habilitada) return false;
      //Ataques tiene su propio botón Iniciar/Detener — NO se acopla al
      //play/pause global del bot. Solo CAPTCHA detiene los timers (porque
      //ahí es la integridad del flujo lo que está en juego, no preferencia).
      if (core.isCaptchaActive()) return false;
      const cfg = data.ataques.configPorCiudad[townId];
      if (!cfg) return false;
      if (!cfg.targetTownId) return false;
      if (Number(cfg.targetTownId) === Number(townId)) return false; //auto-ataque sin sentido
      if (modo === "rt") {
        if (!cfg.enabled) return false;
        if (!Array.isArray(cfg.unitTypes) || cfg.unitTypes.length === 0) return false;
        return true;
      }
      if (modo === "sp") {
        if (!cfg.spamEnabled) return false;
        if (!Array.isArray(cfg.spamUnitTypes) || cfg.spamUnitTypes.length === 0) return false;
        //Spam exige cantidad > 0 para TODOS los tipos seleccionados — sin
        //esto pediríamos 0 unidades y el server rechazaría.
        for (const ut of cfg.spamUnitTypes) {
          if (!(Number(cfg.spamCounts && cfg.spamCounts[ut]) > 0)) return false;
        }
        return true;
      }
      return false;
    }

    function razonOmision(townId, modo) {
      const cfg = data.ataques.configPorCiudad[townId];
      if (!cfg) return "sin config";
      if (!cfg.targetTownId) return "sin target";
      if (Number(cfg.targetTownId) === Number(townId)) return "target = ciudad propia";
      if (modo === "rt") {
        if (!cfg.enabled) return "round-trip off";
        if (!Array.isArray(cfg.unitTypes) || cfg.unitTypes.length === 0) return "round-trip sin unidades";
      } else if (modo === "sp") {
        if (!cfg.spamEnabled) return "spam off";
        if (!Array.isArray(cfg.spamUnitTypes) || cfg.spamUnitTypes.length === 0) return "spam sin unidades";
        if (cfg.spamUnitTypes.some(ut => !(Number(cfg.spamCounts && cfg.spamCounts[ut]) > 0))) return "spam sin cantidades por tanda";
      }
      if (core.isCaptchaActive()) return "captcha activo";
      return "?";
    }

    function arrancarTodas() {
      const ciudades = obtenerListaCiudadesPropias();
      let i = 0;
      const programadas = [];
      const omitidas = [];
      //Iteramos cada ciudad y cada modo (rt, sp) — son scheduling slots
      //independientes. Stagger acumulado para que ni los round-trip ni los
      //spam disparen todos al mismo segundo.
      for (const townId of ciudades) {
        for (const modo of ["rt", "sp"]) {
          if (!debeCorrer(townId, modo)) {
            const cfg = data.ataques.configPorCiudad[townId];
            //Solo reportamos como "omitida" si el modo está habilitado
            //pero le falta algo. Si está OFF a propósito, no es ruido.
            const estaON = cfg && (modo === "rt" ? cfg.enabled : cfg.spamEnabled);
            if (estaON) omitidas.push(`${nombreCiudad(townId)}/${modo} (${razonOmision(townId, modo)})`);
            continue;
          }
          const ms = jitter(1500, 3000) + i * 1500;
          programarCiudad(townId, modo, ms);
          programadas.push(`${nombreCiudad(townId)}/${modo} en ${Math.round(ms/1000)}s`);
          i += 1;
        }
      }
      if (programadas.length) {
        core.log("ataques", `arrancarTodas: ${programadas.length} slot(s) programado(s) → ${programadas.join(", ")}`, "ok");
      } else {
        core.logWarn(
          "ataques",
          `arrancarTodas: NINGUNA ciudad programada. Omitidas: ${omitidas.length ? omitidas.join("; ") : "(0)"}. Verificá ATACAR/Spam/target/unidades.`
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

    //Reintento corto cuando spam no pudo disparar por tropas insuficientes.
    //Confirmado con el usuario: el reloj de N min se resetea SOLO tras un
    //disparo exitoso; mientras tanto polleamos cortito para no saltarnos
    //ventanas de oportunidad.
    const SPAM_RETRY_FALTA_TROPAS_MS = 30_000;

    async function ejecutarCiudad(townId, modo, opts) {
      const forzar = !!(opts && opts.forzar);
      if (!forzar && !debeCorrer(townId, modo)) {
        core.log("ataques", `tick town=${townId} modo=${modo} ignorado (debeCorrer=false)`, "info");
        return;
      }
      const cfg = data.ataques.configPorCiudad[townId];
      const tiposCfg = modo === "rt" ? cfg.unitTypes : cfg.spamUnitTypes;
      core.log(
        "ataques",
        `→ disparando town=${nombreCiudad(townId)} target=${cfg.targetTownId} modo=${modo} tipos=[${(tiposCfg || []).join(",")}]${forzar ? " [MANUAL]" : ""}`,
        "info"
      );

      const units = await queryUnits(townId);
      if (units) data.ataques.unitsCache[townId] = units;
      if (!units) {
        core.logWarn("ataques", `town=${nombreCiudad(townId)} sin modelo Units en MM — abrí la ciudad en el juego al menos una vez`);
        registrarUltimo(townId, modo, { error: "Units no cargado" });
        if (!forzar && debeCorrer(townId, modo)) programarCiudad(townId, modo, 60_000);
        return;
      }
      core.log("ataques", `town=${nombreCiudad(townId)} Units leído OK · slinger=${units.slinger||0} sword=${units.sword||0} archer=${units.archer||0} hoplite=${units.hoplite||0}`, "info");

      //Construcción del counts según modo:
      // - rt: manda TODO lo disponible de cada tipo seleccionado. Tipos en
      //   0 se omiten del payload (no tiene sentido mandar 0).
      // - sp: manda EXACTAMENTE la cantidad configurada por tipo. Si algún
      //   tipo no tiene suficientes en casa, NO mandamos nada y reintentamos
      //   corto — confirmado con el usuario.
      const counts = {};
      let total = 0;
      if (modo === "rt") {
        for (const ut of cfg.unitTypes) {
          const have = Number(units[ut] || 0);
          //Cap opcional: si maxCounts[ut] > 0 limitamos al mínimo entre
          //disponible y cap. Sin cap (campo vacío) manda todo lo disponible.
          const cap = Number(cfg.maxCounts && cfg.maxCounts[ut]);
          const n = cap > 0 ? Math.min(have, cap) : have;
          if (n > 0) { counts[ut] = n; total += n; }
        }
        if (total <= 0) {
          const lbls = cfg.unitTypes.map(labelUnidad).join("/");
          core.logWarn("ataques", `town=${nombreCiudad(townId)} round-trip sin tropas (${lbls}) — reintento en 5min`);
          registrarUltimo(townId, modo, { error: `sin tropas (${lbls})` });
          if (!forzar && debeCorrer(townId, modo)) programarCiudad(townId, modo, 5 * 60_000);
          return;
        }
      } else {
        const faltantes = [];
        for (const ut of cfg.spamUnitTypes) {
          const want = Number(cfg.spamCounts[ut] || 0);
          const have = Number(units[ut] || 0);
          if (have < want) faltantes.push(`${labelUnidad(ut)} ${have}/${want}`);
          else { counts[ut] = want; total += want; }
        }
        if (faltantes.length) {
          core.logWarn("ataques", `town=${nombreCiudad(townId)} spam: tropas insuficientes (${faltantes.join(", ")}) — reintento en ${SPAM_RETRY_FALTA_TROPAS_MS/1000}s`);
          registrarUltimo(townId, modo, { error: `spam: faltan ${faltantes.join(", ")}` });
          if (!forzar && debeCorrer(townId, modo)) programarCiudad(townId, modo, SPAM_RETRY_FALTA_TROPAS_MS);
          return;
        }
      }

      const r = await enviarAtaque(townId, Number(cfg.targetTownId), counts);
      if (!r.ok) {
        registrarUltimo(townId, modo, { error: r.error || "fallo desconocido" });
        if (!forzar && debeCorrer(townId, modo)) programarCiudad(townId, modo, 60_000);
        return;
      }

      const oneWaySeg = r.arrivalAt - r.startedAt;
      //Reagenda según modo:
      // - rt: 2*viaje + margen, anclado a started_at del server (evita
      //   acumular drift del reloj cliente).
      // - sp: intervalo fijo configurado (ej. 4 min). Fire-and-forget —
      //   no esperamos vuelta, el reloj arranca al disparar.
      let proximoSeg;
      if (modo === "rt") {
        const proximoServerTs = r.startedAt + 2 * oneWaySeg + MARGEN_SEGUNDOS;
        const ahoraSeg = Math.floor(Date.now() / 1000);
        proximoSeg = Math.max(MARGEN_SEGUNDOS, proximoServerTs - ahoraSeg);
      } else {
        proximoSeg = Math.max(30, Math.round(cfg.spamIntervalMin * 60));
      }

      registrarUltimo(townId, modo, {
        counts,
        total,
        oneWaySeg,
        targetTownId: cfg.targetTownId,
      });
      registrarHistorial({
        ts: Date.now(),
        town_id: townId,
        target_town_id: cfg.targetTownId,
        modo,
        counts,
        total,
        oneWaySeg,
      });

      const enviadoTxt = formatCountsCorto(counts);
      core.log(
        "ataques",
        `✓ ${nombreCiudad(townId)} → ${cfg.targetTownId} · modo=${modo} · ${enviadoTxt} · viaje ${core.formatDuracion(oneWaySeg)} · siguiente en ${core.formatDuracion(proximoSeg)}`,
        "ok"
      );

      if (!forzar && debeCorrer(townId, modo)) programarCiudad(townId, modo, proximoSeg * 1000);
    }

    //Formatea un counts {slinger:192, sword:50} como "192 Honderos + 50 Espadachines".
    //Usado tanto en logs como en el panel.
    function formatCountsCorto(counts) {
      const partes = Object.entries(counts || {})
        .filter(([, n]) => Number(n) > 0)
        .map(([ut, n]) => `${n} ${labelUnidad(ut)}`);
      return partes.length ? partes.join(" + ") : "—";
    }

    function registrarUltimo(townId, modo, info) {
      const slot = (data.ataques.ultimoPorCiudad[townId] = data.ataques.ultimoPorCiudad[townId] || {});
      slot[modo] = { ts: Date.now(), ...info };
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
      //Reagendar AMBOS modos: el cambio puede afectar a uno, al otro o a
      //los dos (ej. cambiar targetTownId afecta a los dos). Cancelamos y
      //reprogramamos solo los que ahora deban correr — los demás quedan off.
      for (const modo of ["rt", "sp"]) {
        cancelarTimer(townId, modo);
        if (debeCorrer(townId, modo)) programarCiudad(townId, modo, jitter(800, 2000));
      }
    }

    //Merge parcial de spamCounts — la UI actualiza una unidad a la vez,
    //necesitamos preservar el resto. Pasar value=null/0 para borrar la entrada.
    function setSpamCount(townId, unitKey, value) {
      const prev = data.ataques.configPorCiudad[townId] || {};
      const counts = { ...(prev.spamCounts || {}) };
      const n = Number(value);
      if (!n || n <= 0) delete counts[unitKey];
      else counts[unitKey] = Math.floor(n);
      setConfigCiudad(townId, { spamCounts: counts });
    }

    //Merge parcial de maxCounts (cap del round-trip). Sin entrada = sin
    //cap = manda todo lo disponible.
    function setMaxCount(townId, unitKey, value) {
      const prev = data.ataques.configPorCiudad[townId] || {};
      const counts = { ...(prev.maxCounts || {}) };
      const n = Number(value);
      if (!n || n <= 0) delete counts[unitKey];
      else counts[unitKey] = Math.floor(n);
      setConfigCiudad(townId, { maxCounts: counts });
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
      //Contamos slots activos (no ciudades): una ciudad puede tener rt+sp.
      let slotsRT = 0, slotsSP = 0;
      for (const c of Object.values(dsa.configPorCiudad)) {
        if (!c || !c.targetTownId) continue;
        if (c.enabled && Array.isArray(c.unitTypes) && c.unitTypes.length > 0) slotsRT++;
        if (c.spamEnabled && Array.isArray(c.spamUnitTypes) && c.spamUnitTypes.length > 0
            && c.spamUnitTypes.every(ut => Number(c.spamCounts && c.spamCounts[ut]) > 0)) slotsSP++;
      }
      //Ataques es independiente del play/pause global — solo CAPTCHA lo
      //pausa. Por eso el sub-text NO menciona el bot global.
      const corriendo = dsa.habilitada && !core.isCaptchaActive();
      sub.textContent = corriendo
        ? `Activo · ${slotsRT} round-trip · ${slotsSP} spam`
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
      const cfg = data.ataques.configPorCiudad[tid] || {
        enabled: false, targetTownId: "", unitTypes: [],
        spamEnabled: false, spamUnitTypes: [], spamCounts: {}, spamIntervalMin: 4,
      };
      if (!Array.isArray(cfg.unitTypes)) cfg.unitTypes = [];
      if (!Array.isArray(cfg.spamUnitTypes)) cfg.spamUnitTypes = [];
      if (!cfg.spamCounts || typeof cfg.spamCounts !== "object") cfg.spamCounts = {};
      if (typeof cfg.spamIntervalMin !== "number" || cfg.spamIntervalMin <= 0) cfg.spamIntervalMin = 4;

      const algunModoOn = cfg.enabled || cfg.spamEnabled;
      const proximoSlots = data.ataques.proximoPorCiudad[tid] || {};
      const ultSlots = data.ataques.ultimoPorCiudad[tid] || {};
      const hayProximo = proximoSlots.rt || proximoSlots.sp;
      const algunError = (ultSlots.rt && ultSlots.rt.error) || (ultSlots.sp && ultSlots.sp.error);
      const algunOk = (ultSlots.rt && !ultSlots.rt.error) || (ultSlots.sp && !ultSlots.sp.error);

      const colorAcento = !algunModoOn
        ? "#5a6776"
        : (hayProximo ? "#3498db" : (algunOk ? "#27ae60" : (algunError ? "#e74c3c" : "#3498db")));

      const card = document.createElement("div");
      card.style.cssText =
        "padding:10px 12px;background:#172029;border:1px solid #2c3a4d;" +
        `border-left:3px solid ${colorAcento};border-radius:4px`;

      //Fila 1: nombre de la ciudad
      const row1 = document.createElement("div");
      row1.style.cssText = "display:flex;align-items:center;gap:10px;margin-bottom:8px";
      const nombre = document.createElement("div");
      nombre.style.cssText = "flex:1;min-width:0";
      nombre.innerHTML =
        `<div style="font-weight:bold;color:#e6e9ee;font-size:13px">${escapeHtml(ciudad.nombreCiudad || "")}</div>` +
        `<div style="color:#7a8aa0;font-size:10px;font-family:monospace">id ${tid}</div>`;
      row1.appendChild(nombre);
      card.appendChild(row1);

      //Fila 2: ID ciudad objetivo (compartido entre los dos modos)
      const targetWrap = document.createElement("label");
      targetWrap.style.cssText = "display:flex;flex-direction:column;gap:2px;margin-bottom:10px";
      const tlbl = document.createElement("span");
      tlbl.textContent = "ID ciudad objetivo (compartido)";
      tlbl.style.cssText = "color:#7a8aa0;font-size:10px;letter-spacing:0.3px;text-transform:uppercase";
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

      //Sección Round-trip (modo original) y sección Spam (modo nuevo).
      //Cada una con su propio toggle, chips, descripción y estado.
      card.appendChild(renderSeccionRT(tid, cfg, ultSlots.rt, proximoSlots.rt));
      card.appendChild(renderSeccionSP(tid, cfg, ultSlots.sp, proximoSlots.sp));

      return card;
    }

    //—— Sección Round-trip ——
    function renderSeccionRT(tid, cfg, ult, proximoAt) {
      const sec = crearSeccionModo({
        tituloLabel: "Atacar (round-trip)",
        toggleColor: cfg.enabled ? "#27ae60" : "#7a8aa0",
        toggleEstado: !!cfg.enabled,
        toggleOnChange: (nuevo) => {
          setConfigCiudad(tid, { enabled: nuevo });
          rerenderTab();
        },
        descripcion: "Manda TODO lo disponible y espera ida + vuelta.",
      });

      const seleccionados = (cfg.unitTypes || []).length;
      const ulbl = document.createElement("div");
      ulbl.style.cssText = "display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:6px";
      if (cfg.enabled && seleccionados === 0) {
        ulbl.innerHTML =
          `<span style="color:#e74c3c;font-size:10.5px;font-weight:bold">` +
          `⚠  Toca un chip para elegir qué unidades enviar</span>`;
      } else {
        ulbl.innerHTML =
          `<span style="color:#7a8aa0;font-size:10px;text-transform:uppercase">Unidades</span>` +
          `<span style="color:#7a8aa0;font-size:10px">(${seleccionados} sel — manda todo lo disponible)</span>`;
      }
      sec.appendChild(ulbl);
      sec.appendChild(renderUnitChips(tid, cfg.unitTypes, (arr) => {
        setConfigCiudad(tid, { unitTypes: arr });
        rerenderTab();
      }));

      //Grilla de cap opcional por unidad. Vacío = manda TODO lo disponible
      //(comportamiento histórico). Con número = manda min(disponible, cap).
      if (cfg.unitTypes.length > 0) {
        const cntsLbl = document.createElement("div");
        cntsLbl.style.cssText = "color:#7a8aa0;font-size:10px;text-transform:uppercase;margin-top:8px;letter-spacing:0.3px";
        cntsLbl.textContent = "Cap por unidad (vacío = todo)";
        sec.appendChild(cntsLbl);

        const grid = document.createElement("div");
        grid.style.cssText = "display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px;margin-top:4px";
        for (const ut of cfg.unitTypes) {
          const row = document.createElement("label");
          row.style.cssText = "display:flex;align-items:center;gap:6px;background:#0f1620;padding:4px 6px;border-radius:3px;border:1px solid #2c3a4d";
          const lbl = document.createElement("span");
          lbl.textContent = labelUnidad(ut);
          lbl.style.cssText = "flex:1;color:#cdd5e0;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
          const inp = document.createElement("input");
          inp.type = "text";
          inp.inputMode = "numeric";
          inp.placeholder = "todo";
          inp.value = (cfg.maxCounts && cfg.maxCounts[ut] != null) ? String(cfg.maxCounts[ut]) : "";
          inp.style.cssText =
            "width:64px;padding:3px 6px;background:#172029;color:#e6e9ee;" +
            "border:1px solid #2c3a4d;border-radius:3px;font-size:11.5px;font-family:monospace;text-align:right";
          inp.addEventListener("change", () => {
            const raw = inp.value.replace(/\D/g, "");
            inp.value = raw;
            setMaxCount(tid, ut, raw ? Number(raw) : 0);
          });
          row.appendChild(lbl);
          row.appendChild(inp);
          grid.appendChild(row);
        }
        sec.appendChild(grid);
      }

      sec.appendChild(renderEstadoModo(ult, proximoAt, cfg.enabled, "rt"));
      return sec;
    }

    //—— Sección Spam ——
    function renderSeccionSP(tid, cfg, ult, proximoAt) {
      const sec = crearSeccionModo({
        tituloLabel: "Spam (cantidad fija cada N min)",
        toggleColor: cfg.spamEnabled ? "#9b59b6" : "#7a8aa0",
        toggleEstado: !!cfg.spamEnabled,
        toggleColorON: "#9b59b6",
        toggleOnChange: (nuevo) => {
          setConfigCiudad(tid, { spamEnabled: nuevo });
          rerenderTab();
        },
        descripcion: "Manda EXACTAMENTE las cantidades configuradas cada N minutos. Si no hay suficientes en casa, espera y reintenta.",
      });

      //Input intervalo (minutos)
      const intRow = document.createElement("div");
      intRow.style.cssText = "display:flex;align-items:center;gap:8px;margin-top:6px";
      const intLbl = document.createElement("span");
      intLbl.textContent = "Intervalo (min):";
      intLbl.style.cssText = "color:#7a8aa0;font-size:10.5px;text-transform:uppercase;letter-spacing:0.3px";
      const intInp = document.createElement("input");
      intInp.type = "text";
      intInp.inputMode = "decimal";
      intInp.value = String(cfg.spamIntervalMin);
      intInp.style.cssText =
        "width:60px;padding:4px 6px;background:#0f1620;color:#e6e9ee;" +
        "border:1px solid #2c3a4d;border-radius:3px;font-size:12px;font-family:monospace;text-align:right";
      intInp.addEventListener("change", () => {
        const raw = intInp.value.replace(",", ".").replace(/[^0-9.]/g, "");
        const n = parseFloat(raw);
        const valido = isFinite(n) && n > 0 ? n : 4;
        intInp.value = String(valido);
        setConfigCiudad(tid, { spamIntervalMin: valido });
      });
      intRow.appendChild(intLbl);
      intRow.appendChild(intInp);
      sec.appendChild(intRow);

      //Chips de unidades (set independiente del round-trip)
      const seleccionados = (cfg.spamUnitTypes || []).length;
      const ulbl = document.createElement("div");
      ulbl.style.cssText = "display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:6px";
      if (cfg.spamEnabled && seleccionados === 0) {
        ulbl.innerHTML =
          `<span style="color:#e74c3c;font-size:10.5px;font-weight:bold">` +
          `⚠  Toca un chip para elegir qué unidades enviar en cada tanda</span>`;
      } else {
        ulbl.innerHTML =
          `<span style="color:#7a8aa0;font-size:10px;text-transform:uppercase">Unidades por tanda</span>` +
          `<span style="color:#7a8aa0;font-size:10px">(${seleccionados} sel)</span>`;
      }
      sec.appendChild(ulbl);
      sec.appendChild(renderUnitChips(tid, cfg.spamUnitTypes, (arr) => {
        setConfigCiudad(tid, { spamUnitTypes: arr });
        rerenderTab();
      }));

      //Inputs de cantidad por tipo seleccionado
      if (cfg.spamUnitTypes.length > 0) {
        const cntsLbl = document.createElement("div");
        cntsLbl.style.cssText = "color:#7a8aa0;font-size:10px;text-transform:uppercase;margin-top:8px;letter-spacing:0.3px";
        cntsLbl.textContent = "Cantidad por tanda";
        sec.appendChild(cntsLbl);

        const grid = document.createElement("div");
        grid.style.cssText = "display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px;margin-top:4px";
        for (const ut of cfg.spamUnitTypes) {
          const row = document.createElement("label");
          row.style.cssText = "display:flex;align-items:center;gap:6px;background:#0f1620;padding:4px 6px;border-radius:3px;border:1px solid #2c3a4d";
          const lbl = document.createElement("span");
          lbl.textContent = labelUnidad(ut);
          lbl.style.cssText = "flex:1;color:#cdd5e0;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
          const inp = document.createElement("input");
          inp.type = "text";
          inp.inputMode = "numeric";
          inp.placeholder = "ej: 52";
          inp.value = cfg.spamCounts[ut] != null ? String(cfg.spamCounts[ut]) : "";
          //Resaltar en rojo si el modo está ON pero la cantidad es 0/vacía
          //(idéntica condición a la que evalúa debeCorrer).
          const vacio = !(Number(cfg.spamCounts[ut]) > 0);
          inp.style.cssText =
            "width:64px;padding:3px 6px;background:#172029;color:#e6e9ee;" +
            `border:1px solid ${cfg.spamEnabled && vacio ? "#e74c3c" : "#2c3a4d"};` +
            "border-radius:3px;font-size:11.5px;font-family:monospace;text-align:right";
          inp.addEventListener("change", () => {
            const raw = inp.value.replace(/\D/g, "");
            inp.value = raw;
            setSpamCount(tid, ut, raw ? Number(raw) : 0);
          });
          row.appendChild(lbl);
          row.appendChild(inp);
          grid.appendChild(row);
        }
        sec.appendChild(grid);
      }

      sec.appendChild(renderEstadoModo(ult, proximoAt, cfg.spamEnabled, "sp"));
      return sec;
    }

    //Esqueleto común de cada sección de modo: contenedor con borde + header
    //(label + toggle) + descripción. Los hijos específicos del modo se
    //agregan luego con appendChild.
    function crearSeccionModo({ tituloLabel, toggleColor, toggleColorON, toggleEstado, toggleOnChange, descripcion }) {
      const sec = document.createElement("div");
      sec.style.cssText =
        "margin-top:10px;padding:8px 10px;background:#0f1620;border:1px solid #2c3a4d;border-radius:4px";

      const head = document.createElement("div");
      head.style.cssText = "display:flex;align-items:center;gap:8px;margin-bottom:4px";
      const lbl = document.createElement("span");
      lbl.textContent = tituloLabel;
      lbl.style.cssText =
        `flex:1;color:${toggleColor};font-size:11.5px;font-weight:bold;` +
        "text-transform:uppercase;letter-spacing:0.5px";
      head.appendChild(lbl);
      const sw = crearToggle(toggleEstado, toggleOnChange, toggleColorON || "#27ae60");
      head.appendChild(sw);
      sec.appendChild(head);

      const desc = document.createElement("div");
      desc.style.cssText = "color:#7a8aa0;font-size:10px;font-style:italic;margin-bottom:2px";
      desc.textContent = descripcion;
      sec.appendChild(desc);

      return sec;
    }

    //Fila de estado: último resultado + countdown del próximo. Compartida
    //entre los dos modos. Muestra "procesando…" cuando el modo está ON pero
    //no hay timer agendado (entre el tick y la reagenda — milisegundos).
    function renderEstadoModo(ult, proximoAt, modoON, modoLabel) {
      const row = document.createElement("div");
      row.style.cssText =
        "display:flex;align-items:center;gap:10px;margin-top:8px;padding-top:6px;" +
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
      row.appendChild(ultimoTxt);

      const proximoTxt = document.createElement("span");
      proximoTxt.style.cssText = "flex-shrink:0;color:#3498db;font-weight:bold";
      if (proximoAt) {
        const seg = Math.max(0, Math.round((proximoAt - Date.now()) / 1000));
        proximoTxt.textContent = `próx ${core.formatDuracion(seg)}`;
      } else if (modoON && data.ataques.habilitada) {
        proximoTxt.style.color = "#f39c12";
        proximoTxt.textContent = "procesando…";
      } else {
        proximoTxt.textContent = "";
      }
      row.appendChild(proximoTxt);

      return row;
    }

    function rerenderTab() {
      const body = document.querySelector("#panelConfigJam .pcj-body");
      if (body) renderTab(body);
    }

    //Chips multi-select. Genérico — recibe la lista de keys seleccionadas
    //y un callback que se llama con el array nuevo al togglear. Reutilizado
    //por la sección round-trip (cfg.unitTypes) y la sección spam (cfg.spamUnitTypes).
    //Mostramos los 21 tipos siempre, ordenados por: seleccionados primero,
    //luego con tropas, luego vacíos.
    function renderUnitChips(townId, selectedKeys, onToggle) {
      const wrap = document.createElement("div");
      wrap.style.cssText = "display:flex;flex-wrap:wrap;gap:4px";

      const cache = data.ataques.unitsCache[townId] || {};
      const selSet = new Set(selectedKeys || []);

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
          const newSet = new Set(selectedKeys || []);
          if (newSet.has(t.key)) newSet.delete(t.key);
          else newSet.add(t.key);
          onToggle(Array.from(newSet));
        });
        wrap.appendChild(chip);
      }
      return wrap;
    }

    function crearToggle(estadoInicial, onChange, colorON) {
      const cON = colorON || "#27ae60";
      const sw = document.createElement("button");
      sw.style.cssText =
        "position:relative;width:42px;height:22px;border:none;border-radius:11px;" +
        `background:${estadoInicial ? cON : "#2c3a4d"};cursor:pointer;` +
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
        sw.style.background = estado ? cON : "#2c3a4d";
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
        //Compatibilidad con entradas viejas que guardaban `enviadas`+`unitType`
        //como string único (formato pre-multi-unidad). Para entradas nuevas
        //usamos `counts` formateado.
        const enviadoTxt = e.counts
          ? formatCountsCorto(e.counts)
          : (e.enviadas != null ? `${e.enviadas} ${labelUnidad(e.unitType)}` : "—");
        const modoTag = e.modo === "sp" ? "SPAM" : (e.modo === "rt" ? "RT" : "");
        const modoColor = e.modo === "sp" ? "#9b59b6" : "#27ae60";
        const fila = document.createElement("div");
        fila.className = "pcj-row";
        fila.style.cssText =
          "display:flex;align-items:center;gap:8px;padding:5px 8px;margin:2px 0;" +
          `background:#172029;border-radius:3px;border-left:3px solid ${modoColor};` +
          "font-family:monospace;font-size:10.5px";
        fila.innerHTML =
          `<span style="color:${modoColor};min-width:36px;text-align:center;font-weight:bold">${modoTag}</span>` +
          `<span style="color:#7a8aa0;min-width:50px">${formatHora(e.ts)}</span>` +
          `<span style="flex:1;color:#e6e9ee">${escapeHtml(nombreCiudad(e.town_id))} → ${e.target_town_id}</span>` +
          `<span style="color:#f39c12">${escapeHtml(enviadoTxt)}</span>` +
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
    //para testing desde DevTools: `JamBot.features.ataques.api.testAttack(91, "rt")`
    //o `testAttack(91, "sp")`. Default "rt" para retrocompatibilidad.
    function testAttack(townId, modo) {
      return ejecutarCiudad(Number(townId), modo || "rt", { forzar: true });
    }

    //Exponer API para el panel (recoleccion.js delega el render acá).
    JamBot.features.ataques.api = {
      TIPOS_UNIDAD,
      labelUnidad,
      setHabilitada,
      setConfigCiudad,
      setSpamCount,
      setMaxCount,
      queryUnits,
      renderTab,
      testAttack,
      MARGEN_SEGUNDOS,
    };
  }

  JamBot.features.ataques = { init };
})();
