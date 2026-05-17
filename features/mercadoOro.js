/* features/mercadoOro.js — alarma + tab "Oro" en el panel principal.
 *
 * Pollea `PremiumExchange:read` cada 60s en una ciudad representante por mar
 * y dispara alarma persistente cuando `capacity - stock ≥ UMBRAL` en
 * wood/stone/iron de algún mar. El usuario silencia la alarma con un botón
 * que aparece junto a Jam▶ solo durante la alarma.
 *
 * Estrategia "1 ciudad por mar":
 *   - Primera ronda: 1 request por ciudad para mapear `sea_id → townId`. El
 *     mapa se persiste en chrome.storage.local namespaceado por mundo.
 *   - Régimen estable: poll solo a representantes.
 *   - Re-descubrimiento cada 30 min.
 *
 * Persistencia (toda namespaceada por world_id):
 *   - mapa sea_id → townId representante
 *   - últimas POLLS_MAX entradas (12h a 1/min) con diff por recurso/mar
 *   - últimas ALERTAS_MAX (100) alertas disparadas
 *
 * UI: NO tiene botón propio para abrir panel — está integrada como tab "Oro"
 * del panel #panelConfigJam, que recoleccion.js delega vía
 * JamBot.features.mercadoOro.api.renderTab(body). El único botón propio es
 * "🔔 Revisé oro" en jambot-buttons, que aparece solo cuando hay alarma.
 *
 * Independiente del play/pause del bot — el monitor sigue corriendo aunque el
 * bot esté pausado. SÍ respeta CAPTCHA.
 */
