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

  //—— Estado de CAPTCHA ——————————————————————————————————————————————————

  let captchaActive = false;
  const captchaListeners = new Set(); //fn(active: bool)

  function isCaptchaActive() {
    return captchaActive;
  }

  function onCaptcha(listener) {
    captchaListeners.add(listener);
    return () => captchaListeners.delete(listener);
  }

  function emitCaptchaChange(active) {
    for (const fn of captchaListeners) {
      try { fn(active); } catch (e) { console.error("[JamBot/core] listener captcha:", e); }
    }
  }

  function onCaptchaDetectado() {
    if (captchaActive) return;
    captchaActive = true;
    console.warn("[JamBot] CAPTCHA detectado — pausando bot");
    iniciarFlashTitulo();
    sonarAlerta();
    chrome.runtime.sendMessage({ type: "JamBot:badge", text: "!", color: "#c0392b" });
    emitCaptchaChange(true);
  }

  function onCaptchaResuelto() {
    if (!captchaActive) return;
    captchaActive = false;
    console.log("[JamBot] CAPTCHA resuelto — reanudando bot");
    pararFlashTitulo();
    chrome.runtime.sendMessage({ type: "JamBot:badge", text: "" });
    emitCaptchaChange(false);
  }

  //—— Estado de play/pause global ———————————————————————————————————————
  //
  //Único punto de verdad para "el bot está corriendo o pausado". Todas las
  //features (recolección, finalizar construcción, …) se suscriben con
  //onPlayPauseChange y arrancan/cancelan sus ciclos según el estado.
  //
  //Inicia en pausado=true: el bot no hace nada hasta que el usuario aprieta
  //play. Eso evita arranques accidentales tras recargar la extensión.

  let pausado = true;
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
      try { fn(p); } catch (e) { console.error("[JamBot/core] listener playPause:", e); }
    }
  }

  function setPaused(p) {
    if (pausado === p) return;
    pausado = p;
    console.log("[JamBot/core] " + (p ? "PAUSADO" : "REANUDADO"));
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

  //—— UI: contenedor de botones ——————————————————————————————————————————

  function asegurarContenedorBotones() {
    let cont = document.getElementById("jambot-buttons");
    if (cont) return cont;
    cont = document.createElement("div");
    cont.id = "jambot-buttons";
    cont.style.cssText =
      "position:absolute;bottom:80px;left:10px;z-index:1000;" +
      "display:flex;flex-direction:column;gap:6px;align-items:flex-start";
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
    injectScript(chrome.runtime.getURL("/js/saveToken.js"), "body");
    injectScript(chrome.runtime.getURL("/js/gameBridge.js"), "body");

    let dataConfig;
    try {
      const res = await fetch(chrome.runtime.getURL("/data.json"));
      dataConfig = await res.json();
    } catch (e) {
      console.error("[JamBot/core] no pude cargar data.json:", e);
      return null;
    }

    const game = JSON.parse(window.localStorage.getItem("game") || "{}");
    const { csrfToken, world_id, townId, player_id } = game;
    if (!csrfToken || !world_id || !townId) {
      console.warn("[JamBot/core] localStorage.game incompleto — abortando init");
      return null;
    }
    console.log({ world_id, csrfToken, townId, player_id });

    //Escuchar el bridge para detectar cambios de bot_check
    window.addEventListener("message", (e) => {
      if (e.source !== window) return;
      const msg = e.data;
      if (!msg || msg.type !== "JamBot:captchaState") return;
      if (msg.active) onCaptchaDetectado();
      else onCaptchaResuelto();
    });

    return {
      data: dataConfig,
      game: { csrfToken, world_id, townId, player_id },
      core: {
        isCaptchaActive,
        onCaptcha,
        onCaptchaDetectado,
        onCaptchaResuelto,
        registrarBoton,
        delaySeconds,
        isPaused,
        onPlayPauseChange,
        setPaused,
        togglePlayPause,
      },
    };
  }

  JamBot.core = {
    init,
    isCaptchaActive,
    onCaptcha,
    onCaptchaDetectado,
    onCaptchaResuelto,
    registrarBoton,
    delaySeconds,
    isPaused,
    onPlayPauseChange,
    setPaused,
    togglePlayPause,
  };
})();
