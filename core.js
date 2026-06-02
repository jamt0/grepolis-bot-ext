/* core.js — estado compartido, detección de CAPTCHA, UI de botones y helpers.
 *
 * Cada feature (recolección, finalización de construcciones, …) recibe un
 * `ctx` con las cosas que necesita del juego (csrfToken, world_id, …) y la
 * API del core (registrar botón, consultar/avisar de captcha).
 *
 * Convención: todo lo que es compartido cuelga de window.JamBot.core. Cada
 * feature cuelga de window.JamBot.features.<nombre>.
 */
(function () {
  const JamBot = (window.JamBot = window.JamBot || {});
  JamBot.features = JamBot.features || {};

  //—— Helpers ————————————————————————————————————————————————————————————

  function injectScript(file, node) {
    const th = document.getElementsByTagName(node)[0];
    const s = document.createElement("script");
    s.setAttribute("type", "text/javascript");
    s.setAttribute("src", file);
    th.appendChild(s);
  }

  function delaySeconds(seconds) {
    return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
  }

  //Formatea una duración en segundos como "Xs" si es <60, o "Xm YYs" si es ≥60.
  //Acepta number (segundos). Pensado para logs y UI: cuando los ciclos crecen
  //a varios minutos, "613s" se vuelve ilegible vs "10m 13s".
  function formatDuracion(segundos) {
    const s = Math.max(0, Math.round(segundos));
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${m}m ${String(r).padStart(2, "0")}s`;
  }

  //—— Logging unificado ——————————————————————————————————————————————————
  //
  //Helpers para que todos los logs de la extensión tengan timestamp (fecha +
  //hora), color por nivel/feature y separadores claros entre ciclos. Los
  //warnings/errores se guardan en un buffer en memoria para poder recuperarlos
  //después con `JamBot.errores()` desde la consola del navegador, aun si el
  //log de DevTools fue clear-eado.
  //
  //Convención de colores:
  //  info  azul   — eventos rutinarios
  //  ok    verde  — algo terminó bien (claim exitoso, ciclo OK)
  //  warn  ámbar  — algo no fatal pero merece atención
  //  error rojo   — falla; siempre va a buffer
  //  cycle violeta — header de ciclo nuevo

  const ESTILOS = {
    ts:    "color:#888;font-weight:normal",
    scope: "color:#888",
    info:  "color:#3498db;font-weight:bold",
    ok:    "color:#27ae60;font-weight:bold",
    warn:  "color:#f39c12;font-weight:bold",
    error: "color:#fff;background:#c0392b;font-weight:bold;padding:2px 6px;border-radius:3px",
    cycle: "color:#9b59b6;font-weight:bold;font-size:13px",
  };

  const erroresBuffer = [];
  const MAX_ERRORES = 200;
  //Persistencia del buffer en chrome.storage.local. Sobrevive a reload del
  //tab y reinicio del navegador. Global (no namespaceado por mundo) — los
  //errores son ruido transitorio y no vale la pena duplicar storage por
  //mundo. Cap 200 entradas × ~500 B ≈ 100 KB, despreciable vs cuota 10 MB.
  const STORAGE_KEY_ERRORES = "jambotErrores";
  //Throttle de la escritura: muchos errores en burst (e.g. 1 por aldea
  //fallida) se colapsan en 1 sola escritura cada 500ms. Sin esto cada
  //logWarn dispararía un set() — innecesario para datos de diagnóstico.
  let saveErroresPending = null;

  function formatTimestamp() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  function log(scope, mensaje, tipo) {
    const estilo = ESTILOS[tipo] || ESTILOS.info;
    console.log(
      `%c[${formatTimestamp()}]%c [${scope}]%c ${mensaje}`,
      ESTILOS.ts, ESTILOS.scope, estilo
    );
  }

  //logWarn/logError NO usan %c en la cadena de formato. Razón: estos
  //terminan en la página de errores de chrome://extensions, donde los %c
  //aparecen como texto literal y los objetos extra se renderean como
  //"[object Object]". Sin %c el texto queda limpio en ambos contextos —
  //en DevTools console.warn/error ya pinta amarillo/rojo de fábrica, y
  //el emoji ⚠/✖ marca visualmente el nivel.
  function logWarn(scope, mensaje, ...extra) {
    console.warn(
      `[${formatTimestamp()}] [${scope}] ⚠ ${mensaje}`,
      ...extra
    );
    guardarError("warn", scope, mensaje, extra);
  }

  function logError(scope, mensaje, ...extra) {
    console.error(
      `[${formatTimestamp()}] [${scope}] ✖ ERROR: ${mensaje}`,
      ...extra
    );
    guardarError("error", scope, mensaje, extra);
  }

  //Banner con separadores `═`. Por defecto violeta (cycle); se puede pasar
  //otro tipo para distinguir niveles (e.g. "info" azul para subsecciones
  //dentro de un ciclo, como el banner de cada ciudad).
  function logCiclo(scope, titulo, tipo) {
    const sep = "═".repeat(60);
    const estilo = ESTILOS[tipo] || ESTILOS.cycle;
    console.log(
      `%c${sep}\n[${formatTimestamp()}] [${scope}] ${titulo}\n${sep}`,
      estilo
    );
  }

  function guardarError(nivel, scope, mensaje, extra) {
    erroresBuffer.push({
      ts: Date.now(),
      iso: new Date().toISOString(),
      nivel,
      scope,
      mensaje,
      //Serializar lo que se pueda para que sobreviva a referencias mutables.
      //Errores conservamos name/message/stack; objetos complejos van por
      //JSON round-trip; el resto cae a String().
      extra: extra && extra.length
        ? extra.map((e) => {
            if (e instanceof Error) return { name: e.name, message: e.message, stack: e.stack };
            try { return JSON.parse(JSON.stringify(e)); } catch (_) { return String(e); }
          })
        : undefined,
    });
    if (erroresBuffer.length > MAX_ERRORES) erroresBuffer.shift();
    persistirErroresBuffer();
  }

  //Buffer de errores: RAM only. Antes lo persistíamos en chrome.storage
  //(jambotErrores) para que sobreviviera al F5, pero suma hasta 100 KB de
  //writes con throttle y no aporta valor real — al recargar la pestaña
  //arrancamos limpios y los errores nuevos se loguean igual.
  function cargarErroresBuffer() {
    //Limpiar cualquier key vieja de versiones anteriores que sí persistían.
    try { chrome.storage.local.remove(STORAGE_KEY_ERRORES); } catch (_) {}
    return Promise.resolve();
  }

  function persistirErroresBuffer() { /* no-op — RAM only */ }

  function getErrores(filtro) {
    const f = filtro || {};
    let r = erroresBuffer.slice();
    if (f.scope) r = r.filter((e) => e.scope === f.scope);
    if (f.nivel) r = r.filter((e) => e.nivel === f.nivel);
    if (f.desde) r = r.filter((e) => e.ts >= f.desde);
    return r;
  }

  function clearErrores() {
    erroresBuffer.length = 0;
    try { chrome.storage.local.remove(STORAGE_KEY_ERRORES); } catch (_) { /* no storage */ }
    log("core", "buffer de errores limpiado", "ok");
  }

  //Imprime el buffer en consola con formato. Pensado para invocarse desde
  //DevTools: `JamBot.errores()` o `JamBot.errores({ scope: "recoleccion" })`.
  function imprimirErrores(filtro) {
    const lista = getErrores(filtro);
    if (!lista.length) {
      console.log("%c[JamBot] sin errores registrados", ESTILOS.ok);
      return;
    }
    console.group(`%c[JamBot] ${lista.length} entrada(s) en el buffer`, ESTILOS.cycle);
    for (const e of lista) {
      const fecha = new Date(e.ts).toLocaleString();
      const estilo = e.nivel === "error" ? ESTILOS.error : ESTILOS.warn;
      const fn = e.nivel === "error" ? console.error : console.warn;
      if (e.extra && e.extra.length) {
        fn(`%c[${fecha}] [${e.scope}] ${e.mensaje}`, estilo, ...e.extra);
      } else {
        fn(`%c[${fecha}] [${e.scope}] ${e.mensaje}`, estilo);
      }
    }
    console.groupEnd();
  }

  //—— Detección de contexto invalidado ————————————————————————————————
  //
  //Cuando la extensión se recarga (chrome://extensions reload, auto-update,
  //disable/enable) mientras una pestaña con content script viejo sigue
  //abierta, el content script queda huérfano: cada chrome.storage.* tira
  //"Extension context invalidated". El bot sigue corriendo en memoria pero
  //nada se persiste — y peor, cada operación del loop (1 historial + 1
  //lastClaimAt por aldea) spamea warnings. Esta función detecta el caso una
  //sola vez, loggea un error claro pidiendo recargar la pestaña, y pausa el
  //bot para que el ciclo termine limpio. Llamarla como guard antes de
  //cualquier chrome.storage.* en hot paths.
  let extInvalidNotificado = false;

  function isExtensionContextValid() {
    let valid = false;
    try { valid = !!(chrome && chrome.runtime && chrome.runtime.id); } catch (_) { valid = false; }
    if (!valid && !extInvalidNotificado) {
      extInvalidNotificado = true;
      //logError persiste en chrome.storage también, pero su set() está en
      //try/catch silencioso — no genera warning extra.
      logError("core", "extensión recargada — recargá la pestaña del juego (F5) para continuar");
      try { setPaused(true); } catch (_) { /* no debería tirar, defensivo */ }
    }
    return valid;
  }

  //Captura errores no manejados y unhandled promise rejections. Filtra por
  //URL del archivo: solo registra los que vienen de la propia extensión, así
  //no nos contaminamos con errores del juego (game.min.js, jquery, etc).
  //Las unhandledrejection no traen filename — las registramos todas igual,
  //porque cualquier promise nuestra que rompa cae aquí y conviene verla.
  function instalarCapturaErrores() {
    let extPrefix = "";
    try { extPrefix = chrome.runtime.getURL(""); } catch (_) { /* page-context */ }

    window.addEventListener("error", (e) => {
      if (!extPrefix || !e.filename || !e.filename.startsWith(extPrefix)) return;
      logError("global", e.message || "error sin mensaje", e.error || e);
    });

    window.addEventListener("unhandledrejection", (e) => {
      const reason = e.reason;
      const msg = (reason && reason.message) || String(reason);
      logError("global", `unhandledrejection: ${msg}`, reason);
    });
  }

  //—— Estado de CAPTCHA ——————————————————————————————————————————————————
  //
  //Flujo (post-rediseño): cuando una request del bot vuelve sin la
  //notificación esperada, asumimos CAPTCHA y entramos en modo "pending":
  //paramos TODO (no programamos siguiente tick), guardamos el contexto
  //(qué aldea falló, qué quedó pendiente del ciclo), arrancamos un timeout
  //de 10 min y mostramos el cartel + botón "Ya resolví" en la UI.
  //
  //El bridge sigue avisando cuando Game.bot_check vuelve a null (humano
  //resolvió en el juego) — ese evento NO reanuda el bot solo; únicamente
  //prende el flag `resueltoEnJuego` para que la UI resalte el botón. El
  //usuario tiene que apretar "Ya resolví" explícitamente: ahí la feature
  //hace la sincronización (refresh del server, detectar qué aldeas claimeó
  //el humano) y reanuda. Si el humano nunca apreta y pasan 10 min, entramos
  //en estado "timeout" — el bot se pausa de hecho y un nuevo Iniciar
  //arranca un ciclo limpio.
  //
  //Estados:
  //   "none"    sin captcha
  //   "pending" detectado, esperando que el humano resuelva + click
  //   "timeout" pasaron 10 min sin click — bot detenido, cartel de error

  const CAPTCHA_TIMEOUT_MS = 10 * 60 * 1000;

  let captchaActive = false;
  let captchaState = "none";
  let captchaContext = null;       //{ feature, ciclo, ciudad, aldea, pendientes:[{ciudadId,ciudadNombre,aldeas:[{id,nombre}]}], deteccionTs }
  let captchaResueltoEnJuego = false; //true cuando el bridge avisó active:false
  let captchaTimeoutId = null;
  const captchaListeners = new Set();        //fn(active: bool)
  const captchaContextListeners = new Set(); //fn() — UI pinta de nuevo
  const captchaTimeoutListeners = new Set(); //fn() — feature pausa

  function isCaptchaActive() {
    return captchaActive;
  }

  function getCaptchaState() {
    return captchaState;
  }

  function getCaptchaContext() {
    return captchaContext;
  }

  function isCaptchaResueltoEnJuego() {
    return captchaResueltoEnJuego;
  }

  function onCaptcha(listener) {
    captchaListeners.add(listener);
    return () => captchaListeners.delete(listener);
  }

  function onCaptchaContextChange(listener) {
    captchaContextListeners.add(listener);
    return () => captchaContextListeners.delete(listener);
  }

  function onCaptchaTimeout(listener) {
    captchaTimeoutListeners.add(listener);
    return () => captchaTimeoutListeners.delete(listener);
  }

  function emitCaptchaChange(active) {
    for (const fn of captchaListeners) {
      try { fn(active); } catch (e) { logError("core", "listener captcha falló", e); }
    }
  }

  function emitCaptchaContextChange() {
    for (const fn of captchaContextListeners) {
      try { fn(); } catch (e) { logError("core", "listener captchaContext falló", e); }
    }
  }

  function emitCaptchaTimeout() {
    for (const fn of captchaTimeoutListeners) {
      try { fn(); } catch (e) { logError("core", "listener captchaTimeout falló", e); }
    }
  }

  /**
   * Marca CAPTCHA detectado con el contexto del fallo. `ctx` es opcional
   * pero recomendado:
   *   { feature, ciclo, ciudad:{id,nombre}, aldea:{id,nombre},
   *     pendientes:[{ciudadId, ciudadNombre, aldeas:[{id,nombre}]}] }
   * Si ya estábamos en estado pending y se vuelve a llamar (e.g. otra aldea
   * más adelante también falló), mergeamos el contexto pero NO reseteamos
   * el timeout — sigue contando desde la primera detección.
   */
  function onCaptchaDetectado(ctx) {
    const ahora = Date.now();
    if (!captchaActive) {
      captchaActive = true;
      captchaState = "pending";
      captchaResueltoEnJuego = false;
      captchaContext = ctx ? { ...ctx, deteccionTs: ahora } : { deteccionTs: ahora };
      logWarn(
        "core",
        `CAPTCHA detectado — bot detenido, esperando al humano (timeout ${Math.round(CAPTCHA_TIMEOUT_MS/60000)}min)`
      );
      iniciarFlashTitulo();
      sonarAlerta();
      try { chrome.runtime.sendMessage({ type: "JamBot:badge", text: "!", color: "#c0392b" }); } catch (_) { /* page-context */ }
      //Timeout 10min — si el humano no apreta "Ya resolví", entramos en
      //estado "timeout": el cartel cambia a error, las features se pausan,
      //el siguiente Iniciar arranca un ciclo limpio.
      if (captchaTimeoutId) clearTimeout(captchaTimeoutId);
      captchaTimeoutId = setTimeout(() => {
        captchaTimeoutId = null;
        if (captchaState !== "pending") return;
        captchaState = "timeout";
        logError("core", `CAPTCHA timeout — pasaron ${Math.round(CAPTCHA_TIMEOUT_MS/60000)}min sin resolver, bot detenido`);
        emitCaptchaTimeout();
        emitCaptchaContextChange();
      }, CAPTCHA_TIMEOUT_MS);
      emitCaptchaChange(true);
      emitCaptchaContextChange();
    } else if (ctx) {
      //Ya estábamos en pending; mergear el nuevo contexto (otra aldea
      //también cayó). No tocamos timeout ni deteccionTs — siguen del primer
      //disparo.
      captchaContext = mergeCaptchaContext(captchaContext, ctx);
      emitCaptchaContextChange();
    }
  }

  function mergeCaptchaContext(prev, nuevo) {
    if (!prev) return { ...nuevo, deteccionTs: Date.now() };
    const merged = { ...prev, ...nuevo, deteccionTs: prev.deteccionTs };
    //Mergear listas de pendientes por ciudadId — sin duplicar aldeas.
    const porCiudad = new Map();
    for (const p of prev.pendientes || []) porCiudad.set(p.ciudadId, { ...p, aldeas: [...(p.aldeas || [])] });
    for (const p of nuevo.pendientes || []) {
      const ya = porCiudad.get(p.ciudadId);
      if (!ya) {
        porCiudad.set(p.ciudadId, { ...p, aldeas: [...(p.aldeas || [])] });
      } else {
        const idsExistentes = new Set(ya.aldeas.map((a) => a.id));
        for (const a of p.aldeas || []) if (!idsExistentes.has(a.id)) ya.aldeas.push(a);
      }
    }
    merged.pendientes = Array.from(porCiudad.values());
    return merged;
  }

  function onCaptchaResuelto() {
    if (!captchaActive) return;
    captchaActive = false;
    captchaState = "none";
    captchaContext = null;
    captchaResueltoEnJuego = false;
    if (captchaTimeoutId) {
      clearTimeout(captchaTimeoutId);
      captchaTimeoutId = null;
    }
    log("core", "CAPTCHA resuelto — operación normal", "ok");
    pararFlashTitulo();
    try { chrome.runtime.sendMessage({ type: "JamBot:badge", text: "" }); } catch (_) { /* page-context */ }
    emitCaptchaChange(false);
    emitCaptchaContextChange();
  }

  /**
   * Lo llama el bridge cuando Game.bot_check vuelve a null. NO reanuda el
   * bot — solo prende un flag para que el cartel resalte el botón "Ya
   * resolví". El usuario tiene control explícito sobre cuándo reanudar.
   */
  function notificarCaptchaLimpioEnJuego() {
    if (!captchaActive) return;
    if (captchaResueltoEnJuego) return;
    captchaResueltoEnJuego = true;
    log("core", "bridge: Game.bot_check limpio — esperando confirmación del usuario", "ok");
    emitCaptchaContextChange();
  }

  //—— Estado de play/pause global ———————————————————————————————————————
  //
  //Único punto de verdad para "el bot está corriendo o pausado". Todas las
  //features (recolección, finalizar construcción, …) se suscriben con
  //onPlayPauseChange y arrancan/cancelan sus ciclos según el estado.
  //
  //Inicia en pausado=false: el bot arranca corriendo automáticamente. El
  //usuario puede pausar desde la UI si lo necesita.

  let pausado = false;
  const playPauseListeners = new Set(); //fn(pausado: bool)

  function isPaused() {
    return pausado;
  }

  function onPlayPauseChange(listener) {
    playPauseListeners.add(listener);
    return () => playPauseListeners.delete(listener);
  }

  function emitPlayPauseChange(p) {
    for (const fn of playPauseListeners) {
      try { fn(p); } catch (e) { logError("core", "listener playPause falló", e); }
    }
  }

  function setPaused(p) {
    if (pausado === p) return;
    pausado = p;
    log("core", p ? "PAUSADO" : "REANUDADO", p ? "warn" : "ok");
    //Stack trace para auditar quién dispara el cambio. Si el bot "se pausa
    //solo", el stack mostrará si vino de un click humano (HTMLButtonElement
    //o similar) o de algo programático (e.g. handler del juego que tocó el
    //botón superpuesto). Imprime con console.trace para que sea colapsable
    //en DevTools y no satura el log normal.
    console.trace(`[JamBot/core] setPaused(${p}) — origen del cambio`);
    emitPlayPauseChange(p);
  }

  function togglePlayPause() {
    //Mientras hay CAPTCHA activo, ignoramos clicks — el usuario tiene que
    //resolver el modal del juego primero.
    if (captchaActive) return;
    setPaused(!pausado);
  }

  //—— Flash del título + alerta sonora ——————————————————————————————————

  let tituloOriginal = null;
  let tituloFlashId = null;

  function iniciarFlashTitulo() {
    if (tituloFlashId) return;
    if (tituloOriginal == null) tituloOriginal = document.title;
    let mostrandoAlerta = false;
    tituloFlashId = setInterval(() => {
      mostrandoAlerta = !mostrandoAlerta;
      document.title = mostrandoAlerta ? "⚠ CAPTCHA — JamBot" : tituloOriginal;
    }, 1000);
  }

  function pararFlashTitulo() {
    if (!tituloFlashId) return;
    clearInterval(tituloFlashId);
    tituloFlashId = null;
    if (tituloOriginal != null) document.title = tituloOriginal;
  }

  function sonarAlerta() {
    try {
      const ctx = new AudioContext();
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.connect(g);
      g.connect(ctx.destination);
      o.type = "sine";
      o.frequency.value = 880;
      g.gain.value = 0.1;
      o.start();
      setTimeout(() => { o.stop(); ctx.close(); }, 400);
    } catch (e) {
      //sonido es nice-to-have
    }
  }

  //Beep "suave" para advertencias no urgentes (ciudad llena, cupo diario
  //alcanzado): dos blips descendentes 660Hz→440Hz, gain bajo (0.06). Avisa
  //al usuario que algo dejó de farmear pero NO confundir con el tono del
  //CAPTCHA (880Hz solido, agudo, asociado a "bot detenido, vení ya").
  //
  //NO trae throttle global: la gating es responsabilidad del caller — la
  //feature de recolección usa un flag `advertenciaSonadaCiclo` por ciudad
  //y por ciclo, así N ciudades distintas en el mismo ciclo cada una suena
  //1 vez (y N aldeas de la misma ciudad no spamean).
  function sonarAdvertencia() {
    try {
      const ctx = new AudioContext();
      function blip(freq, atSec, durSec) {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.connect(g);
        g.connect(ctx.destination);
        o.type = "sine";
        o.frequency.value = freq;
        g.gain.setValueAtTime(0.06, ctx.currentTime + atSec);
        o.start(ctx.currentTime + atSec);
        o.stop(ctx.currentTime + atSec + durSec);
      }
      blip(660, 0, 0.12);
      blip(440, 0.18, 0.15);
      setTimeout(() => { try { ctx.close(); } catch (_) {} }, 600);
    } catch (e) {
      //sonido es nice-to-have
    }
  }

  //—— UI: contenedor de botones ——————————————————————————————————————————

  //CSS del contenedor centralizado. Lo aplicamos SIEMPRE — tanto al crear
  //el contenedor como al reutilizar uno existente — porque al recargar la
  //extensión sin recargar la página, el contenedor del run anterior queda
  //en el DOM con los estilos viejos, y el nuevo content script lo reusaría
  //sin actualizar la posición. Setear cssText cada vez fuerza el update.
  //z-index bajo (5) para que NUNCA quede encima de modales del juego —
  //antes estaba en 1000 y los clicks dirigidos al chat/foro/mensajería
  //a veces aterrizaban en el botón ▶/⏸ y pausaban el bot sin querer.
  //Position bottom:120px;left:80px → la card queda justo arriba de la cola
  //de construcción del juego (~95px de alto) con un pequeño margen. Antes
  //estaba en bottom:45px y las alertas quedaban tapadas por esa barra.
  const ESTILO_CONT_BOTONES =
    "position:absolute;bottom:120px;left:80px;z-index:5;" +
    "display:flex;flex-direction:column;gap:6px;align-items:flex-start";

  function asegurarContenedorBotones() {
    let cont = document.getElementById("jambot-buttons");
    if (cont) {
      cont.style.cssText = ESTILO_CONT_BOTONES;
      return cont;
    }
    cont = document.createElement("div");
    cont.id = "jambot-buttons";
    cont.style.cssText = ESTILO_CONT_BOTONES;
    document.body.appendChild(cont);
    return cont;
  }

  /**
   * Registra un botón para una feature. Devuelve { setLabel, setStyle, el }.
   * Cada feature controla el texto/estado de su propio botón.
   */
  function registrarBoton({ id, label, onClick }) {
    const cont = asegurarContenedorBotones();
    const btn = document.createElement("button");
    btn.id = id;
    btn.innerHTML = label;
    btn.style.cssText = "padding:6px 10px;font-weight:bold;cursor:pointer";
    btn.addEventListener("click", onClick);
    cont.appendChild(btn);
    return {
      el: btn,
      setLabel: (text) => { btn.innerHTML = text; },
      setStyle: ({ bg, fg } = {}) => {
        btn.style.background = bg || "";
        btn.style.color = fg || "";
      },
    };
  }

  //—— Inicialización compartida ——————————————————————————————————————————

  /**
   * Lee localStorage.game, inyecta scripts del bridge, escucha el postMessage
   * de cambio de bot_check y devuelve el ctx que cada feature recibirá.
   */
  async function init() {
    instalarCapturaErrores();
    //Restaurar el buffer de errores persistido. Sobrevive a reload — los
    //warnings/errores recientes quedan visibles en JamBot.errores() y en el
    //panel "Errores recientes" aunque hayas recargado la pestaña.
    await cargarErroresBuffer();

    injectScript(chrome.runtime.getURL("/js/saveToken.js"), "body");
    injectScript(chrome.runtime.getURL("/js/gameBridge.js"), "body");

    let dataConfig;
    try {
      const res = await fetch(chrome.runtime.getURL("/data.json"));
      dataConfig = await res.json();
    } catch (e) {
      logError("core", "no pude cargar data.json", e);
      return null;
    }

    const game = JSON.parse(window.localStorage.getItem("game") || "{}");
    const { csrfToken, world_id, townId, player_id } = game;
    if (!csrfToken || !world_id || !townId) {
      //Esperado en subdominios que no sean la app del juego (foro, wiki,
      //landings de marketing): saveToken solo persiste en localStorage si
      //existe `window.Game`. Salimos en silencio para no spamear consola.
      return null;
    }
    log("core", `bootstrap world=${world_id} town=${townId} player=${player_id}`, "ok");

    //Escuchar el bridge para detectar cambios de bot_check.
    //  active=true  → onCaptchaDetectado() sin contexto (la feature que
    //                 estaba haciendo la request es la que tiene que
    //                 enriquecer el contexto via su propio onCaptchaDetectado
    //                 — la detección por bridge es un fallback).
    //  active=false → NO reanudar; solo prender flag "resueltoEnJuego" para
    //                 que la UI resalte el botón "Ya resolví". El usuario
    //                 sigue teniendo que apretar para gatillar la sincro.
    window.addEventListener("message", (e) => {
      if (e.source !== window) return;
      const msg = e.data;
      if (!msg || msg.type !== "JamBot:captchaState") return;
      if (msg.active) onCaptchaDetectado();
      else notificarCaptchaLimpioEnJuego();
    });

    return {
      data: dataConfig,
      game: { csrfToken, world_id, townId, player_id },
      core: {
        isCaptchaActive,
        getCaptchaState,
        getCaptchaContext,
        isCaptchaResueltoEnJuego,
        onCaptcha,
        onCaptchaContextChange,
        onCaptchaTimeout,
        onCaptchaDetectado,
        onCaptchaResuelto,
        registrarBoton,
        delaySeconds,
        formatDuracion,
        isPaused,
        onPlayPauseChange,
        setPaused,
        togglePlayPause,
        isExtensionContextValid,
        log,
        logWarn,
        logError,
        logCiclo,
        sonarAdvertencia,
      },
    };
  }

  JamBot.core = {
    init,
    isCaptchaActive,
    getCaptchaState,
    getCaptchaContext,
    isCaptchaResueltoEnJuego,
    onCaptcha,
    onCaptchaContextChange,
    onCaptchaTimeout,
    onCaptchaDetectado,
    onCaptchaResuelto,
    registrarBoton,
    delaySeconds,
    formatDuracion,
    isPaused,
    onPlayPauseChange,
    setPaused,
    togglePlayPause,
    isExtensionContextValid,
    log,
    logWarn,
    logError,
    logCiclo,
    getErrores,
    clearErrores,
    sonarAdvertencia,
  };

  //Atajo para que el usuario pueda invocar desde DevTools:
  //  JamBot.errores()                       -> imprime todo el buffer
  //  JamBot.errores({ scope:"recoleccion" })-> filtra por feature
  //  JamBot.errores.lista()                 -> devuelve el array crudo
  //  JamBot.errores.limpiar()               -> vacía el buffer
  JamBot.errores = imprimirErrores;
  JamBot.errores.lista = getErrores;
  JamBot.errores.limpiar = clearErrores;
})();