(function () {
  const JamBot = (window.JamBot = window.JamBot || {});
  JamBot.features = JamBot.features || {};

  const POLL_INTERVAL_MS = 3 * 1000;
  const REDESCUBRIR_INTERVAL_MS = 30 * 60 * 1000;
  const UMBRAL = 100;
  const BEEP_INTERVAL_MS = 700;
  const RECURSOS = ["wood", "stone", "iron"];
  const ALERTAS_MAX = 100;

  const COLOR_RECURSO = { wood: "#c39a55", stone: "#bdc3c7", iron: "#95a5a6" };
  //Variantes oscuras de los colores de recurso, para usar sobre fondos
  //claros (ej. el botón de alarma con fondo amarillo). Mantienen la
  //identidad visual del recurso (marrón/slate/azul oscuro) pero con
  //contraste suficiente para leer.
  const COLOR_RECURSO_OSCURO = { wood: "#6e3f1a", stone: "#3a4a5e", iron: "#1f2d3d" };
  const LABEL_RECURSO = { wood: "Madera", stone: "Piedra", iron: "Hierro" };

  async function init(ctx) {
    const { game, core } = ctx;
    const { csrfToken, world_id, townId } = game;

    const STORAGE_KEY_MAPA = `jambotMercadoOroMapa_${world_id}`;
    const STORAGE_KEY_ALERTAS = `jambotMercadoOroAlertas_${world_id}`;
    const STORAGE_KEY_MUTE = `jambotMercadoOroMute_${world_id}`;

    let mapaSeaIdToTown = {};
    let ultimoDescubrimiento = 0;
    //estadoActual[seaId] = {townId, ts, wood:{stock,capacity,diff}, stone:..., iron:...}
    let estadoActual = {};
    //alertas[] = {ts, seaId, items:[{r,diff,stock,capacity}]}. Rotatorio.
    let alertas = [];

    //Una notificación viva por mar. Cuando un mar pasa arriba de umbral entra
    //al Set y se queda hasta que el usuario lo descarte individualmente (✓).
    //Las filas/notifications persisten aunque el oro baje del umbral (la
    //alarma sigue activa hasta el ✓), y cada mar es independiente: descartar
    //uno no afecta a los otros. La "alarma global" está activa mientras el
    //Set tenga al menos un seaId.
    let maresEnAlarma = new Set();
    let beepIntervalId = null;
    let flashIntervalId = null;
    let tituloOriginal = null;
    let audioCtx = null;
    //Mute por mar (Set<seaId:number>). Antes era un único booleano global;
    //ahora cada mar puede silenciarse independientemente, así si un mar tiene
    //oro y se silencia, otros mares con oro siguen sonando. El beep arranca
    //si hay al menos un mar EN ALARMA cuyo seaId NO esté en este Set.
    let maresMuteados = new Set();

    function hayAlarma() { return maresEnAlarma.size > 0; }

    //—— Persistencia ————————————————————————————————————————————————————
    async function cargarStorage() {
      try {
        const obj = await new Promise((resolve) => {
          chrome.storage.local.get(
            [STORAGE_KEY_MAPA, STORAGE_KEY_ALERTAS, STORAGE_KEY_MUTE],
            (o) => resolve(o || {})
          );
        });
        //Mute persistido: shape nuevo es Array<seaId:number>. Shape viejo
        //era boolean (true=todo muteado). Si veo el shape viejo lo descarto
        //(Set vacío) — no sabemos qué mares existían cuando se muteó, y
        //tampoco vale la pena conservar un "mute global" que ya no expresa
        //bien la intención del usuario en el nuevo modelo por-mar.
        const rawMute = obj[STORAGE_KEY_MUTE];
        if (Array.isArray(rawMute)) {
          maresMuteados = new Set(rawMute.map(Number).filter((n) => !Number.isNaN(n)));
        }
        const guardadoMapa = obj[STORAGE_KEY_MAPA];
        if (guardadoMapa && typeof guardadoMapa === "object") {
          mapaSeaIdToTown = guardadoMapa.mapa || {};
          ultimoDescubrimiento = guardadoMapa.ts || 0;
          //Migración del shape viejo `sea_id → townId(number)` al nuevo
          //`sea_id → {id, name}`. Si detecto el formato viejo, normalizo a
          //objeto sin nombre y fuerzo re-descubrimiento para repoblar el
          //nombre desde la collection Towns.
          let necesitaMigrar = false;
          for (const k of Object.keys(mapaSeaIdToTown)) {
            const v = mapaSeaIdToTown[k];
            if (typeof v === "number") {
              mapaSeaIdToTown[k] = { id: v, name: null };
              necesitaMigrar = true;
            }
          }
          if (necesitaMigrar) ultimoDescubrimiento = 0;
        }
        if (Array.isArray(obj[STORAGE_KEY_ALERTAS])) alertas = obj[STORAGE_KEY_ALERTAS];
        const n = Object.keys(mapaSeaIdToTown).length;
        if (n > 0) {
          core.log(
            "mercadoOro",
            `mapa ${n} mar(es) cargado · ${alertas.length} alertas`,
            "ok"
          );
        }
      } catch (_) { /* sin storage */ }
    }

    function persistirMapa() {
      try {
        chrome.storage.local.set({
          [STORAGE_KEY_MAPA]: { mapa: mapaSeaIdToTown, ts: ultimoDescubrimiento },
        });
      } catch (_) {}
    }
    function persistirMute() {
      try {
        chrome.storage.local.set({ [STORAGE_KEY_MUTE]: Array.from(maresMuteados) });
      } catch (_) {}
    }

    let saveAlertasTimer = null;
    function persistirAlertas() {
      if (saveAlertasTimer) return;
      saveAlertasTimer = setTimeout(() => {
        saveAlertasTimer = null;
        try { chrome.storage.local.set({ [STORAGE_KEY_ALERTAS]: alertas }); } catch (_) {}
      }, 1000);
    }

    await cargarStorage();

    //—— Botón de alarma ————————————————————————————————————————————————
    //
    //Único botón propio. Aparece solo durante alarma — el panel se abre
    //desde Jam▶ y el tab "Oro" se registra desde recoleccion.js.
    //El click directo sobre el botón (fuera de los iconos por fila) ya NO
    //descarta toda la alarma — cada mar se descarta con su propio ✓. El
    //onClick acá queda como no-op de seguridad; el listener de captura más
    //abajo intercepta los clicks sobre los controles individuales.
    const botonAlarma = core.registrarBoton({
      id: "jambot-oro-confirm",
      label: "🔔 Revisé oro",
      onClick: () => {},
    });
    //Interceptor en fase captura para los controles por fila dentro del
    //label: 🔇/🔊 (mute por mar) y ✓ (descartar notif por mar). Sin esto,
    //el click bubbleria al onClick del botón. Captura corre antes que el
    //handler bubble que registró registrarBoton.
    botonAlarma.el.addEventListener("click", (ev) => {
      const muteSpan = ev.target.closest("[data-mute-sea]");
      const dismissSpan = ev.target.closest("[data-dismiss-sea]");
      if (!muteSpan && !dismissSpan) return;
      ev.stopPropagation();
      ev.stopImmediatePropagation();
      ev.preventDefault();
      if (dismissSpan) {
        dismissMar(dismissSpan.getAttribute("data-dismiss-sea"));
      } else {
        toggleMuteMar(muteSpan.getAttribute("data-mute-sea"));
      }
    }, true);

    //"Audible" = al menos un mar EN ALARMA cuyo seaId no esté muteado. Como
    //las notifications persisten hasta el ✓ del usuario, el beep sigue
    //sonando mientras la fila siga viva, no solo mientras el oro siga arriba
    //de umbral. Si te molesta, muteás o confirmás.
    function hayOroAudible() {
      for (const s of maresEnAlarma) {
        if (!maresMuteados.has(s)) return true;
      }
      return false;
    }

    //Único panel flotante de feedback: agrupa filas de mares en alarma
    //(con ✓) y filas de mares solo muteados (con 🔊 para reactivar). Si no
    //hay ni alarma ni mutes, se esconde. El color del botón refleja el modo:
    //  - amarillo brillante si hay alarma viva
    //  - gris medio si solo hay mares muteados (recordatorio, no alarma)
    //Antes había DOS botones (alarma + mute global); el segundo desapareció,
    //todo el feedback pasa por este único botón.
    function actualizarBotonFlotante() {
      const visible = hayAlarma() || maresMuteados.size > 0;
      if (!visible) {
        botonAlarma.el.style.display = "none";
        return;
      }
      if (hayAlarma()) {
        botonAlarma.setStyle({ bg: "#f1c40f", fg: "#1a1a1a" });
      } else {
        botonAlarma.setStyle({ bg: "#5a6776", fg: "#e6e9ee" });
      }
      botonAlarma.setLabel(construirLabelAlarma());
      botonAlarma.el.style.display = "";
    }
    actualizarBotonFlotante();

    //Sincroniza el beep con el estado actual: arranca si hay oro audible y
    //la alarma está activa, detiene si todo está muteado o no hay oro.
    function sincronizarBeep() {
      if (!hayAlarma()) return;
      const audible = hayOroAudible();
      if (audible && !beepIntervalId) {
        iniciarBeep();
      } else if (!audible && beepIntervalId) {
        clearInterval(beepIntervalId);
        beepIntervalId = null;
        if (audioCtx) {
          try { audioCtx.close(); } catch (_) {}
          audioCtx = null;
        }
      }
    }

    //Toggle global: si hay algún mar muteado, desmutea TODOS; si ninguno,
    //mutea TODOS los mares con notif activa (o todos los del mapa si no hay
    //alarma corriendo, como preset preventivo). Es el atajo rápido del
    //botón flotante — para granularidad fina, ✓/🔇 por fila o panel "Oro".
    function toggleMuteGlobal() {
      if (maresMuteados.size > 0) {
        maresMuteados.clear();
        core.log("mercadoOro", "sonido activado en todos los mares", "ok");
      } else {
        const objetivos = hayAlarma()
          ? Array.from(maresEnAlarma)
          : Object.keys(mapaSeaIdToTown).map(Number);
        for (const s of objetivos) maresMuteados.add(s);
        core.log("mercadoOro", `sonido silenciado en ${objetivos.length} mar(es): ${objetivos.join(", ")}`, "ok");
      }
      persistirMute();
      sincronizarBeep();
      actualizarBotonFlotante();
      refrescarPanelOroSiVisible();
    }

    //Toggle individual de un mar. Usado por el control de la tabla del panel
    //y por el icono 🔇/🔊 que aparece a la derecha de cada fila del botón
    //flotante de alarma.
    function toggleMuteMar(seaId) {
      seaId = Number(seaId);
      if (maresMuteados.has(seaId)) {
        maresMuteados.delete(seaId);
        core.log("mercadoOro", `mar ${seaId}: sonido activado`, "ok");
      } else {
        maresMuteados.add(seaId);
        core.log("mercadoOro", `mar ${seaId}: sonido silenciado`, "ok");
      }
      persistirMute();
      sincronizarBeep();
      actualizarBotonFlotante();
      refrescarPanelOroSiVisible();
    }

    //Re-render del panel solo si la tab Oro está actualmente visible. Usamos
    //un marcador (#mercadoOroPanelMarker) que renderTab inyecta — al cambiar
    //de tab, esa tab limpia el body y borra el marker, así no pisamos
    //contenido de otras tabs.
    function refrescarPanelOroSiVisible() {
      const body = document.querySelector("#panelConfigJam .pcj-body");
      if (!body) return;
      if (!body.querySelector("#mercadoOroPanelMarker")) return;
      renderTab(body);
    }

    function iniciarBeep() {
      try {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        if (audioCtx.state === "suspended") audioCtx.resume();
      } catch (e) {
        core.logWarn("mercadoOro", "AudioContext no disponible — alarma solo visual");
        audioCtx = null;
        return;
      }
      const beep = () => {
        if (!audioCtx) return;
        try {
          //Square wave 1400Hz, attack/release cortos: cada beep "puntudo"
          //para que el cerebro no lo filtre como tono ambiente.
          const o = audioCtx.createOscillator();
          const g = audioCtx.createGain();
          o.connect(g);
          g.connect(audioCtx.destination);
          o.type = "square";
          o.frequency.value = 1400;
          const t = audioCtx.currentTime;
          g.gain.setValueAtTime(0, t);
          g.gain.linearRampToValueAtTime(0.18, t + 0.02);
          g.gain.linearRampToValueAtTime(0, t + 0.32);
          o.start(t);
          o.stop(t + 0.35);
        } catch (_) {}
      };
      beep();
      beepIntervalId = setInterval(beep, BEEP_INTERVAL_MS);
    }

    //—— Alarma ——————————————————————————————————————————————————————————
    //
    //Agrupa items planos {seaId, recurso, diff, stock, capacity} por mar,
    //devolviendo Map<seaId, Array<{r,diff,stock,capacity}>> ordenado por
    //seaId numérico para que el orden de filas sea estable entre refreshes.
    function agruparPorMar(items) {
      const porMar = new Map();
      for (const x of items) {
        if (!porMar.has(x.seaId)) porMar.set(x.seaId, []);
        porMar.get(x.seaId).push({ r: x.recurso, diff: x.diff, stock: x.stock, capacity: x.capacity });
      }
      return new Map([...porMar.entries()].sort(([a], [b]) => Number(a) - Number(b)));
    }

    //HTML para el botón flotante: una fila por cada mar EN ALARMA (mares en
    //`maresEnAlarma`), no por cada mar con oro actual. Las notifications
    //persisten aunque el oro baje del umbral, hasta que el usuario apriete ✓
    //en cada fila. Cada fila muestra:
    //  - Texto del mar + recursos disponibles (estado actual o "—" si no hay
    //    valor todavía / si todos bajaron de umbral pero la fila persiste).
    //  - 🔇/🔊: toggle mute solo de ese mar (data-mute-sea).
    //  - ✓: descarta solo ese mar (data-dismiss-sea). Cuando se descartan
    //    todos, la alarma global se apaga.
    //
    //Cada recurso usa la variante OSCURA del color porque el fondo del botón
    //es amarillo brillante y los colores claros quedan ilegibles.
    function construirLabelAlarma() {
      const enAlarmaSorted = Array.from(maresEnAlarma).sort((a, b) => a - b);
      const soloMuteados = Array.from(maresMuteados)
        .filter((s) => !maresEnAlarma.has(s))
        .sort((a, b) => a - b);
      const modoAlarma = hayAlarma();

      //Colores adaptados al fondo del botón: amarillo brillante en modo
      //alarma → texto/iconos oscuros; gris medio en modo "solo mutes" →
      //texto/iconos claros.
      const fgPrincipal = modoAlarma ? "#1a1a1a" : "#e6e9ee";
      const fgSec = modoAlarma ? "#6b5d2a" : "#bdc3c7";
      const tintIconBg = modoAlarma ? "rgba(26,26,26,0.18)" : "rgba(255,255,255,0.18)";
      const tintIconBgMuted = modoAlarma ? "rgba(26,26,26,0.32)" : "rgba(255,255,255,0.32)";

      //Fila de mar EN ALARMA: recursos + 🔇/🔊 + ✓.
      const filaAlarma = (seaId) => {
        const e = estadoActual[seaId];
        const arriba = [];
        if (e) {
          for (const r of RECURSOS) {
            const v = e[r];
            if (v && v.diff >= UMBRAL) arriba.push({ r, diff: v.diff });
          }
        }
        const recsHtml = arriba.length
          ? arriba
              .map((it) => {
                const color = modoAlarma
                  ? (COLOR_RECURSO_OSCURO[it.r] || "#1a1a1a")
                  : (COLOR_RECURSO[it.r] || "#e6e9ee");
                const label = escapeHtml(LABEL_RECURSO[it.r] || it.r);
                return `<span style="color:${color};font-weight:bold">${label} ${it.diff}</span>`;
              })
              .join(" · ")
          : `<span style="color:${fgSec};font-style:italic">ya bajó — pendiente confirmar</span>`;

        const muted = maresMuteados.has(seaId);
        const muteIcon = muted ? "🔇" : "🔊";
        const muteTitle = muted
          ? `Mar ${seaId}: sonido silenciado — tocá para reactivar`
          : `Mar ${seaId}: tocá para silenciar el sonido solo de este mar`;
        const muteBg = muted ? tintIconBgMuted : tintIconBg;
        const dismissTitle = `Mar ${seaId}: descartar esta notificación (los otros mares siguen activos)`;

        return (
          `<div style="display:flex;align-items:center;gap:10px;width:100%">` +
          `<span style="flex:1;text-align:left"><b style="color:${fgPrincipal}">Mar ${seaId}:</b> ${recsHtml}</span>` +
          `<span data-mute-sea="${seaId}" title="${escapeHtml(muteTitle)}" ` +
          `style="cursor:pointer;background:${muteBg};border-radius:3px;` +
          `padding:1px 6px;font-size:13px;line-height:1.2;user-select:none">${muteIcon}</span>` +
          `<span data-dismiss-sea="${seaId}" title="${escapeHtml(dismissTitle)}" ` +
          `style="cursor:pointer;background:${tintIconBg};color:${fgPrincipal};` +
          `border-radius:3px;padding:1px 7px;font-size:13px;font-weight:bold;` +
          `line-height:1.2;user-select:none">✓</span>` +
          `</div>`
        );
      };

      //Fila de mar SOLO MUTEADO (ya no hay alarma activa para él): solo
      //texto + 🔊 para reactivar. Sin ✓ porque no hay notif que descartar.
      //Esta es la "memoria" visual que pediste: si confirmaste un mar que
      //quedó muteado, esa fila persiste hasta que reactives el sonido.
      const filaSoloMute = (seaId) => {
        const muteTitle = `Mar ${seaId}: sonido silenciado — tocá para reactivar`;
        return (
          `<div style="display:flex;align-items:center;gap:10px;width:100%;opacity:0.92">` +
          `<span style="flex:1;text-align:left;color:${fgPrincipal};font-style:italic">` +
          `Mar ${seaId} <span style="color:${fgSec};font-style:normal">· muteado</span></span>` +
          `<span data-mute-sea="${seaId}" title="${escapeHtml(muteTitle)}" ` +
          `style="cursor:pointer;background:${tintIconBgMuted};border-radius:3px;` +
          `padding:1px 6px;font-size:13px;line-height:1.2;user-select:none">🔊</span>` +
          `</div>`
        );
      };

      const filas = enAlarmaSorted.map(filaAlarma).join("") + soloMuteados.map(filaSoloMute).join("");
      const header = modoAlarma ? "🔔 Oro" : "🔇 Muteados";
      return (
        `<span style="display:inline-flex;align-items:center;gap:8px;vertical-align:middle">` +
        `<span>${header}</span>` +
        `<span style="display:inline-flex;flex-direction:column;align-items:stretch;line-height:1.3;text-align:left;min-width:0">${filas}</span>` +
        `</span>`
      );
    }

    //Arranca/actualiza la alarma. Cada mar entra al Set `maresEnAlarma` como
    //notificación independiente: si ya estaba, no relogeamos ni duplicamos
    //historial; si es nuevo, se loggea y se agrega al historial. La alarma
    //global (audio, flash, botón visible) se activa la primera vez que el
    //Set deja de estar vacío y se mantiene mientras tenga al menos un mar.
    function dispararAlarma(items) {
      const porMar = agruparPorMar(items);
      const huboAlarmaAntes = hayAlarma();

      const maresNuevos = [];
      for (const seaId of porMar.keys()) {
        const n = Number(seaId);
        if (!maresEnAlarma.has(n)) {
          maresEnAlarma.add(n);
          maresNuevos.push(n);
        }
      }
      if (!maresNuevos.length && huboAlarmaAntes) {
        //Ningún mar nuevo y la alarma ya estaba activa: solo refrescamos
        //label (los valores pueden haber cambiado dentro de los mismos mares).
        sincronizarBeep();
        actualizarBotonFlotante();
        return;
      }

      //Log + historial solo para los mares que recién entran (no para los
      //que ya estaban con alarma viva).
      if (maresNuevos.length) {
        const resumenLog = maresNuevos
          .map((seaId) => {
            const lista = porMar.get(String(seaId)) || porMar.get(seaId) || [];
            const recs = lista.map((it) => `${LABEL_RECURSO[it.r] || it.r} ${it.diff}`).join(" · ");
            return `Mar ${seaId}: ${recs}`;
          })
          .join(" | ");
        core.logWarn("mercadoOro", `ORO DISPONIBLE — ${resumenLog}`);

        const ahora = Date.now();
        for (const seaId of maresNuevos) {
          const lista = porMar.get(String(seaId)) || porMar.get(seaId) || [];
          alertas.push({ ts: ahora, seaId, items: lista });
        }
        while (alertas.length > ALERTAS_MAX) alertas.shift();
        persistirAlertas();
      }

      sincronizarBeep();
      actualizarBotonFlotante();

      //Audio/flash de título se inicia solo en la transición "no había
      //alarma → ahora hay alarma". Si la alarma ya estaba activa y se
      //agregan mares nuevos, no reiniciamos el flash (ya está corriendo).
      if (!huboAlarmaAntes) {
        if (tituloOriginal == null) tituloOriginal = document.title;
        let on = false;
        flashIntervalId = setInterval(() => {
          on = !on;
          document.title = on ? "🔔 ORO — JamBot" : tituloOriginal;
        }, 800);
      }
    }

    //Descarta la notificación de UN mar. Si era el último, apaga la alarma
    //global (audio, flash). El botón flotante puede seguir visible si el mar
    //(u otros) quedaron muteados — en ese caso muestra el "recordatorio de
    //mute" hasta que el usuario reactive el sonido.
    function dismissMar(seaId) {
      seaId = Number(seaId);
      if (!maresEnAlarma.has(seaId)) return;
      maresEnAlarma.delete(seaId);
      core.log("mercadoOro", `mar ${seaId}: notificación descartada`, "ok");
      if (hayAlarma()) {
        sincronizarBeep();
        actualizarBotonFlotante();
        refrescarPanelOroSiVisible();
      } else {
        detenerAlarmaGlobal();
      }
    }

    function detenerAlarmaGlobal() {
      maresEnAlarma.clear();
      core.log("mercadoOro", "alarma confirmada por usuario", "ok");
      if (beepIntervalId) { clearInterval(beepIntervalId); beepIntervalId = null; }
      if (flashIntervalId) {
        clearInterval(flashIntervalId);
        flashIntervalId = null;
        if (tituloOriginal != null) {
          document.title = tituloOriginal;
          tituloOriginal = null;
        }
      }
      if (audioCtx) {
        try { audioCtx.close(); } catch (_) {}
        audioCtx = null;
      }
      //Botón flotante: queda visible si hay mares muteados (recordatorio)
      //o se oculta si no.
      actualizarBotonFlotante();
      refrescarPanelOroSiVisible();
    }

    //—— Requests ————————————————————————————————————————————————————————
    //Re-dispatch las `notifications` de cada response al bridge para que
    //MM/Backbone actualice los modelos del juego (Town, BuildingOrders,
    //Units, …) y la UI se refresque sola. Sin esto, al pollear seguido
    //drenamos las notifs sin entregarlas al juego — la cola de construcción
    //no baja, los recursos no se actualizan, tropas no se mueven en la UI.
    function dispatchNotifs(body) {
      const notifs = body && body.json && body.json.notifications;
      if (Array.isArray(notifs) && notifs.length) {
        window.dispatchEvent(new CustomEvent("JamBot:dispatchNotifications", {
          detail: { notifications: notifs },
        }));
      }
    }

    async function leerPremiumExchange(repTownId) {
      const json = JSON.stringify({
        model_url: "PremiumExchange",
        action_name: "read",
        town_id: repTownId,
        nl_init: true,
      });
      const url =
        `https://${world_id}.grepolis.com/game/frontend_bridge` +
        `?town_id=${repTownId}&action=execute&h=${csrfToken}` +
        `&json=${encodeURIComponent(json)}&_=${Date.now()}`;
      const res = await fetch(url, {
        method: "GET",
        credentials: "include",
        headers: {
          "X-Requested-With": "XMLHttpRequest",
          "Accept": "text/plain, */*; q=0.01",
        },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      dispatchNotifs(body);
      return body;
    }

    async function obtenerCiudades() {
      const url =
        `https://${world_id}.grepolis.com/game/frontend_bridge` +
        `?town_id=${townId}&action=refetch&h=${csrfToken}` +
        `&json={"collections":{"Towns":[]},"town_id":${townId},"nl_init":false}`;
      const res = await fetch(url, {
        method: "GET",
        credentials: "include",
        headers: {
          "X-Requested-With": "XMLHttpRequest",
          "Accept": "text/plain, */*; q=0.01",
        },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      dispatchNotifs(data);
      const items =
        (data && data.json && data.json.collections && data.json.collections.Towns &&
          data.json.collections.Towns.data) || [];
      return items.map((it) => it.d || it).filter((c) => c && c.id);
    }

    function procesarPayload(seaId, repTown, payloadJson, ts) {
      if (!payloadJson) return [];
      const entry = { townId: repTown.id, townName: repTown.name, ts };
      const dispara = [];
      for (const k of RECURSOS) {
        const r = payloadJson[k];
        if (!r) continue;
        const stock = r.stock || 0;
        const capacity = r.capacity || 0;
        const diff = capacity - stock;
        entry[k] = { stock, capacity, diff };
        if (diff >= UMBRAL) {
          dispara.push({ seaId: Number(seaId), recurso: k, diff, stock, capacity });
        }
      }
      estadoActual[seaId] = entry;
      return dispara;
    }

    //—— Descubrimiento ————————————————————————————————————————————————
    async function descubrirMares() {
      core.log("mercadoOro", "descubriendo mapa de mares (1 req por ciudad)…");
      let ciudades;
      try {
        ciudades = await obtenerCiudades();
      } catch (e) {
        core.logError("mercadoOro", "no pude obtener lista de ciudades", e);
        return;
      }
      if (!ciudades.length) {
        core.logWarn("mercadoOro", "lista de ciudades vacía");
        return;
      }

      const nuevoMapa = {};
      const acumulado = [];
      const ts = Date.now();
      for (const c of ciudades) {
        if (!core.isExtensionContextValid()) return;
        if (core.isCaptchaActive()) {
          core.logWarn("mercadoOro", "descubrimiento abortado por CAPTCHA");
          return;
        }
        try {
          const data = await leerPremiumExchange(c.id);
          const j = data && data.json;
          const seaId = j && j.sea_id;
          if (seaId == null) continue;
          if (nuevoMapa[seaId] == null) {
            nuevoMapa[seaId] = { id: c.id, name: c.name || null };
            acumulado.push(...procesarPayload(seaId, nuevoMapa[seaId], j, ts));
          }
          await core.delaySeconds(0.3 + Math.random() * 0.3);
        } catch (e) {
          core.logWarn("mercadoOro", `descubrir ciudad ${c.id} (${c.name}): ${e.message}`);
        }
      }
      mapaSeaIdToTown = nuevoMapa;
      ultimoDescubrimiento = Date.now();
      persistirMapa();
      core.log(
        "mercadoOro",
        `mapa actualizado: ${Object.keys(nuevoMapa).length} mar(es) ${JSON.stringify(nuevoMapa)}`,
        "ok"
      );
      //dispararAlarma es idempotente por mar (agrega solo seaIds nuevos al
      //Set), así que lo llamamos sin chequear hayAlarma. Si no hay acumulado
      //pero la alarma sigue, solo refrescamos el label/beep desde estado.
      if (acumulado.length) dispararAlarma(acumulado);
      else if (hayAlarma()) { sincronizarBeep(); actualizarBotonFlotante(); }
    }

    //—— Ciclo ————————————————————————————————————————————————————————
    async function ciclo() {
      if (!core.isExtensionContextValid()) return;
      if (core.isCaptchaActive()) return;

      const ahora = Date.now();
      const sinMapa = Object.keys(mapaSeaIdToTown).length === 0;
      const expirado = ahora - ultimoDescubrimiento >= REDESCUBRIR_INTERVAL_MS;
      if (sinMapa || expirado) {
        await descubrirMares();
        return;
      }

      const acumulado = [];
      const ts = Date.now();
      for (const [seaId, repTown] of Object.entries(mapaSeaIdToTown)) {
        if (!core.isExtensionContextValid()) return;
        if (core.isCaptchaActive()) return;
        try {
          const data = await leerPremiumExchange(repTown.id);
          acumulado.push(...procesarPayload(seaId, repTown, data && data.json, ts));
          await core.delaySeconds(0.3 + Math.random() * 0.3);
        } catch (e) {
          core.logWarn("mercadoOro", `poll mar ${seaId} (town ${repTown.id}): ${e.message}`);
        }
      }
      //dispararAlarma es idempotente por mar (agrega solo seaIds nuevos al
      //Set), así que lo llamamos sin chequear hayAlarma. Si no hay acumulado
      //pero la alarma sigue, solo refrescamos el label/beep desde estado.
      if (acumulado.length) dispararAlarma(acumulado);
      else if (hayAlarma()) { sincronizarBeep(); actualizarBotonFlotante(); }
    }

    //—— Render del tab "Oro" ————————————————————————————————————————————
    //
    //Self-contained — los estilos imitan a renderTab de ataques.js para que
    //la tab se sienta parte del panel: cards en #172029 con border #2c3a4d,
    //texto #e6e9ee/#7a8aa0, subtítulos en mayúsculas con tracking.
    //Recoleccion lo invoca cada segundo mientras el tab está visible.

    function escapeHtml(s) {
      return String(s).replace(/[&<>"']/g, (c) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
      })[c]);
    }

    function fmtTiempoRel(ms) {
      const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
      if (s < 60) return `hace ${s}s`;
      if (s < 3600) return `hace ${Math.floor(s / 60)}m ${s % 60}s`;
      return `hace ${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
    }

    function fmtHora(ms) {
      const d = new Date(ms);
      const pad = (n) => String(n).padStart(2, "0");
      return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    }

    function colorDiff(diff) {
      if (diff == null) return "#5a6776";
      if (diff >= UMBRAL) return "#e74c3c";
      if (diff >= UMBRAL * 0.5) return "#f1c40f";
      return "#27ae60";
    }

    function renderHeader() {
      const mares = Object.keys(mapaSeaIdToTown).length;
      const wrap = document.createElement("div");
      const corriendo = !core.isCaptchaActive();
      wrap.style.cssText =
        "display:flex;align-items:center;gap:12px;padding:10px 12px;" +
        "background:#172029;border:1px solid #2c3a4d;border-radius:4px;" +
        `border-left:3px solid ${hayAlarma() ? "#e74c3c" : (corriendo ? "#27ae60" : "#7a8aa0")}`;
      const left = document.createElement("div");
      left.style.cssText = "flex:1;min-width:0";
      const titulo = document.createElement("div");
      titulo.textContent = "Monitor de mercado de oro";
      titulo.style.cssText = "font-weight:bold;color:#e6e9ee;font-size:12.5px";
      const sub = document.createElement("div");
      const enAlarma = Array.from(maresEnAlarma).sort((a, b) => a - b);
      sub.textContent = hayAlarma()
        ? `🔔 ALARMA — ${enAlarma.length} mar(es) pendientes: ${enAlarma.join(", ")} · confirmá cada uno con ✓`
        : corriendo
          ? `Activo · revisa cada ${POLL_INTERVAL_MS / 1000}s · alerta si hay ≥${UMBRAL} de espacio para vender · ${mares} mar(es) · ${alertas.length} alertas`
          : "En espera — CAPTCHA activo";
      sub.style.cssText = "color:#7a8aa0;font-size:10.5px;margin-top:1px";
      left.appendChild(titulo);
      left.appendChild(sub);
      wrap.appendChild(left);

      //Botón "Descartar todas" — atajo para limpiar todas las notifications
      //en alarma de un saque, en vez de hacer ✓ por mar. Solo aparece si hay
      //alarma viva. El comportamiento "✓ por mar" sigue vivo en cada fila
      //del botón flotante de alarma.
      if (hayAlarma()) {
        const ackBtn = document.createElement("button");
        ackBtn.type = "button";
        ackBtn.textContent = `✓ Descartar todas (${enAlarma.length})`;
        ackBtn.title = "Descarta todas las notificaciones pendientes de oro. Equivale a apretar ✓ en cada fila.";
        ackBtn.style.cssText =
          "background:#27ae60;color:#0e1a14;border:0;padding:6px 12px;" +
          "cursor:pointer;border-radius:3px;font-size:11.5px;font-weight:bold;white-space:nowrap";
        ackBtn.addEventListener("click", () => detenerAlarmaGlobal());
        wrap.appendChild(ackBtn);
      }

      //Toggle mute GLOBAL — atajo para silenciar/reactivar todos los mares
      //con notif activa. Para mute por mar individual: control en la tabla
      //o icono 🔇/🔊 de cada fila del botón flotante.
      const algunoMuteado = maresMuteados.size > 0;
      const muteBtn = document.createElement("button");
      muteBtn.type = "button";
      muteBtn.textContent = algunoMuteado ? "🔊 Activar todos" : "🔇 Silenciar todos";
      muteBtn.title = algunoMuteado
        ? `Hay ${maresMuteados.size} mar(es) silenciados. Tocá para reactivar todos.`
        : "Tocá para silenciar el beep de TODOS los mares con oro. La alerta visual sigue.";
      muteBtn.style.cssText =
        "background:" + (algunoMuteado ? "#7a8aa0" : "#f39c12") + ";color:#1a1a1a;" +
        "border:0;padding:6px 12px;cursor:pointer;border-radius:3px;" +
        "font-size:11.5px;font-weight:bold;white-space:nowrap";
      muteBtn.addEventListener("click", () => toggleMuteGlobal());
      wrap.appendChild(muteBtn);

      return wrap;
    }

    function renderExplicacion(texto) {
      const v = document.createElement("div");
      v.innerHTML = texto;
      v.style.cssText =
        "background:#1a232e;border-left:3px solid #3498db;color:#bdc3c7;" +
        "padding:8px 10px;font-size:11.5px;line-height:1.45;border-radius:3px;" +
        "margin-bottom:8px";
      return v;
    }

    function renderSubtitulo(text) {
      const s = document.createElement("div");
      s.textContent = text;
      s.style.cssText =
        "font-size:10.5px;font-weight:bold;margin:14px 0 8px;color:#7a8aa0;" +
        "text-transform:uppercase;letter-spacing:1.2px;" +
        "border-bottom:1px solid #2c3a4d;padding-bottom:5px";
      return s;
    }

    function renderTablaEstado() {
      const mares = Object.keys(mapaSeaIdToTown).sort((a, b) => Number(a) - Number(b));
      if (!mares.length) {
        const v = document.createElement("div");
        v.textContent = "Esperando primer descubrimiento de mares…";
        v.style.cssText = "color:#7a8aa0;font-style:italic;font-size:11.5px;padding:6px 0";
        return v;
      }
      const wrap = document.createElement("div");
      wrap.style.cssText =
        "background:#172029;border:1px solid #2c3a4d;border-radius:4px;overflow:hidden";
      const head = `
        <tr style="background:#1a232e;color:#7a8aa0;font-size:10.5px;text-transform:uppercase;letter-spacing:0.5px">
          <th style="padding:6px 10px;text-align:left">Mar</th>
          <th style="padding:6px 10px;text-align:left">Ciudad consultada</th>
          <th style="padding:6px 10px;text-align:right" title="Espacio = capacity − stock. Cuánta madera podés vender al mercado de este mar para recibir oro.">Madera<br><span style="font-size:9px;color:#5a6776;text-transform:none;letter-spacing:0">espacio p/vender</span></th>
          <th style="padding:6px 10px;text-align:right" title="Espacio = capacity − stock. Cuánta piedra podés vender al mercado de este mar para recibir oro.">Piedra<br><span style="font-size:9px;color:#5a6776;text-transform:none;letter-spacing:0">espacio p/vender</span></th>
          <th style="padding:6px 10px;text-align:right" title="Espacio = capacity − stock. Cuánto hierro podés vender al mercado de este mar para recibir oro.">Hierro<br><span style="font-size:9px;color:#5a6776;text-transform:none;letter-spacing:0">espacio p/vender</span></th>
          <th style="padding:6px 10px;text-align:right">Actualizado</th>
          <th style="padding:6px 10px;text-align:center" title="Sonido por mar: si lo silenciás, el beep no suena para este mar aunque haya oro. Los otros mares siguen sonando.">Sonido</th>
        </tr>
      `;
      //Botón mute por celda — usa data-mute-sea para que el listener
      //delegado en el wrap maneje el click sin tener que re-adjuntar
      //handlers en cada render (renderTab se llama cada segundo).
      const muteCell = (seaId) => {
        const muted = maresMuteados.has(Number(seaId));
        const icon = muted ? "🔇" : "🔊";
        const bg = muted ? "#7a8aa0" : "#2c3a4d";
        const title = muted
          ? `Mar ${seaId}: sonido silenciado. Tocá para reactivar.`
          : `Mar ${seaId}: sonido activo. Tocá para silenciar (solo este mar).`;
        return (
          `<td style="padding:6px 10px;text-align:center">` +
          `<button type="button" data-mute-sea="${seaId}" title="${escapeHtml(title)}" ` +
          `style="background:${bg};color:#e6e9ee;border:0;padding:3px 8px;cursor:pointer;` +
          `border-radius:3px;font-size:13px;line-height:1">${icon}</button></td>`
        );
      };
      //Badge 🔔 si este mar tiene una notificación viva (está en
      //maresEnAlarma) — feedback visual coherente con las filas del botón
      //flotante. El usuario descarta la notif con ✓ desde el botón flotante;
      //acá solo se indica el estado.
      const marCellLabel = (seaId) => {
        const enAlarma = maresEnAlarma.has(Number(seaId));
        const badge = enAlarma
          ? `<span title="Mar en alarma — pendiente confirmar con ✓" style="margin-right:4px">🔔</span>`
          : "";
        return `${badge}${seaId}`;
      };
      let rows = "";
      for (const seaId of mares) {
        const e = estadoActual[seaId];
        if (!e) {
          rows += `<tr><td colspan="6" style="padding:8px 10px;color:#7a8aa0;font-size:11px;font-style:italic;border-top:1px solid #2c3a4d">mar ${seaId}: sin datos aún</td>${muteCell(seaId)}</tr>`;
          continue;
        }
        const cell = (rec) => {
          const v = e[rec];
          if (!v) return `<td style="padding:8px 10px;text-align:right;color:#5a6776">—</td>`;
          return `<td style="padding:8px 10px;text-align:right;color:${colorDiff(v.diff)};font-weight:bold;font-family:monospace" title="stock ${v.stock} / capacity ${v.capacity} — podés vender hasta ${v.diff} para recibir oro">${v.diff}</td>`;
        };
        //Nombre de la ciudad si lo tenemos (del último descubrimiento);
        //fallback al ID en monospace si todavía no se pobló (puede pasar tras
        //una migración del shape viejo del mapa, antes del re-descubrimiento).
        const ciudad = e.townName
          ? `<span style="color:#e6e9ee">${escapeHtml(e.townName)}</span> <span style="color:#5a6776;font-family:monospace;font-size:10.5px">#${e.townId}</span>`
          : `<span style="color:#bdc3c7;font-family:monospace">#${e.townId}</span>`;
        rows += `
          <tr style="border-top:1px solid #2c3a4d;font-size:12px">
            <td style="padding:8px 10px;color:#e6e9ee;font-weight:bold">${marCellLabel(seaId)}</td>
            <td style="padding:8px 10px">${ciudad}</td>
            ${cell("wood")}${cell("stone")}${cell("iron")}
            <td style="padding:8px 10px;text-align:right;color:#7a8aa0;font-size:11px">${fmtTiempoRel(e.ts)}</td>
            ${muteCell(seaId)}
          </tr>
        `;
      }
      wrap.innerHTML = `<table style="width:100%;border-collapse:collapse">${head}${rows}</table>`;
      //Delegación: un solo listener por render maneja todos los clicks en
      //botones data-mute-sea. Como wrap se recrea cada render, no leak.
      wrap.addEventListener("click", (ev) => {
        const btn = ev.target.closest("[data-mute-sea]");
        if (!btn) return;
        toggleMuteMar(btn.getAttribute("data-mute-sea"));
      });
      return wrap;
    }

    function renderCharts() {
      const mares = Object.keys(mapaSeaIdToTown).sort((a, b) => Number(a) - Number(b));
      if (!mares.length) return null;
      const wrap = document.createElement("div");
      const leyenda = document.createElement("div");
      leyenda.style.cssText = "display:flex;gap:14px;margin-bottom:8px;font-size:11px";
      leyenda.innerHTML = `
        <span style="color:${COLOR_RECURSO.wood}">■ ${LABEL_RECURSO.wood}</span>
        <span style="color:${COLOR_RECURSO.stone}">■ ${LABEL_RECURSO.stone}</span>
        <span style="color:${COLOR_RECURSO.iron}">■ ${LABEL_RECURSO.iron}</span>
        <span style="color:#e74c3c;margin-left:auto">- - umbral ${UMBRAL}</span>
      `;
      wrap.appendChild(leyenda);
      for (const seaId of mares) {
        const card = document.createElement("div");
        card.style.cssText =
          "background:#172029;border:1px solid #2c3a4d;border-radius:4px;padding:8px 10px;margin-bottom:6px";
        card.innerHTML = `
          <div style="font-size:11px;color:#bdc3c7;font-weight:bold;margin-bottom:4px">Mar ${seaId}</div>
          ${chartSVG(seaId)}
        `;
        wrap.appendChild(card);
      }
      return wrap;
    }

    function renderAlertas() {
      const wrap = document.createElement("div");
      const head = document.createElement("div");
      head.style.cssText = "display:flex;align-items:center;margin:14px 0 8px";
      const subt = document.createElement("div");
      subt.textContent = "HISTORIAL DE ALERTAS";
      subt.style.cssText =
        "flex:1;font-size:10.5px;font-weight:bold;color:#7a8aa0;" +
        "text-transform:uppercase;letter-spacing:1.2px;" +
        "border-bottom:1px solid #2c3a4d;padding-bottom:5px";
      head.appendChild(subt);
      if (alertas.length) {
        const clr = document.createElement("button");
        clr.textContent = "limpiar";
        clr.style.cssText =
          "margin-left:8px;background:#2c3a4d;color:#bdc3c7;border:0;padding:3px 10px;" +
          "cursor:pointer;border-radius:3px;font-size:11px;font-weight:bold";
        clr.addEventListener("click", () => {
          if (!confirm("¿Borrar el historial de alertas?")) return;
          alertas = [];
          persistirAlertas();
          //re-render — recoleccion vuelve a llamar renderTab cada segundo,
          //pero también gatillamos uno inmediato por feedback instantáneo.
          const body = document.querySelector("#panelConfigJam .pcj-body");
          if (body) renderTab(body);
        });
        head.appendChild(clr);
      }
      wrap.appendChild(head);

      if (!alertas.length) {
        const v = document.createElement("div");
        v.textContent = "Sin alertas registradas.";
        v.style.cssText = "color:#7a8aa0;font-style:italic;font-size:11.5px;padding:4px 0";
        wrap.appendChild(v);
        return wrap;
      }
      const lista = document.createElement("div");
      lista.id = "mercadoOroAlertasLista";
      lista.style.cssText =
        "background:#172029;border:1px solid #2c3a4d;border-radius:4px;" +
        "max-height:240px;overflow-y:auto";
      let html = "";
      const ordenadas = alertas.slice().reverse();
      for (const a of ordenadas) {
        const items = a.items
          .map((it) => {
            const label = escapeHtml(LABEL_RECURSO[it.r] || it.r);
            return `<span style="color:${COLOR_RECURSO[it.r]}">${label}</span> <b style="color:${colorDiff(it.diff)};font-family:monospace">${it.diff}</b><span style="color:#5a6776"> (${it.stock}/${it.capacity})</span>`;
          })
          .join(" · ");
        html += `
          <div style="padding:6px 10px;border-top:1px solid #2c3a4d;font-size:12px">
            <span style="color:#7a8aa0;font-family:monospace;font-size:11px">${fmtHora(a.ts)}</span>
            <b style="margin:0 8px;color:#e6e9ee">Mar ${a.seaId}</b>
            ${items}
          </div>
        `;
      }
      lista.innerHTML = html;
      wrap.appendChild(lista);
      return wrap;
    }

    function renderTab(body) {
      //Preservar scroll de la lista de alertas: renderTab se llama cada
      //segundo y reconstruye body entero, así el usuario no podía scrollear.
      const listaPrev = body.querySelector("#mercadoOroAlertasLista");
      const scrollPrev = listaPrev ? listaPrev.scrollTop : 0;

      body.innerHTML = "";
      //Marker invisible — `refrescarPanelOroSiVisible` lo usa para saber si
      //la tab Oro está actualmente montada antes de re-renderizar (evita
      //pisar el contenido de otras tabs cuando un toggle se dispara desde
      //el botón flotante).
      const marker = document.createElement("div");
      marker.id = "mercadoOroPanelMarker";
      marker.style.display = "none";
      body.appendChild(marker);
      body.appendChild(renderHeader());

      body.appendChild(renderSubtitulo("Estado actual por mar"));
      body.appendChild(renderExplicacion(
        `El mercado de oro funciona <b>por mar</b> — todas las ciudades del mismo mar comparten el mismo stock. ` +
        `Los números de cada recurso son <b>capacity − stock</b>: cuánto de ese recurso podés <b>venderle al mercado</b> ` +
        `para recibir <b style="color:#f1c40f">oro premium</b>. Verde &lt;50, amarillo 50–99, rojo ≥${UMBRAL} (dispara la alarma). ` +
        `Solo se consulta <b>una ciudad por mar</b> (la "ciudad consultada" de la tabla), porque el resto repetiría el mismo dato.`
      ));
      body.appendChild(renderTablaEstado());

      body.appendChild(renderAlertas());

      if (scrollPrev) {
        const listaNew = body.querySelector("#mercadoOroAlertasLista");
        if (listaNew) listaNew.scrollTop = scrollPrev;
      }
    }

    //—— Arranque ———————————————————————————————————————————————————————
    setInterval(() => {
      ciclo().catch((e) => core.logError("mercadoOro", "ciclo falló", e));
    }, POLL_INTERVAL_MS);
    ciclo().catch((e) => core.logError("mercadoOro", "ciclo inicial falló", e));

    core.log(
      "mercadoOro",
      `iniciado (poll cada ${POLL_INTERVAL_MS / 1000}s, umbral=${UMBRAL}, re-descubrir cada ${REDESCUBRIR_INTERVAL_MS / 60000}min)`,
      "ok"
    );

    JamBot.features.mercadoOro.api = { renderTab };
  }

  JamBot.features.mercadoOro = { init };
})();
