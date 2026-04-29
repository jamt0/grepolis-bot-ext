//Solo corre dentro de la app del juego (donde existe `window.Game`). En
//subdominios sin esa global (foro, wiki, landing) salimos en silencio para
//no spamear la consola con ReferenceError.
(function () {
  if (typeof Game === "undefined" || !Game) return;

  console.log("Cargando variable game...");
  console.log({ Game });

  const payload = {
    csrfToken: Game.csrfToken,
    world_id: Game.world_id,
    townId: Game.townId,
    player_id: Game.player_id,
  };

  window.postMessage({ type: "FROM_PAGE", ...payload }, "*");
  window.localStorage.setItem("game", JSON.stringify(payload));

  console.log("Enviado");
})();
