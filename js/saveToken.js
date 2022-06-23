window.postMessage(
  {
    type: "FROM_PAGE",
    h_token: Game.csrfToken,
    world_id: Game.world_id,
    townId: Game.townId,
  },
  "*"
);
