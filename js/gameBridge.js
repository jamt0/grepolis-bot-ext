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
   * Despacha las notifications de un response a los modelos Backbone Y al
   * dispatcher nativo del juego cuando aplica.
   *
   * Tipos típicos en Grepolis:
   *   - "backbone"   → update de un modelo Backbone. Hacemos model.set().
   *   - "new"        → cosas nuevas (mensajes, reportes, ataques entrantes
   *                    detectados). El juego usa esto para encender el
   *                    badge en los iconos del topbar + sonido + banner.
   *   - "raw"        → mensajes HTML de bandeja
   *   - "delete"     → notificación marcada como leída
   *   - "instant_command" → comandos a aplicar (revolts, etc.)
   *
   * Si NO reenviamos las no-backbone, el juego no recibe el aviso —
   * desaparece el sonido y el badge de "tenés un ataque entrante" porque
   * el server las marcó como entregadas a NUESTRA request (el cliente
   * normal del juego no las recibe en su /game/notify).
   *
   * Estrategia:
   *   1. Para "backbone": model.set() como antes (lo hacemos nosotros).
   *   2. Para todo el resto: intentamos llamar al dispatcher nativo del
   *      juego si lo encontramos. Probamos rutas comunes — el primero que
   *      exista gana, el resto se loguea una vez para diagnóstico.
   */
  //Identificado en sesión real (probe de DevTools): el dispatcher nativo
  //de Grepolis es `MM.handleNotification(notif)` — toma UNA notif y la
  //rutea internamente según su `type` (backbone → update de modelo, new →
  //banner/sonido/badge, raw → mensaje en bandeja, delete → marcar leído).
  //
  //Llamándolo replicamos exactamente lo que el juego hace cuando una
  //response de AJAX vuelve con `notifications[]` — incluida la
  //actualización de modelos Backbone Y los efectos secundarios (sonido del
  //ataque entrante, badge del topbar, refresh del bandeja de mensajes,
  //etc.). Sin esto el server nos las entrega y se las pierde el juego.
  let avisoSinHandler = false;
  function dispatchNotifications(notifications) {
    if (!Array.isArray(notifications) || !notifications.length) return;
    if (!window.MM) return;

    if (typeof window.MM.handleNotification === "function") {
      for (const notif of notifications) {
        if (!notif) continue;
        try {
          window.MM.handleNotification(notif);
        } catch (e) {
          console.warn("[JamBot bridge] MM.handleNotification tiró:", e, notif);
        }
      }
      return;
    }

    //Fallback histórico: si MM.handleNotification no existe (versión vieja
    //de Grepolis o changeset), seguimos haciendo model.set manual para
    //al menos las notifs `type:"backbone"`. Las otras se pierden — log una
    //sola vez para diagnóstico.
    if (!avisoSinHandler) {
      avisoSinHandler = true;
      console.warn(
        "[JamBot bridge] MM.handleNotification no existe — fallback al " +
        "dispatcher manual de backbone. Avisos de ataque/mensaje pueden " +
        "perderse."
      );
    }
    if (typeof window.MM.getModels !== "function") return;
    const allModels = window.MM.getModels();
    for (const notif of notifications) {
      if (!notif || notif.type !== "backbone") continue;
      if (!notif.subject || notif.param_id == null) continue;
      let payload;
      try { payload = JSON.parse(notif.param_str); } catch (_) { continue; }
      const subjectData = payload && payload[notif.subject];
      if (!subjectData) continue;
      const subjectModels = allModels[notif.subject];
      if (!subjectModels) continue;
      const model = subjectModels[notif.param_id];
      if (model && typeof model.set === "function") model.set(subjectData);
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
   * cada ciclo (recolección) y para que la feature `comercio` calcule
   * cuánto puede enviar desde un origen y cuánto puede recibir un destino.
   *
   * Devuelve además:
   *   - storage: cap del almacén por recurso (mismo número los 3).
   *   - maxTradeCapacity: tope del mercado del origen (available_traders ×
   *     load_per_trader cuando todos los comerciantes están en casa).
   *   - availableTradeCapacity: capacidad libre AHORA del mercado del origen.
   *   - islandId: id de la isla del Town — comercio lo usa para detectar
   *     envíos inter-isla (que requieren mercado ≥ 5).
   *   - marketLevel: nivel actual del mercado de la ciudad, o null si no
   *     pudimos detectarlo. El modelo Town suele exponer los niveles de
   *     buildings via método (`getBuildingLevel`) o como dict en attributes
   *     (`buildings.market` / `building_market`); probamos varios shapes
   *     defensivamente porque la API interna del cliente puede cambiar
   *     entre versiones del juego. Si todo falla, queda `null` y el caller
   *     decide qué hacer (típicamente no pre-filtrar y dejar que el server
   *     rechace si corresponde).
   *
   * Si el modelo Town no está cargado en MM (la ciudad nunca fue abierta en
   * la sesión y no llegó por notification), los campos vienen como null —
   * el content script decide qué hacer (refetch al server, saltar el ciclo).
   */
  window.addEventListener("JamBot:queryTownResources", function (e) {
    const townId = e && e.detail && e.detail.townId;
    let resources = null;
    let storage = null;
    let maxTradeCapacity = null;
    let availableTradeCapacity = null;
    let islandId = null;
    let marketLevel = null;
    if (window.MM && typeof window.MM.getModels === "function") {
      const towns = window.MM.getModels().Town;
      const town = towns && (towns[townId] || towns[String(townId)]);
      const a = town && town.attributes;
      if (a) {
        const r = a.resources;
        if (r) resources = { wood: r.wood, stone: r.stone, iron: r.iron };
        if (typeof a.storage === "number") storage = a.storage;
        if (typeof a.max_trade_capacity === "number") maxTradeCapacity = a.max_trade_capacity;
        if (typeof a.available_trade_capacity === "number") availableTradeCapacity = a.available_trade_capacity;
        if (a.island_id != null) islandId = Number(a.island_id);
        //marketLevel: probamos en orden los shapes que vimos / suelen usarse.
        try {
          if (town && typeof town.getBuildingLevel === "function") {
            const lvl = town.getBuildingLevel("market");
            if (typeof lvl === "number") marketLevel = lvl;
          }
          if (marketLevel == null && a.buildings && typeof a.buildings.market === "number") {
            marketLevel = a.buildings.market;
          }
          if (marketLevel == null && typeof a.building_market === "number") {
            marketLevel = a.building_market;
          }
        } catch (_) { /* defensivo — si el método tira, seguimos con null */ }
      }
    }
    window.postMessage(
      {
        type: "JamBot:townResources",
        townId, resources, storage,
        maxTradeCapacity, availableTradeCapacity,
        islandId, marketLevel,
      },
      "*"
    );
  });

  /**
   * Lookup de nombre + dueño de una ciudad arbitraria via MM. Cubre cualquier
   * Town cargada en MM — propia, aliada, enemiga: lo que importa es que
   * exista una entrada en `MM.getModels().Town[id]`. Se popula sola cuando
   * el cliente recibe `notifications` con un Town nuevo (clicks en el mapa,
   * island_info, town_info, etc.) o cuando lo forzamos con un refetch.
   *
   * Si la Town no está cargada todavía, devolvemos {name:null}. El content
   * script en ese caso dispara un fetch HTTP, deja que el bridge inyecte
   * las notifs en MM, y vuelve a pedir.
   */
  window.addEventListener("JamBot:queryTownName", function (e) {
    const townId = e && e.detail && e.detail.townId;
    let name = null;
    let playerName = null;
    let playerId = null;
    let islandId = null;
    try {
      if (window.MM && typeof window.MM.getModels === "function") {
        const towns = window.MM.getModels().Town;
        const town = towns && (towns[townId] || towns[String(townId)]);
        const a = town && town.attributes;
        if (a) {
          name = a.name || null;
          playerId = a.player_id != null ? Number(a.player_id) : null;
          islandId = a.island_id != null ? Number(a.island_id) : null;
          //El Town a veces trae player_name embebido; si no, lo resolvemos
          //via el modelo Player paralelo.
          if (a.player_name) playerName = a.player_name;
          if (!playerName && playerId != null) {
            const players = window.MM.getModels().Player;
            const p = players && (players[playerId] || players[String(playerId)]);
            if (p && p.attributes && p.attributes.name) playerName = p.attributes.name;
          }
        }
      }
    } catch (_) { /* defensivo */ }
    window.postMessage(
      { type: "JamBot:townNameResult", townId, name, playerName, playerId, islandId },
      "*"
    );
  });

  /**
   * Búsqueda por substring en los nombres de Towns cargados en MM. Devuelve
   * hasta `limit` matches. Solo cubre lo que MM ya conoce — no llega al
   * server. Útil como ayuda al usuario cuando recuerda el nombre pero no
   * el ID (la lista crece a medida que abre ciudades en el mapa, recibe
   * ataques, etc.).
   */
  window.addEventListener("JamBot:searchTowns", function (e) {
    const raw = (e && e.detail && e.detail.query) || "";
    const q = String(raw).toLowerCase().trim();
    const limit = (e && e.detail && Number(e.detail.limit)) || 8;
    const out = [];
    try {
      if (q && window.MM && typeof window.MM.getModels === "function") {
        const towns = window.MM.getModels().Town || {};
        const players = window.MM.getModels().Player || {};
        for (const id of Object.keys(towns)) {
          const a = towns[id] && towns[id].attributes;
          if (!a || !a.name) continue;
          if (a.name.toLowerCase().indexOf(q) === -1) continue;
          const pid = a.player_id;
          let playerName = a.player_name || null;
          if (!playerName && pid != null) {
            const p = players[pid] || players[String(pid)];
            if (p && p.attributes && p.attributes.name) playerName = p.attributes.name;
          }
          out.push({
            id: Number(a.id || id),
            name: a.name,
            playerName,
            playerId: pid != null ? Number(pid) : null,
          });
          if (out.length >= limit) break;
        }
      }
    } catch (_) { /* defensivo */ }
    window.postMessage({ type: "JamBot:searchTownsResult", query: q, towns: out }, "*");
  });

  /**
   * Devuelve la lista de comercios (modelo `Trade`) cargados en MM, filtrados
   * por jugador. Útil para que la feature `comercio` muestre los envíos en
   * vuelo y calcule cuándo vuelven los comerciantes. El response del POST
   * /game/town_info?action=trade ya viene con una notification `Trade` que
   * el bridge inyecta a MM via dispatchNotifications, así que la colección
   * está siempre fresca después de un envío del bot.
   */
  window.addEventListener("JamBot:queryTrades", function (e) {
    const playerId = e && e.detail && e.detail.playerId;
    const trades = [];
    if (window.MM && typeof window.MM.getModels === "function") {
      const all = window.MM.getModels().Trade || {};
      for (const id of Object.keys(all)) {
        const t = all[id];
        const a = t && t.attributes;
        if (!a) continue;
        if (playerId != null && a.origin_town_player_id != null &&
            String(a.origin_town_player_id) !== String(playerId)) continue;
        trades.push({
          id: a.id,
          originTownId: a.origin_town_id,
          originTownName: a.origin_town_name,
          destinationTownId: a.destination_town_id,
          wood: a.wood || 0,
          stone: a.stone || 0,
          iron: a.iron || 0,
          startedAt: a.started_at,
          arrivalAt: a.arrival_at,
          cancelable: !!a.cancelable,
        });
      }
    }
    window.postMessage({ type: "JamBot:tradesResult", trades }, "*");
  });

  /**
   * Permite al content script preguntar las unidades que pertenecen y están
   * en una ciudad — es decir, el modelo Units con
   * `home_town_id == current_town_id == townId`. Eso filtra: tropas en otra
   * ciudad como apoyo (current_town_id != home), tropas en movimiento
   * (current_town_id null), y tropas extranjeras estacionadas (home != town).
   *
   * Devuelve el atributo crudo (sword, slinger, archer, …) o null si el
   * modelo no está cargado en MM (la ciudad no fue abierta en la sesión).
   * El feature ataques usa esto para saber cuántas unidades del tipo
   * elegido están disponibles antes de cada ataque.
   */
  window.addEventListener("JamBot:queryUnits", function (e) {
    const townId = e && e.detail && e.detail.townId;
    let units = null;
    if (window.MM && typeof window.MM.getModels === "function") {
      const all = window.MM.getModels().Units;
      if (all) {
        for (const id of Object.keys(all)) {
          const u = all[id];
          const a = u && u.attributes;
          if (!a) continue;
          if (a.home_town_id == townId && a.current_town_id == townId) {
            units = Object.assign({}, a);
            break;
          }
        }
      }
    }
    window.postMessage({ type: "JamBot:unitsResult", townId, units }, "*");
  });

  /**
   * Devuelve el estado actual de PlayerGods: favor por dios + qué dioses tienen
   * templo. Lo leemos del modelo Backbone que el cliente ya tiene cargado —
   * cualquier cast (incluso uno fallido) actualiza este modelo via notification.
   *
   * Shape (lo que devolvemos):
   *   { favor: {zeus:0, poseidon:500, ...}, temples: {zeus:false, ...}, maxFavor:500 }
   * Si MM no está listo o no hay PlayerGods, devuelve {favor:{}, temples:{}, maxFavor:null}.
   */
  window.addEventListener("JamBot:queryPlayerGods", function () {
    const out = { favor: {}, temples: {}, maxFavor: null };
    try {
      if (window.MM && typeof window.MM.getModels === "function") {
        const pgs = window.MM.getModels().PlayerGods || {};
        for (const id of Object.keys(pgs)) {
          const a = pgs[id] && pgs[id].attributes;
          if (!a) continue;
          if (a.production_overview) {
            for (const god of Object.keys(a.production_overview)) {
              const cur = a.production_overview[god] && a.production_overview[god].current;
              out.favor[god] = typeof cur === "number" ? cur : 0;
            }
          }
          if (a.temples_for_gods) {
            for (const god of Object.keys(a.temples_for_gods)) {
              out.temples[god] = !!a.temples_for_gods[god];
            }
          }
          if (typeof a.max_favor === "number") out.maxFavor = a.max_favor;
          break; //un solo PlayerGods por jugador
        }
      }
    } catch (_) { /* defensivo */ }
    window.postMessage({ type: "JamBot:playerGodsResult", data: out }, "*");
  });

  /**
   * Devuelve { [townId]: god } para todas las ciudades del jugador cargadas en MM.
   * `god` es el string del dios que adora esa ciudad (zeus, poseidon, hera, athena,
   * hades, artemis, aphrodite, ares) o null si todavía no eligió uno.
   *
   * Pequeño truco: en Grepolis el atributo `god` en Town puede aparecer como
   * `god` o como `current_god` según versión — probamos ambos para defensa.
   */
  window.addEventListener("JamBot:queryTownsGods", function () {
    const out = {};
    try {
      if (window.MM && typeof window.MM.getModels === "function") {
        const towns = window.MM.getModels().Town || {};
        for (const id of Object.keys(towns)) {
          const a = towns[id] && towns[id].attributes;
          if (!a) continue;
          const g = a.god || a.current_god || null;
          out[a.id || id] = g;
        }
      }
    } catch (_) { /* defensivo */ }
    window.postMessage({ type: "JamBot:townsGodsResult", data: out }, "*");
  });

  /**
   * Descubre el catálogo de poderes divinos del cliente del juego. Grepolis
   * guarda esto en `GameData.powers` (clave-valor por power_id), donde cada
   * entrada trae:
   *   { name, god, favor (costo), is_ranged ("town"/"command"/...) }
   *
   * Probamos rutas conocidas en orden. Devolvemos un array uniforme:
   *   [{ id, name, god, favor, target }]
   * `target` se normaliza a "town" o "command" según `range_type`/`type`.
   * Si no encontramos catálogo, devolvemos [].
   */
  window.addEventListener("JamBot:queryPowersCatalog", function () {
    let raw = null;
    try {
      if (window.GameData && window.GameData.powers) raw = window.GameData.powers;
      else if (window.Game && window.Game.powers) raw = window.Game.powers;
    } catch (_) { /* defensivo */ }

    //Algunos campos del catálogo vienen como objetos i18n del tipo
    //  {en:"...", es:"...", de:"..."}  o  {default:"...", value:"..."}.
    //Reducimos a string para que el content script pueda hacer .localeCompare
    //y mostrar el nombre tal cual. Preferimos el idioma del cliente (es),
    //luego en, luego cualquier valor del objeto. Si ya es string, lo
    //devolvemos como está.
    function toI18nString(v) {
      if (v == null) return null;
      if (typeof v === "string") return v;
      if (typeof v === "object") {
        if (typeof v.es === "string") return v.es;
        if (typeof v.en === "string") return v.en;
        if (typeof v.default === "string") return v.default;
        if (typeof v.value === "string") return v.value;
        for (const k of Object.keys(v)) {
          if (typeof v[k] === "string") return v[k];
        }
        return null;
      }
      return String(v);
    }

    const list = [];
    if (raw && typeof raw === "object") {
      for (const id of Object.keys(raw)) {
        const p = raw[id] || {};
        //Normalizar target. El cliente usa varias claves históricamente:
        //  range_type / type / target_type / cast_on
        //Valores comunes que vimos: "command", "town", "movement", "self".
        let target = toI18nString(p.target || p.target_type || p.cast_on || p.range_type || p.type) || null;
        if (target === "movement") target = "command";
        if (target === "self") target = "town";
        list.push({
          id,
          name: toI18nString(p.name) || toI18nString(p.title) || toI18nString(p.label) || id,
          god: toI18nString(p.god) || null,
          favor: typeof p.favor === "number" ? p.favor : (typeof p.cost === "number" ? p.cost : null),
          target: target || null,
        });
      }
    }
    window.postMessage({ type: "JamBot:powersCatalogResult", data: list }, "*");
  });

  /**
   * Devuelve los movimientos del modelo `MovementsUnits` + los flags del
   * modelo `Attack` desde MM. Reemplaza al endpoint HTTP `command_overview`
   * que está gated detrás de Administrador premium (sin Admin el server
   * responde {error:"Necesitas al administrador..."}).
   *
   * `MovementsUnits` tiene el detalle (command_id, arrival_at, type,
   * player_id, home_town_id, target_town_id, nombres de origen/destino)
   * pero parece poblarse solo para la ciudad activa del cliente. `Attack`
   * es global y trae {id, town_id, incoming} — sirve para flaggear que una
   * ciudad NO-activa tiene ataque entrante aunque no tengamos su command_id.
   *
   * El content script combina ambos: usa MovementsUnits cuando puede y cae
   * a Attack model cuando solo necesita saber "hay entrante en X".
   */
  window.addEventListener("JamBot:queryMovements", function () {
    const out = { movements: [], attacks: [], activeTown: null, myPlayerId: null };
    try {
      if (window.Game) {
        if (window.Game.townId != null) out.activeTown = Number(window.Game.townId);
        if (window.Game.player_id != null) out.myPlayerId = Number(window.Game.player_id);
      }
      if (window.MM && typeof window.MM.getModels === "function") {
        const mods = window.MM.getModels();
        const mu = mods.MovementsUnits || {};
        for (const k of Object.keys(mu)) {
          const a = mu[k] && mu[k].attributes;
          if (!a) continue;
          out.movements.push({
            id: a.id,
            command_id: a.command_id,
            type: a.type,
            command_name: a.command_name,
            player_id: a.player_id,
            home_town_id: a.home_town_id,
            target_town_id: a.target_town_id,
            town_name_origin: a.town_name_origin,
            town_name_destination: a.town_name_destination,
            link_origin: a.link_origin,
            link_destination: a.link_destination,
            started_at: a.started_at,
            arrival_at: a.arrival_at,
            cancelable_until: a.cancelable_until,
          });
        }
        const att = mods.Attack || {};
        for (const k of Object.keys(att)) {
          const a = att[k] && att[k].attributes;
          if (!a) continue;
          out.attacks.push({ id: a.id, town_id: a.town_id, incoming: a.incoming });
        }
      }
    } catch (_) { /* defensivo */ }
    window.postMessage({ type: "JamBot:movementsResult", data: out }, "*");
  });

  /**
   * Devuelve el id de la ciudad actualmente activa en el cliente del juego.
   * Es la ciudad que se ve en el header superior con el nombre + flechitas.
   * El bot la usa para decidir si necesita "abrir" otra ciudad antes de
   * castear (sin Administrator, el server exige que `town_id` del cast
   * coincida con la ciudad activa).
   */
  window.addEventListener("JamBot:queryActiveTown", function () {
    let townId = null;
    try {
      if (window.Game && window.Game.townId != null) townId = Number(window.Game.townId);
      else if (window.Game && window.Game.town_id != null) townId = Number(window.Game.town_id);
    } catch (_) { /* defensivo */ }
    window.postMessage({ type: "JamBot:activeTownResult", townId }, "*");
  });

  /**
   * Cambia la ciudad actualmente activa del cliente del juego. Replica el
   * efecto de tocar las flechitas del town-switcher superior. Probamos varias
   * rutas conocidas del cliente — distintas versiones de Grepolis usan
   * helpers diferentes; la primera que exista gana. Esto es síncrono del
   * lado del bot (devolvemos resultado por postMessage), pero la red del
   * cliente puede tardar 100-300ms en actualizar los modelos — el caller
   * debería esperar un poco antes del siguiente request al server.
   */
  window.addEventListener("JamBot:changeTown", function (e) {
    const townId = e && e.detail && e.detail.townId;
    let ok = false;
    let metodo = null;
    if (townId != null) {
      const id = Number(townId);
      try {
        //Helper más común en Grepolis moderno.
        if (window.HelperTown && typeof window.HelperTown.switchTown === "function") {
          window.HelperTown.switchTown(id);
          ok = true; metodo = "HelperTown.switchTown";
        }
        //Fallback 1: método directo en Game (versiones más viejas).
        else if (window.Game && typeof window.Game.switchTown === "function") {
          window.Game.switchTown(id);
          ok = true; metodo = "Game.switchTown";
        }
        //Fallback 2: PlayerTowns collection en MM (Backbone) — disparamos
        //un click sintético en el town-switcher si los modelos están vivos.
        else if (window.MM && typeof window.MM.getModels === "function") {
          const towns = window.MM.getModels().Town || {};
          const town = towns[id] || towns[String(id)];
          if (town && typeof town.open === "function") {
            town.open();
            ok = true; metodo = "Town.open";
          }
        }
      } catch (err) {
        console.warn("[JamBot bridge] changeTown lanzó:", err);
      }
    }
    window.postMessage({ type: "JamBot:changeTownResult", townId, ok, metodo }, "*");
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
