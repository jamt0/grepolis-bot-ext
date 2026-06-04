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
          //blob.habilitada existía como master switch global; lo
          //ignoramos: ahora cada toggle (rt/sp por ciudad) controla
          //independientemente su ciclo.
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
            //Config del modo "Isla" (one-shot): última isla cargada + qué
            //unidades/cantidades mandar por ciudad. La lista de ciudades NO
            //se persiste — se vuelve a cargar cada vez. seleccionadas también
            //es runtime (Set en islaRuntime).
            if (!cfg.isla || typeof cfg.isla !== "object") {
              cfg.isla = { islandId: "", unitTypes: [], counts: {} };
            }
            if (!Array.isArray(cfg.isla.unitTypes)) cfg.isla.unitTypes = [];
            if (!cfg.isla.counts || typeof cfg.isla.counts !== "object") cfg.isla.counts = {};
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
      //Cada toggle por (ciudad, modo) controla su propio ciclo. No hay
      //master switch global — el toggle individual es el botón Iniciar/
      //Pausar de ese ciclo. Solo CAPTCHA detiene todos los timers (porque
      //ahí es la integridad del flujo lo que está en juego).
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
        if (!forzar && debeCorrer(townId, modo)) {
          //Si el server dijo "sin tropas", esperamos el mismo intervalo que
          //la rama del chequeo previo basado en cache — no es un fallo de
          //red, es ciclo natural de disponibilidad.
          const espera = r.noTropas
            ? (modo === "rt" ? 5 * 60_000 : SPAM_RETRY_FALTA_TROPAS_MS)
            : 60_000;
          programarCiudad(townId, modo, espera);
        }
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
        const errStr = j && j.error ? String(j.error) : "";
        //Falta-de-tropas del server: el modelo Units en MM estaba stale —
        //mostraba unidades que ya no estaban (movimiento en vuelo, refuerzo,
        //etc.). NO es CAPTCHA; esperá el siguiente ciclo igual que la rama
        //de chequeo previo basada en cache (líneas 423-428).
        const esFaltaTropas = /habitantes|inhabitants|al menos/i.test(errStr);
        if (esFaltaTropas) {
          core.logWarn(
            "ataques",
            `town=${nombreCiudad(attackerTownId)} sin tropas según server (${errStr}) — reintento próximo ciclo`
          );
          return { ok: false, error: errStr || "sin tropas (server)", noTropas: true };
        }
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
        return { ok: false, error: errStr || "sin success" };
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

    //Merge parcial del sub-objeto isla. Necesario porque renderCardCiudad usa
    //un fallback local cuando configPorCiudad[tid] no existe — mutar ese fallback
    //no persiste nada. Esto garantiza que la entry exista y que la mutación
    //llegue a chrome.storage. NO reagenda timers (isla es one-shot manual).
    function setConfigIsla(townId, patch) {
      const prev = data.ataques.configPorCiudad[townId] || {};
      const prevIsla = (prev.isla && typeof prev.isla === "object")
        ? prev.isla
        : { islandId: "", unitTypes: [], counts: {} };
      data.ataques.configPorCiudad[townId] = {
        ...prev,
        isla: { ...prevIsla, ...patch },
      };
      persistir();
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
      if (active) {
        cancelarTodos();
      } else {
        arrancarTodas();
      }
    });

    //Boot: esperar a que recoleccion termine de poblar
    //data.ciudadesConAldeas. Esa carga es async (depende de modelos del
    //juego) y puede tardar más que el await de feature.init. Hacemos hasta
    //6 intentos cada 5s; si en 30s no hay ciudades, abortamos. Sin master
    //switch: cada toggle de ciudad/modo decide individualmente si corre.
    function bootArrancar(intentos) {
      if (core.isCaptchaActive()) return;
      if (obtenerListaCiudadesPropias().length) {
        arrancarTodas();
        return;
      }
      if (intentos <= 0) {
        core.logWarn("ataques", "no hay ciudades cargadas tras 30s");
        return;
      }
      setTimeout(() => bootArrancar(intentos - 1), 5000);
    }
    if (!core.isCaptchaActive()) {
      setTimeout(() => bootArrancar(6), 4000);
    }

    //—— Estado runtime de UI (NO persiste entre reloads) ————————————————
    //
    //  cardExpandidas:    Set<townId> — cards expandidas. Default: todas
    //                     colapsadas para visión panorámica.
    //  tabActivoPorCiudad: Map<townId, "rt"|"sp"|"isla"> — tab activo dentro
    //                     de la card. Default: "rt".
    //  islaRuntimePorCiudad: Map<townId, {islandId, ciudades, seleccionadas,
    //                     loading, error, atacando}> — buffer de las ciudades
    //                     cargadas para el modo Isla. NO persiste porque el
    //                     mundo cambia y queremos datos frescos cada sesión.
    const cardExpandidas = new Set();
    const tabActivoPorCiudad = new Map();
    const islaRuntimePorCiudad = new Map();

    function getTabActivo(tid) {
      return tabActivoPorCiudad.get(tid) || "rt";
    }
    function setTabActivo(tid, tab) {
      tabActivoPorCiudad.set(tid, tab);
    }
    function getIslaRuntime(tid) {
      if (!islaRuntimePorCiudad.has(tid)) {
        islaRuntimePorCiudad.set(tid, {
          islandId: "", ciudades: null, seleccionadas: new Set(),
          loading: false, error: null, atacando: false, progreso: null,
          resultados: new Map(),
        });
      }
      return islaRuntimePorCiudad.get(tid);
    }

    //—— Fetch: ciudades de una isla ————————————————————————————————————
    //
    //El cliente del juego abre "Información isla" con un GET a island_info.
    //La response trae `town_list` (array de [id, name, player_id, player_name,
    //points, ...] aprox). Como Grepolis ha cambiado el shape entre versiones,
    //parseamos varios shapes posibles y reportamos en log si no encontramos
    //nada — así el usuario puede pasarme el response real para ajustar.
    async function obtenerCiudadesDeIsla(islandId, attackerTownId) {
      const url =
        `https://${world_id}.grepolis.com/game/island_info` +
        `?town_id=${attackerTownId}&action=index&h=${csrfToken}` +
        `&json=${encodeURIComponent(JSON.stringify({
          island_id: Number(islandId), fetch_tmpl: 1,
          town_id: Number(attackerTownId), nl_init: true,
        }))}`;
      const res = await fetch(url, {
        method: "GET",
        credentials: "include",
        headers: { "X-Requested-With": "XMLHttpRequest", "Accept": "text/plain, */*; q=0.01" },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      //Re-dispatch notifications para que MM/Backbone se mantenga sincro.
      if (body && body.json && Array.isArray(body.json.notifications)) {
        window.dispatchEvent(new CustomEvent("JamBot:dispatchNotifications", {
          detail: { notifications: body.json.notifications },
        }));
      }
      //Shapes conocidos posibles:
      //  body.json.town_list = [[id, name, player_id, player_name, points, ...], ...]
      //  body.json.json.town_list = same
      //  body.json.towns = [{id, name, player_id, player_name}, ...]
      const j = (body && body.json) || {};
      const rawList =
        (Array.isArray(j.town_list) && j.town_list) ||
        (j.json && Array.isArray(j.json.town_list) && j.json.town_list) ||
        (Array.isArray(j.towns) && j.towns) ||
        null;
      if (!rawList) {
        core.logWarn(
          "ataques",
          `obtenerCiudadesDeIsla(${islandId}): no encontré town_list en el response — pasame el log a Claude para ajustar el parser`
        );
        return [];
      }
      const ciudades = rawList.map((it) => {
        if (Array.isArray(it)) {
          //Formato tupla del legacy server. Índices comunes:
          //[id, name, player_id, player_name, points, ...]
          return {
            id: Number(it[0]),
            name: String(it[1] || ""),
            playerId: it[2] != null ? Number(it[2]) : null,
            playerName: String(it[3] || ""),
            points: it[4] != null ? Number(it[4]) : null,
          };
        }
        return {
          id: Number(it.id),
          name: String(it.name || ""),
          playerId: it.player_id != null ? Number(it.player_id) : null,
          playerName: String(it.player_name || ""),
          points: it.points != null ? Number(it.points) : null,
        };
      }).filter((c) => c.id > 0);
      return ciudades;
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

      //Subtítulo de info global (sin master switch): cuenta slots activos
      //y deja claro que cada toggle por (ciudad, modo) controla su ciclo.
      body.appendChild(renderResumenSlots(dsa));

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

    function renderResumenSlots(dsa) {
      const wrap = document.createElement("div");
      //Contamos slots activos por modo — uno por toggle prendido en cada
      //ciudad. Esto es informativo: NO hay master switch, cada toggle
      //controla independientemente su propio ciclo.
      let slotsRT = 0, slotsSP = 0;
      for (const c of Object.values(dsa.configPorCiudad)) {
        if (!c || !c.targetTownId) continue;
        if (c.enabled && Array.isArray(c.unitTypes) && c.unitTypes.length > 0) slotsRT++;
        if (c.spamEnabled && Array.isArray(c.spamUnitTypes) && c.spamUnitTypes.length > 0
            && c.spamUnitTypes.every(ut => Number(c.spamCounts && c.spamCounts[ut]) > 0)) slotsSP++;
      }
      const captcha = core.isCaptchaActive();
      const total = slotsRT + slotsSP;
      const borderColor = captcha ? "#7a8aa0" : (total > 0 ? "#27ae60" : "#7a8aa0");
      wrap.style.cssText =
        "display:flex;align-items:center;gap:12px;padding:10px 12px;" +
        "background:#172029;border:1px solid #2c3a4d;border-radius:4px;" +
        `border-left:3px solid ${borderColor}`;

      const left = document.createElement("div");
      left.style.cssText = "flex:1;min-width:0";
      const titulo = document.createElement("div");
      titulo.textContent = "Loops de ataques";
      titulo.style.cssText = "font-weight:bold;color:#e6e9ee;font-size:12.5px";
      const sub = document.createElement("div");
      sub.textContent = captcha
        ? "En espera — CAPTCHA activo"
        : total > 0
          ? `Activo · ${slotsRT} round-trip · ${slotsSP} spam · cada toggle controla su propio ciclo`
          : "Sin ciclos activos — prendé el toggle de la ciudad/modo que quieras";
      sub.style.cssText = "color:#7a8aa0;font-size:10.5px;margin-top:1px";
      left.appendChild(titulo);
      left.appendChild(sub);
      wrap.appendChild(left);
      return wrap;
    }

    //Card de ciudad atacante. Header siempre visible (clickeable para
    //expandir/colapsar) + body con tabs RT/SP/Isla. Default: colapsada,
    //tab RT activo. El estado de expansión y tab vive en `cardExpandidas`
    //y `tabActivoPorCiudad` (memoria, no persiste).
    function renderCardCiudad(ciudad) {
      const tid = ciudad.codigoCiudad;
      const cfg = data.ataques.configPorCiudad[tid] || {
        enabled: false, targetTownId: "", unitTypes: [],
        spamEnabled: false, spamUnitTypes: [], spamCounts: {}, spamIntervalMin: 4,
        isla: { islandId: "", unitTypes: [], counts: {} },
      };
      if (!Array.isArray(cfg.unitTypes)) cfg.unitTypes = [];
      if (!Array.isArray(cfg.spamUnitTypes)) cfg.spamUnitTypes = [];
      if (!cfg.spamCounts || typeof cfg.spamCounts !== "object") cfg.spamCounts = {};
      if (typeof cfg.spamIntervalMin !== "number" || cfg.spamIntervalMin <= 0) cfg.spamIntervalMin = 4;
      if (!cfg.isla || typeof cfg.isla !== "object") cfg.isla = { islandId: "", unitTypes: [], counts: {} };

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
        "background:#172029;border:1px solid #2c3a4d;" +
        `border-left:3px solid ${colorAcento};border-radius:4px;overflow:hidden`;

      const expandida = cardExpandidas.has(tid);

      //——— Header (siempre visible) ———————————————————————————————
      //Click toggle expand/collapse. Muestra:
      //   ▶/▼  Nombre  id   [RT] [SP] [⚔]   estado/countdown
      const header = document.createElement("div");
      header.style.cssText =
        "display:flex;align-items:center;gap:10px;padding:10px 12px;cursor:pointer;" +
        "user-select:none;background:#172029;transition:background 0.15s";
      header.addEventListener("mouseenter", () => { header.style.background = "#1a2530"; });
      header.addEventListener("mouseleave", () => { header.style.background = "#172029"; });

      const arrow = document.createElement("span");
      arrow.textContent = expandida ? "▼" : "▶";
      arrow.style.cssText = "color:#7a8aa0;font-size:10px;width:10px;flex-shrink:0";
      header.appendChild(arrow);

      const nombre = document.createElement("div");
      nombre.style.cssText = "flex:1;min-width:0;display:flex;align-items:baseline;gap:8px";
      nombre.innerHTML =
        `<span style="font-weight:bold;color:#e6e9ee;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(ciudad.nombreCiudad || "")}</span>` +
        `<span style="color:#7a8aa0;font-size:10px;font-family:monospace">id ${tid}</span>`;
      header.appendChild(nombre);

      //Badges de modos activos
      const badges = document.createElement("div");
      badges.style.cssText = "display:flex;gap:4px;flex-shrink:0";
      if (cfg.enabled) badges.appendChild(crearBadge("RT", "#27ae60"));
      if (cfg.spamEnabled) badges.appendChild(crearBadge("SPAM", "#9b59b6"));
      header.appendChild(badges);

      //Resumen estado compacto al lado derecho (solo cuando colapsada)
      if (!expandida) {
        const estado = document.createElement("span");
        estado.style.cssText = "color:#7a8aa0;font-size:10.5px;font-family:monospace;flex-shrink:0";
        const proxRT = proximoSlots.rt;
        const proxSP = proximoSlots.sp;
        const partes = [];
        if (proxRT) {
          const seg = Math.max(0, Math.round((proxRT - Date.now()) / 1000));
          partes.push(`RT ${core.formatDuracion(seg)}`);
        }
        if (proxSP) {
          const seg = Math.max(0, Math.round((proxSP - Date.now()) / 1000));
          partes.push(`SP ${core.formatDuracion(seg)}`);
        }
        if (!partes.length && cfg.targetTownId) partes.push(`→ ${cfg.targetTownId}`);
        estado.textContent = partes.join(" · ");
        header.appendChild(estado);
      }

      header.addEventListener("click", () => {
        if (expandida) cardExpandidas.delete(tid);
        else cardExpandidas.add(tid);
        rerenderTab();
      });
      card.appendChild(header);

      if (!expandida) return card;

      //——— Body (cuando expandida) ————————————————————————————————
      const body = document.createElement("div");
      body.style.cssText = "padding:0 12px 12px 12px;border-top:1px solid #2c3a4d";

      //Target ID (compartido entre RT y SP — el tab Isla tiene su propio
      //selector de ciudades, ignora este). Lo mostramos siempre arriba para
      //que el usuario lo vea al cambiar de tab.
      const targetWrap = document.createElement("label");
      targetWrap.style.cssText = "display:flex;flex-direction:column;gap:3px;margin:10px 0";
      const tlbl = document.createElement("span");
      tlbl.innerHTML =
        `<span style="color:#7a8aa0;font-size:10px;letter-spacing:0.3px;text-transform:uppercase">ID ciudad objetivo</span> ` +
        `<span style="color:#5a6776;font-size:10px">(usado por Round-trip y Spam)</span>`;
      const tinp = document.createElement("input");
      tinp.type = "text";
      tinp.inputMode = "numeric";
      tinp.placeholder = "ej: 95";
      tinp.value = cfg.targetTownId == null ? "" : String(cfg.targetTownId);
      tinp.style.cssText =
        "padding:7px 10px;background:#0f1620;color:#e6e9ee;" +
        "border:1px solid #2c3a4d;border-radius:3px;font-size:12px;font-family:monospace;" +
        "outline:none;transition:border-color 0.15s";
      tinp.addEventListener("focus", () => { tinp.style.borderColor = "#3498db"; });
      tinp.addEventListener("blur", () => { tinp.style.borderColor = "#2c3a4d"; });
      tinp.addEventListener("change", () => {
        const v = tinp.value.replace(/\D/g, "");
        tinp.value = v;
        setConfigCiudad(tid, { targetTownId: v ? Number(v) : null });
      });
      targetWrap.appendChild(tlbl);
      targetWrap.appendChild(tinp);
      body.appendChild(targetWrap);

      //Tab bar
      const tabActivo = getTabActivo(tid);
      const tabBar = document.createElement("div");
      tabBar.style.cssText =
        "display:flex;gap:2px;background:#0f1620;border:1px solid #2c3a4d;" +
        "border-radius:4px;padding:3px;margin-bottom:10px";
      const definirTab = (key, label, accentColor) => {
        const activo = tabActivo === key;
        const btn = document.createElement("button");
        btn.type = "button";
        btn.textContent = label;
        btn.style.cssText =
          "flex:1;padding:6px 10px;border:0;border-radius:3px;cursor:pointer;" +
          "font-size:11.5px;font-weight:bold;letter-spacing:0.3px;" +
          `background:${activo ? accentColor : "transparent"};` +
          `color:${activo ? "#fff" : "#7a8aa0"};` +
          "transition:all 0.15s";
        if (!activo) {
          btn.addEventListener("mouseenter", () => { btn.style.color = "#cdd5e0"; });
          btn.addEventListener("mouseleave", () => { btn.style.color = "#7a8aa0"; });
        }
        btn.addEventListener("click", () => {
          setTabActivo(tid, key);
          rerenderTab();
        });
        return btn;
      };
      tabBar.appendChild(definirTab("rt",   "ROUND-TRIP", "#27ae60"));
      tabBar.appendChild(definirTab("sp",   "SPAM",       "#9b59b6"));
      tabBar.appendChild(definirTab("isla", "ISLA",       "#e67e22"));
      body.appendChild(tabBar);

      //Contenido del tab activo
      if (tabActivo === "rt") {
        body.appendChild(renderSeccionRT(tid, cfg, ultSlots.rt, proximoSlots.rt));
      } else if (tabActivo === "sp") {
        body.appendChild(renderSeccionSP(tid, cfg, ultSlots.sp, proximoSlots.sp));
      } else {
        body.appendChild(renderTabIsla(tid, cfg));
      }

      card.appendChild(body);
      return card;
    }

    function crearBadge(label, color) {
      const b = document.createElement("span");
      b.textContent = label;
      b.style.cssText =
        `background:${color};color:#fff;font-size:9.5px;font-weight:bold;` +
        "padding:2px 6px;border-radius:3px;letter-spacing:0.4px";
      return b;
    }

    //—— Sección Round-trip ——
    function renderSeccionRT(tid, cfg, ult, proximoAt) {
      const sec = crearSeccionModo({
        tituloLabel: "Activar round-trip",
        toggleColor: cfg.enabled ? "#27ae60" : "#7a8aa0",
        toggleEstado: !!cfg.enabled,
        toggleOnChange: (nuevo) => {
          setConfigCiudad(tid, { enabled: nuevo });
          rerenderTab();
        },
        descripcion: "Manda TODO lo disponible y espera ida + vuelta antes de repetir.",
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
        tituloLabel: "Activar spam",
        toggleColor: cfg.spamEnabled ? "#9b59b6" : "#7a8aa0",
        toggleEstado: !!cfg.spamEnabled,
        toggleColorON: "#9b59b6",
        toggleOnChange: (nuevo) => {
          setConfigCiudad(tid, { spamEnabled: nuevo });
          rerenderTab();
        },
        descripcion: "Manda EXACTAMENTE las cantidades configuradas cada N minutos. Si faltan tropas, espera y reintenta.",
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

    //—— Tab Isla (ataque one-shot a todas las ciudades de una isla) ——
    //
    //Flujo:
    //  1. Usuario ingresa ID isla y aprieta "Cargar".
    //  2. obtenerCiudadesDeIsla fetch al server. Filtramos ciudades del
    //     propio jugador (no nos atacamos solos).
    //  3. Render checklist con todas las ciudades cargadas, todas marcadas
    //     por default. Usuario deselecciona las que no quiera atacar.
    //  4. Selector de unidades (chips) + cantidad por unidad. Las cantidades
    //     son POR ciudad atacada (no totales).
    //  5. Botón "Atacar N ciudades" → confirm → loop con jitter, mostrando
    //     progreso. NO espera ida+vuelta (es one-shot).
    //
    //La config (islandId, unitTypes, counts) se persiste por ciudad atacante
    //para que la próxima vez el usuario no tenga que volver a tipear todo.
    //La lista de ciudades cargadas y las seleccionadas NO se persisten — son
    //runtime (islaRuntimePorCiudad).
    function renderTabIsla(tid, cfg) {
      const rt = getIslaRuntime(tid);
      const isla = cfg.isla || (cfg.isla = { islandId: "", unitTypes: [], counts: {} });

      //Default: la isla a la que pertenece la propia ciudad atacante.
      //Si no hay islandId persistido, lo prellenamos para que el usuario
      //solo tenga que apretar "Cargar ciudades".
      if (!isla.islandId) {
        const propia = (data.ciudadesConAldeas || []).find((c) => c.codigoCiudad == tid);
        if (propia && propia.islandId) {
          isla.islandId = String(propia.islandId);
          setConfigIsla(tid, { islandId: isla.islandId });
        }
      }

      const wrap = document.createElement("div");
      wrap.style.cssText =
        "padding:10px 12px;background:#0f1620;border:1px solid #2c3a4d;border-radius:4px";

      //Descripción + advertencia "one-shot"
      const desc = document.createElement("div");
      desc.style.cssText =
        "color:#bdc3c7;font-size:11px;line-height:1.45;margin-bottom:10px;" +
        "padding:7px 9px;background:#172029;border-left:3px solid #e67e22;border-radius:3px";
      desc.innerHTML =
        `<b style="color:#e67e22">Ataque one-shot</b> — manda una ola de tropas a TODAS las ciudades ` +
        `marcadas de la isla. <b>No</b> se repite ni espera ida+vuelta. ` +
        `Las cantidades son <b>por ciudad atacada</b>.`;
      wrap.appendChild(desc);

      //Fila: input ID isla + botón Cargar
      const filaIsla = document.createElement("div");
      filaIsla.style.cssText = "display:flex;gap:8px;align-items:flex-end;margin-bottom:10px";
      const labIsla = document.createElement("label");
      labIsla.style.cssText = "flex:1;display:flex;flex-direction:column;gap:3px";
      const lblTxt = document.createElement("span");
      lblTxt.textContent = "ID isla";
      lblTxt.style.cssText = "color:#7a8aa0;font-size:10px;letter-spacing:0.3px;text-transform:uppercase";
      const inpIsla = document.createElement("input");
      inpIsla.type = "text";
      inpIsla.inputMode = "numeric";
      inpIsla.placeholder = "ej: 58157";
      inpIsla.value = isla.islandId || "";
      inpIsla.style.cssText =
        "padding:7px 10px;background:#0f1620;color:#e6e9ee;" +
        "border:1px solid #2c3a4d;border-radius:3px;font-size:12px;font-family:monospace;" +
        "outline:none;transition:border-color 0.15s";
      inpIsla.addEventListener("focus", () => { inpIsla.style.borderColor = "#e67e22"; });
      inpIsla.addEventListener("blur", () => { inpIsla.style.borderColor = "#2c3a4d"; });
      inpIsla.addEventListener("change", () => {
        const v = inpIsla.value.replace(/\D/g, "");
        inpIsla.value = v;
        isla.islandId = v;
        setConfigIsla(tid, { islandId: v });
      });
      labIsla.appendChild(lblTxt);
      labIsla.appendChild(inpIsla);
      filaIsla.appendChild(labIsla);

      const btnCargar = document.createElement("button");
      btnCargar.type = "button";
      btnCargar.textContent = rt.loading ? "Cargando…" : "Cargar ciudades";
      btnCargar.disabled = rt.loading || rt.atacando;
      btnCargar.style.cssText =
        "padding:7px 14px;background:#3498db;color:#fff;border:0;border-radius:3px;" +
        "cursor:pointer;font-size:11.5px;font-weight:bold;letter-spacing:0.3px;" +
        "flex-shrink:0;" + (rt.loading || rt.atacando ? "opacity:0.5;cursor:wait" : "");
      btnCargar.addEventListener("click", async () => {
        const v = inpIsla.value.replace(/\D/g, "");
        if (!v) { inpIsla.focus(); return; }
        isla.islandId = v;
        setConfigIsla(tid, { islandId: v });
        rt.islandId = v;
        rt.loading = true;
        rt.error = null;
        rt.ciudades = null;
        rt.seleccionadas = new Set();
        rt.resultados = new Map();
        rerenderTab();
        try {
          const ciudades = await obtenerCiudadesDeIsla(v, tid);
          //Filtrar las propias: nuestras ciudades viven en data.ciudadesConAldeas.
          const propias = new Set((data.ciudadesConAldeas || []).map((c) => Number(c.codigoCiudad)));
          rt.ciudades = ciudades.filter((c) => !propias.has(c.id));
          //Default: todas seleccionadas (el usuario destilda las que no quiera).
          rt.seleccionadas = new Set(rt.ciudades.map((c) => c.id));
          if (!rt.ciudades.length) {
            rt.error = "No se encontraron ciudades atacables en esta isla (¿isla vacía o todas son tuyas?)";
          }
        } catch (e) {
          rt.error = `No pude cargar la isla: ${e && e.message ? e.message : e}`;
          core.logError("ataques", "obtenerCiudadesDeIsla falló", e);
        }
        rt.loading = false;
        rerenderTab();
      });
      filaIsla.appendChild(btnCargar);
      wrap.appendChild(filaIsla);

      //Listado de ciudades cargadas (checklist)
      if (rt.error) {
        const errBox = document.createElement("div");
        errBox.textContent = rt.error;
        errBox.style.cssText =
          "color:#e74c3c;font-size:11px;padding:8px 10px;background:#1a0e0e;" +
          "border:1px solid #5a2424;border-radius:3px;margin-bottom:10px";
        wrap.appendChild(errBox);
      } else if (rt.loading) {
        const loadBox = document.createElement("div");
        loadBox.textContent = "Cargando ciudades de la isla…";
        loadBox.style.cssText =
          "color:#7a8aa0;font-size:11px;font-style:italic;padding:8px 10px;text-align:center";
        wrap.appendChild(loadBox);
      } else if (rt.ciudades == null) {
        const emptyBox = document.createElement("div");
        emptyBox.innerHTML =
          `<span style="color:#7a8aa0">↑ Ingresá un ID de isla y apretá "Cargar ciudades" para empezar.</span>`;
        emptyBox.style.cssText =
          "font-size:11px;padding:14px 10px;text-align:center;background:#172029;" +
          "border:1px dashed #2c3a4d;border-radius:3px;margin-bottom:10px";
        wrap.appendChild(emptyBox);
      } else {
        wrap.appendChild(renderChecklistCiudades(tid, rt));
      }

      //Selector unificado de unidades + cantidades.
      //
      //Antes había dos pasos (chip "seleccionar" + grid "cantidad" gated por
      //selección). El usuario reportó que no veía cómo seleccionar ni dónde
      //escribir la cantidad, así que ahora una sola tabla con TODAS las
      //unidades muestra el input siempre. Selección implícita: count > 0 =
      //unidad incluida. Las que tienen tropas van primero; las ya configuradas
      //(count > 0) también suben, así no se "pierden" si la ciudad se queda
      //sin tropas momentáneamente.
      const cache = data.ataques.unitsCache[tid] || {};
      const numAsignadas = TIPOS_UNIDAD.filter((t) => Number(isla.counts[t.key]) > 0).length;

      const ulbl = document.createElement("div");
      ulbl.style.cssText = "color:#7a8aa0;font-size:10px;text-transform:uppercase;letter-spacing:0.3px;margin:14px 0 4px";
      ulbl.textContent = `Unidades a enviar por ciudad atacada (${numAsignadas} tipo${numAsignadas === 1 ? "" : "s"} asignado${numAsignadas === 1 ? "" : "s"})`;
      wrap.appendChild(ulbl);

      const uhint = document.createElement("div");
      uhint.style.cssText = "color:#7a8aa0;font-size:10.5px;font-style:italic;margin-bottom:6px";
      uhint.textContent = "Escribí cuántas mandar de cada tipo. Dejá vacío o 0 para no incluir esa unidad.";
      wrap.appendChild(uhint);

      //Mostrar SOLO unidades con tropas disponibles o ya configuradas (count>0).
      //Si el cache todavía no cargó (queryUnits async), mostramos todas para no
      //ocultar la UI mientras llega. Orden: con tropas primero, luego las
      //asignadas-sin-stock-momentáneo. Mismo orden interno de TIPOS_UNIDAD.
      const cacheVacio = Object.keys(cache).length === 0;
      const ordenadas = TIPOS_UNIDAD
        .filter((t) =>
          cacheVacio ||
          Number(cache[t.key] || 0) > 0 ||
          Number(isla.counts[t.key] || 0) > 0
        )
        .sort((a, b) => {
          const aTropas = Number(cache[a.key] || 0) > 0 ? 0 : 1;
          const bTropas = Number(cache[b.key] || 0) > 0 ? 0 : 1;
          if (aTropas !== bTropas) return aTropas - bTropas;
          const aAsig = Number(isla.counts[a.key] || 0) > 0 ? 0 : 1;
          const bAsig = Number(isla.counts[b.key] || 0) > 0 ? 0 : 1;
          if (aAsig !== bAsig) return aAsig - bAsig;
          return 0;
        });

      const unitGrid = document.createElement("div");
      unitGrid.style.cssText = "display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px";
      for (const t of ordenadas) {
        const disp = Number(cache[t.key] || 0);
        const cur = Number(isla.counts[t.key] || 0);
        const incluida = cur > 0;
        const tieneTropas = disp > 0;

        const row = document.createElement("label");
        row.style.cssText =
          "display:flex;align-items:center;gap:6px;padding:5px 7px;border-radius:3px;cursor:text;" +
          `background:${incluida ? "#1a2e1f" : "#172029"};` +
          `border:1px solid ${incluida ? "#27ae60" : "#2c3a4d"};` +
          (tieneTropas || incluida ? "" : "opacity:0.55");

        const nameSpan = document.createElement("span");
        nameSpan.style.cssText =
          "flex:1;min-width:0;display:flex;align-items:baseline;gap:5px;" +
          "overflow:hidden;white-space:nowrap";
        nameSpan.innerHTML =
          `<span style="color:${incluida ? "#27ae60" : (tieneTropas ? "#cdd5e0" : "#7a8aa0")};` +
          `font-size:11px;font-weight:${incluida ? "bold" : "normal"};` +
          `overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(t.label)}</span>` +
          (disp > 0
            ? `<span style="color:#7a8aa0;font-family:monospace;font-size:10px">${disp}</span>`
            : `<span style="color:#5a6776;font-size:10px">—</span>`);

        const inp = document.createElement("input");
        inp.type = "text";
        inp.inputMode = "numeric";
        inp.placeholder = "0";
        inp.value = cur > 0 ? String(cur) : "";
        inp.style.cssText =
          "width:64px;padding:4px 7px;background:#0f1620;color:#e6e9ee;" +
          `border:1px solid ${incluida ? "#27ae60" : "#2c3a4d"};` +
          "border-radius:3px;font-size:11.5px;font-family:monospace;text-align:right;outline:none";
        inp.addEventListener("focus", () => { inp.style.borderColor = "#e67e22"; });
        inp.addEventListener("blur", () => {
          const raw = inp.value.replace(/\D/g, "");
          inp.value = raw;
          const n = raw ? Math.floor(Number(raw)) : 0;
          //Construimos counts y unitTypes nuevos a partir del estado actual
          //persistido (no del local fallback) para evitar pisar cambios y
          //para crear la entry en configPorCiudad si todavía no existe.
          const prev = data.ataques.configPorCiudad[tid] || {};
          const prevIsla = (prev.isla && typeof prev.isla === "object")
            ? prev.isla
            : { islandId: isla.islandId || "", unitTypes: [], counts: {} };
          const nuevosCounts = { ...(prevIsla.counts || {}) };
          const nuevosTypes = Array.isArray(prevIsla.unitTypes) ? prevIsla.unitTypes.slice() : [];
          if (n > 0) {
            nuevosCounts[t.key] = n;
            if (!nuevosTypes.includes(t.key)) nuevosTypes.push(t.key);
          } else {
            delete nuevosCounts[t.key];
            const idx = nuevosTypes.indexOf(t.key);
            if (idx >= 0) nuevosTypes.splice(idx, 1);
          }
          setConfigIsla(tid, { counts: nuevosCounts, unitTypes: nuevosTypes });
          rerenderTab();
        });

        row.appendChild(nameSpan);
        row.appendChild(inp);
        unitGrid.appendChild(row);
      }
      wrap.appendChild(unitGrid);

      //Botón "Atacar"
      //La selección es implícita: una unidad está incluida si su count > 0.
      //Recalculamos desde counts (no desde unitTypes) para tolerar arrays
      //desincronizados de versiones viejas.
      const unitTypesActivas = TIPOS_UNIDAD
        .map((t) => t.key)
        .filter((k) => Number(isla.counts[k]) > 0);
      const seleccionadas = rt.ciudades ? rt.seleccionadas.size : 0;
      const tieneUnidadesValidas = unitTypesActivas.length > 0;
      const habilitado = seleccionadas > 0 && tieneUnidadesValidas && !rt.atacando && !rt.loading;

      const btnAtacar = document.createElement("button");
      btnAtacar.type = "button";
      btnAtacar.textContent = rt.atacando
        ? (rt.progreso ? `Atacando ${rt.progreso.actual}/${rt.progreso.total}…` : "Atacando…")
        : `⚔  Atacar ${seleccionadas} ciudad(es)`;
      btnAtacar.disabled = !habilitado;
      btnAtacar.style.cssText =
        "width:100%;margin-top:14px;padding:10px;border:0;border-radius:4px;cursor:pointer;" +
        "font-size:12.5px;font-weight:bold;letter-spacing:0.5px;text-transform:uppercase;" +
        (habilitado
          ? "background:#e67e22;color:#fff"
          : "background:#2c3a4d;color:#5a6776;cursor:not-allowed");
      btnAtacar.addEventListener("click", () => {
        if (!habilitado) return;
        const cantStr = unitTypesActivas
          .map((ut) => `${isla.counts[ut]} ${labelUnidad(ut)}`)
          .join(" + ");
        const totalUnidades = unitTypesActivas.reduce((s, ut) => s + Number(isla.counts[ut] || 0), 0);
        const grandTotal = totalUnidades * seleccionadas;
        const ok = confirm(
          `Atacar ${seleccionadas} ciudad(es) desde ${nombreCiudad(tid)}.\n\n` +
          `Por ciudad: ${cantStr}\n` +
          `Total a enviar: ${grandTotal} unidades en ${seleccionadas} olas.\n\n` +
          `Esto NO se puede deshacer. ¿Confirmar?`
        );
        if (!ok) return;
        ejecutarAtaqueIsla(tid).catch((e) => core.logError("ataques", "ataque isla falló", e));
      });
      wrap.appendChild(btnAtacar);

      //Resumen del último ataque — visible bajo el botón para que el usuario
      //vea el resultado sin tener que scrollear hasta el checklist. Lista cada
      //ciudad con su status (✓ verde / ✗ rojo + mensaje del server).
      if (rt.resultados && rt.resultados.size > 0 && !rt.atacando) {
        const okCount = Array.from(rt.resultados.values()).filter((r) => r.ok).length;
        const failCount = rt.resultados.size - okCount;
        const hayFallos = failCount > 0;

        const resumenBox = document.createElement("div");
        resumenBox.style.cssText =
          "margin-top:10px;padding:8px 10px;border-radius:3px;" +
          (hayFallos
            ? "background:#1a0e0e;border:1px solid #5a2424"
            : "background:#0f1a13;border:1px solid #1f5a2b");

        const head = document.createElement("div");
        head.style.cssText =
          `color:${hayFallos ? "#e74c3c" : "#27ae60"};font-size:11px;` +
          "font-weight:bold;margin-bottom:6px";
        head.textContent = `Último ataque · ✓ ${okCount} OK · ✗ ${failCount} fallaron`;
        resumenBox.appendChild(head);

        const lista = document.createElement("div");
        lista.style.cssText =
          "display:flex;flex-direction:column;gap:2px;max-height:240px;overflow-y:auto;" +
          "font-size:10.5px;font-family:monospace";
        //Recorremos rt.ciudades para que el orden coincida con el checklist.
        for (const c of rt.ciudades || []) {
          const res = rt.resultados.get(c.id);
          if (!res) continue;
          const fila = document.createElement("div");
          fila.style.cssText =
            "padding:2px 4px;white-space:normal;word-break:break-word;" +
            (res.ok ? "color:#27ae60" : "color:#e74c3c");
          if (res.ok) {
            fila.textContent = `✓ ${c.name} (#${c.id})`;
          } else {
            fila.textContent = `✗ ${c.name} (#${c.id}): ${res.error}`;
            fila.title = res.error || "";
          }
          lista.appendChild(fila);
        }
        resumenBox.appendChild(lista);
        wrap.appendChild(resumenBox);
      }

      //Hint si falta config
      if (!habilitado && !rt.atacando) {
        const hint = document.createElement("div");
        hint.style.cssText = "color:#7a8aa0;font-size:10.5px;font-style:italic;text-align:center;margin-top:6px";
        if (rt.ciudades == null) hint.textContent = "Cargá una isla primero.";
        else if (seleccionadas === 0) hint.textContent = "Marcá al menos una ciudad para atacar.";
        else if (!tieneUnidadesValidas) hint.textContent = "Configurá al menos una unidad con cantidad > 0.";
        wrap.appendChild(hint);
      }

      return wrap;
    }

    function renderChecklistCiudades(tid, rt) {
      const cont = document.createElement("div");
      cont.style.cssText =
        "background:#172029;border:1px solid #2c3a4d;border-radius:3px;overflow:hidden";

      //Header con contador + acciones masivas
      const head = document.createElement("div");
      head.style.cssText =
        "display:flex;align-items:center;gap:8px;padding:7px 10px;" +
        "background:#1a232e;border-bottom:1px solid #2c3a4d";
      const cnt = document.createElement("span");
      cnt.style.cssText = "flex:1;color:#cdd5e0;font-size:11px;font-weight:bold";
      cnt.textContent = `${rt.seleccionadas.size} / ${rt.ciudades.length} ciudades seleccionadas`;
      head.appendChild(cnt);

      const btnTodas = document.createElement("button");
      btnTodas.type = "button";
      btnTodas.textContent = "Todas";
      btnTodas.style.cssText =
        "background:#2c3a4d;color:#cdd5e0;border:0;padding:3px 9px;border-radius:3px;" +
        "cursor:pointer;font-size:10.5px;font-weight:bold";
      btnTodas.addEventListener("click", () => {
        rt.seleccionadas = new Set(rt.ciudades.map((c) => c.id));
        rerenderTab();
      });
      head.appendChild(btnTodas);

      const btnNinguna = document.createElement("button");
      btnNinguna.type = "button";
      btnNinguna.textContent = "Ninguna";
      btnNinguna.style.cssText =
        "background:#2c3a4d;color:#cdd5e0;border:0;padding:3px 9px;border-radius:3px;" +
        "cursor:pointer;font-size:10.5px;font-weight:bold";
      btnNinguna.addEventListener("click", () => {
        rt.seleccionadas = new Set();
        rerenderTab();
      });
      head.appendChild(btnNinguna);

      cont.appendChild(head);

      //Lista sin scroll interno: dejamos que el .pcj-body del panel scrollee.
      //Nested scrolls dentro de un panel ya scrolleable hacen que la rueda
      //"se trabe" entre contenedores en Chrome — el usuario reportó que no
      //podía scrollear acá adentro.
      const lista = document.createElement("div");
      for (const c of rt.ciudades) {
        const checked = rt.seleccionadas.has(c.id);
        const row = document.createElement("label");
        row.style.cssText =
          "display:flex;align-items:center;gap:8px;padding:6px 10px;cursor:pointer;" +
          "border-top:1px solid #2c3a4d;font-size:11.5px;" +
          (checked ? "background:#172029" : "background:#101820;opacity:0.65");
        const chk = document.createElement("input");
        chk.type = "checkbox";
        chk.checked = checked;
        chk.style.cssText = "accent-color:#e67e22;flex-shrink:0;cursor:pointer";
        chk.addEventListener("change", () => {
          if (chk.checked) rt.seleccionadas.add(c.id);
          else rt.seleccionadas.delete(c.id);
          //Re-render solo para actualizar contador y botón (lite reflow).
          rerenderTab();
        });
        row.appendChild(chk);

        const info = document.createElement("div");
        info.style.cssText = "flex:1;min-width:0;display:flex;align-items:baseline;gap:6px";
        info.innerHTML =
          `<span style="color:#e6e9ee;font-weight:bold;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(c.name)}</span>` +
          `<span style="color:#7a8aa0;font-family:monospace;font-size:10px">#${c.id}</span>` +
          (c.points != null ? `<span style="color:#7a8aa0;font-size:10px">${c.points}p</span>` : "") +
          (c.playerName ? `<span style="color:#5a6776;font-size:10.5px;margin-left:auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(c.playerName)}</span>` : "");
        row.appendChild(info);

        lista.appendChild(row);

        //Resultado del último ataque a esta ciudad (si lo hubo). Lo mostramos
        //como fila separada bajo el row para no romper el flex horizontal y
        //que el mensaje completo del server (a veces largo) tenga su línea.
        const res = rt.resultados && rt.resultados.get(c.id);
        if (res) {
          const resRow = document.createElement("div");
          resRow.style.cssText =
            "padding:3px 10px 5px 30px;font-size:10.5px;font-family:monospace;" +
            "border-top:0;white-space:normal;word-break:break-word;" +
            (res.ok
              ? "color:#27ae60;background:#0f1a13"
              : "color:#e74c3c;background:#1a0e0e");
          resRow.textContent = res.ok ? "✓ enviado" : `✗ ${res.error}`;
          if (res.error) resRow.title = res.error;
          lista.appendChild(resRow);
        }
      }
      cont.appendChild(lista);
      return cont;
    }

    //Loop one-shot que dispara enviarAtaque para cada ciudad seleccionada.
    //Respeta CAPTCHA (aborta) y agrega jitter entre cada disparo (1.5-3.5s)
    //para no levantar sospecha. El estado de progreso se refleja en rt.atacando
    //+ rt.progreso para que el panel muestre "Atacando X/N…".
    async function ejecutarAtaqueIsla(tid) {
      const rt = getIslaRuntime(tid);
      const cfg = data.ataques.configPorCiudad[tid];
      if (!cfg || !cfg.isla) return;
      const objetivos = rt.ciudades.filter((c) => rt.seleccionadas.has(c.id));
      if (!objetivos.length) return;

      //Fuente de verdad: counts. Iteramos sus keys (en lugar de unitTypes)
      //para tolerar drift entre los dos arreglos en configs viejas.
      const counts = {};
      const islaCounts = cfg.isla.counts || {};
      for (const ut of Object.keys(islaCounts)) {
        const n = Number(islaCounts[ut] || 0);
        if (n > 0) counts[ut] = n;
      }
      if (!Object.keys(counts).length) return;

      rt.atacando = true;
      rt.progreso = { actual: 0, total: objetivos.length, ok: 0, fail: 0 };
      rt.resultados = new Map();
      rerenderTab();

      core.log("ataques", `🏝️ ataque a isla ${cfg.isla.islandId} — ${objetivos.length} ciudades · ${formatCountsCorto(counts)} por ciudad`, "info");

      for (const obj of objetivos) {
        if (core.isCaptchaActive()) {
          core.logWarn("ataques", `ataque a isla abortado en ${rt.progreso.actual}/${rt.progreso.total} por CAPTCHA`);
          break;
        }
        const r = await enviarAtaque(tid, obj.id, counts);
        rt.progreso.actual += 1;
        rt.resultados.set(obj.id, { ok: !!r.ok, error: r.ok ? null : (r.error || "fallo") });
        if (r.ok) {
          rt.progreso.ok += 1;
          registrarHistorial({
            ts: Date.now(),
            town_id: tid,
            target_town_id: obj.id,
            modo: "isla",
            counts,
            total: Object.values(counts).reduce((s, n) => s + n, 0),
            oneWaySeg: r.arrivalAt - r.startedAt,
          });
          core.log("ataques", `  ✓ → ${obj.name} (#${obj.id})`, "ok");
        } else {
          rt.progreso.fail += 1;
          core.logWarn("ataques", `  ✗ → ${obj.name} (#${obj.id}): ${r.error || "fallo"}`);
          //Si server dijo "sin tropas", no sigue — sigan los demás ataques no
          //tendrían tropas tampoco.
          if (r.noTropas) {
            core.logWarn("ataques", "ataque a isla: sin tropas, aborto restantes");
            break;
          }
        }
        rerenderTab();
        //Jitter entre ataques: suficiente para parecer humano pero rápido
        //para terminar la ola.
        await new Promise((res) => setTimeout(res, jitter(1500, 3500)));
      }

      core.log(
        "ataques",
        `🏝️ ataque a isla terminado · OK ${rt.progreso.ok} · falló ${rt.progreso.fail}`,
        rt.progreso.fail ? "warn" : "ok"
      );
      rt.atacando = false;
      rerenderTab();
    }

    //Esqueleto común de cada sección de modo: contenedor con borde + header
    //(label + toggle) + descripción. Los hijos específicos del modo se
    //agregan luego con appendChild.
    function crearSeccionModo({ tituloLabel, toggleColor, toggleColorON, toggleEstado, toggleOnChange, descripcion }) {
      const sec = document.createElement("div");
      sec.style.cssText =
        "padding:10px 12px;background:#0f1620;border:1px solid #2c3a4d;border-radius:4px";

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
      } else if (modoON && !core.isCaptchaActive()) {
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
    //Mostramos solo las unidades con tropas disponibles o ya seleccionadas
    //(para no perder la selección si la ciudad queda sin stock momentáneo).
    //Si el cache no cargó aún, mostramos todas para no esconder la UI.
    function renderUnitChips(townId, selectedKeys, onToggle) {
      const wrap = document.createElement("div");
      wrap.style.cssText = "display:flex;flex-wrap:wrap;gap:4px";

      const cache = data.ataques.unitsCache[townId] || {};
      const selSet = new Set(selectedKeys || []);
      const cacheVacio = Object.keys(cache).length === 0;

      const ordenados = TIPOS_UNIDAD
        .filter((t) => cacheVacio || Number(cache[t.key] || 0) > 0 || selSet.has(t.key))
        .sort((a, b) => {
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
