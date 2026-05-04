/* contentScript.js — bootstrap del bot modular.
 *
 * core.js y cada features/<nombre>.js se autoregistran en window.JamBot al
 * cargarse. Este archivo (último en el manifest) es el que efectivamente
 * arranca el bot: llama a core.init() y luego a cada feature.init(ctx).
 *
 * Si alguna feature falla al iniciar, las demás siguen funcionando — los
 * errores se logean pero no abortan el bot entero.
 */
(async () => {
  const JamBot = window.JamBot;
  if (!JamBot || !JamBot.core || !JamBot.features) {
    //Pre-init: no podemos usar JamBot.core.logError porque eso es
    //precisamente lo que falta. console.error directo es la única opción.
    console.error(
      "[JamBot/bootstrap] window.JamBot incompleto — core.js o features/* no se cargaron antes que contentScript.js. Revisar orden en manifest.json."
    );
    return;
  }

  const ctx = await JamBot.core.init();
  if (!ctx) {
    //core.init() devuelve null en dominios que no son la app del juego
    //(localStorage.game ausente o incompleto). Salimos en silencio: si
    //fuera realmente un problema, el usuario va a notar que no aparecen
    //los botones del bot.
    return;
  }
  ctx.core.log("bootstrap", "iniciando…");

  for (const [nombre, feature] of Object.entries(JamBot.features)) {
    if (!feature || typeof feature.init !== "function") continue;
    try {
      await feature.init(ctx);
      ctx.core.log("bootstrap", `feature '${nombre}' iniciada`, "ok");
    } catch (e) {
      ctx.core.logError("bootstrap", `feature '${nombre}' falló al inicializar`, e);
    }
  }
})();
