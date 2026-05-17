# Comercio — envío automático de recursos entre ciudades propias

Esta feature manda recursos entre ciudades propias en ciclo. El usuario define **grupos**: cada grupo tiene 1 destino, N fuentes, pesos por recurso, reserva por recurso e intervalo propio. Cada grupo tiene su propio scheduler — independiente entre sí y del resto del bot.

---

## 1. Concepto rápido

```
Grupo "Refuerzo capital"
  destino:  001 Jam M54
  fuentes:  002 Jam M55, 011 Jam M43, 015 Jam M51
  pesos:    wood=3  stone=1  iron=0
  reserva:  wood=0  stone=500 iron=0
  intervalo: 15s
  enabled: ON
```

Cada 15s (± jitter 15%), por cada fuente:

1. Lee del modelo `Town` (en MM) la `available_trade_capacity` del origen y la `resources` del destino.
2. Si el destino no tiene espacio para los recursos con peso > 0 → **omite el envío** (no se desperdicia).
3. Si la fuente no tiene comerciantes libres → saltea esa fuente este ciclo.
4. Reparte la capacidad libre del mercado de la fuente entre los 3 recursos según los pesos, respetando:
   - `stock - reserva` del origen,
   - `storage - resources[r]` del destino (espacio libre en almacén),
   - peso 0 = nunca mandar.
5. Si un recurso tope-toca antes de llegar a su objetivo proporcional, la capacidad sobrante se reparte entre los demás con peso > 0.
6. POST al endpoint del juego. Logea, persiste, decrementa localmente el espacio del destino para que la siguiente fuente no se pase, y sigue.

---

## 2. Endpoint del juego

Capturado de DevTools:

```
POST https://<world>.grepolis.com/game/town_info?town_id=<ORIGEN>&action=trade&h=<csrf>
Content-Type: application/x-www-form-urlencoded
body: json={"id":<DESTINO>,"wood":N,"stone":N,"iron":N,"town_id":<ORIGEN>,"nl_init":true}
```

Response (campos relevantes):

```json
{
  "json": {
    "success": "Los comerciantes se van con los recursos.",
    "notifications": [
      {
        "type": "backbone",
        "subject": "Town",
        "param_id": 1156,
        "param_str": "{\"Town\":{\"resources\":{...}, \"storage\":25500, \"max_trade_capacity\":9500, \"available_trade_capacity\":2031, ...}}"
      },
      {
        "type": "backbone",
        "subject": "Trade",
        "param_id": 118529,
        "param_str": "{\"Trade\":{\"id\":118529, \"origin_town_id\":1156, \"destination_town_id\":91, \"wood\":1137, \"stone\":0, \"iron\":0, \"started_at\":..., \"arrival_at\":..., \"cancelable\":true, ...}}"
      }
    ]
  }
}
```

Las notifications se reenvían al `JamBot:dispatchNotifications` del bridge → `model.set()` sobre `Town` (origen) y `Trade` (nuevo) → la UI del juego se actualiza sola.

**Heurística de CAPTCHA:** si `success` falta o si no llegan notifications `Trade` ni `Town`, se asume challenge y se llama `core.onCaptchaDetectado({feature:"comercio", ciudad:{id,nombre}})`. Patrón consistente con `recolección` y `ataques`.

---

## 3. Bridge (gameBridge.js)

La feature usa dos handlers del bridge — ambos ya están instalados en `js/gameBridge.js`:

- **`JamBot:queryTownResources`** (extendido):
  ```js
  postMessage({
    type: "JamBot:townResources",
    townId, resources, storage, maxTradeCapacity, availableTradeCapacity,
  })
  ```
  Lee del modelo `Town` en MM. Si el modelo no está cargado (ciudad no abierta y sin notifications recientes), los campos vienen como `null` — el feature hace 1 refetch de la collection `Towns` al inicio de cada ciclo para forzar la carga.

- **`JamBot:queryTrades`**:
  ```js
  postMessage({
    type: "JamBot:tradesResult",
    trades: [{ id, originTownId, originTownName, destinationTownId,
               wood, stone, iron, startedAt, arrivalAt, cancelable }],
  })
  ```
  Devuelve todos los `Trade` del jugador (filtrado por `origin_town_player_id`). La UI lo usa para listar comercios en vuelo.

---

## 4. Estructura de datos

`data.comercio` — bus de info de la feature, persistido en `chrome.storage.local` con key `jambotComercio_<world_id>`:

```js
{
  habilitada: false,                  // master switch
  grupos: [
    {
      id: "g-<random>",
      nombre: "Refuerzo capital",
      destinoTownId: 91,
      fuentes: [{ townId: 95 }, { townId: 102 }],
      pesos:   { wood: 3, stone: 1, iron: 0 },   // 0..100 por recurso
      reserva: { wood: 0, stone: 500, iron: 0 }, // piso mínimo en origen
      intervalSeg: 15,                          // 10..300
      enabled: true,
    },
    ...
  ],
  ultimoPorGrupoFuente: {
    [grupoId]: {
      [fuenteTownId]: { ts, sent:{wood,stone,iron}, viajeMs?, error? }
    }
  },
  ultimoCicloPorGrupo: {
    [grupoId]: { ts, motivo?, destinoLleno?, fuentes:[{townId, sent?, cap?, motivo?}] }
  },
  historial: [
    { ts, grupoId, grupoNombre, origenId, origenNombre,
      destinoId, destinoNombre, sent:{wood,stone,iron} }
  ],  // FIFO, cap 100
  uiState: { expandidos: {[grupoId]: bool}, mostrarHistorial: bool },
  tradesCache: { ts, trades:[...] },  // refresh cada 5s
}
```

Solo `habilitada`, `grupos`, `ultimoPorGrupoFuente` y `historial` se persisten. El resto es runtime.

---

## 5. Scheduler

Cada grupo activo tiene su propio `setTimeout`. `timersPorGrupo[grupoId]` guarda el handle.

- **Tick:** corre `ciclo(grupoId)` → refetch Towns → query destino → para cada fuente: query origen, calcular payload, POST trade, log.
- **Reagenda:** al final del `ciclo()`, otro `setTimeout(intervalSeg * 1000 ± 15%)`.
- **Anti-reentrada:** flag `ejecutandoCiclo[grupoId]` evita que un tick programado se solape si el envío tardó más que el intervalo.
- **Pause:** `cancelarTimers()` se llama en (a) toggle off del master, (b) toggle off del grupo, (c) `core.onCaptcha(true)`, (d) eliminar grupo.
- **Resume:** `reanudarTodos()` arranca cada grupo activo con `startDelay` aleatorio 0–3s para no salir en bloque.

**Independencia del play/pause global:** comercio tiene su propio master switch (`data.comercio.habilitada`), igual que `ataques`. No se ve afectado por el botón Iniciar/Detener de recolección.

---

## 6. Cálculo del payload

`calcularPayload(capacidad, pesos, topePorRecurso)` (función pura, dentro del feature):

```
tope[r] = max(0, min(stock[r] - reserva[r], espacioDestino[r]))   // calculado fuera

bucle distribución:
  sumaPesos = sum(pesos[r] for r in candidatos)
  para cada r en candidatos:
    objetivo[r] = floor(capRestante * pesos[r] / sumaPesos)
    agrega[r]   = min(objetivo[r], tope[r] - enviar[r])
    enviar[r] += agrega[r]
    si enviar[r] >= tope[r]: candidatos.delete(r)
  capRestante -= sum(agrega)
  repetir hasta capRestante=0 o candidatos=∅ (cap 6 iters)

pulido: si queda capRestante y candidatos con margen, llenar en orden
        de peso descendente (corrige redondeos)
```

Garantías:
- `enviar.wood + enviar.stone + enviar.iron <= capacidad`
- `enviar[r] <= topePorRecurso[r]` siempre
- `enviar[r] = 0` si `pesos[r] = 0`
- Función pura → puede testearse en aislamiento

---

## 7. UI

Tab "Comercio" en `#panelConfigJam`. Recoleccion la enchufa vía `renderTabComercioDelegado` que llama a `JamBot.features.comercio.api.renderTab(body)` (mismo patrón que ataques, defensa, oro).

Estructura:

- **Header master:** estado + botón Iniciar/Detener global.
- **Lista de grupos** (colapsables):
  - Header con nombre, destino, resumen, toggle ON/OFF, expand/collapse.
  - Body expandido: nombre / destino / intervalo / eliminar; pesos (sliders 0–100) + reserva por recurso; selector de fuentes (checkboxes multi-select con shortcut "Todas"/"Ninguna"); tabla de estado por fuente (capacidad libre actual, último envío, hace cuánto).
- **Botón "Nuevo grupo"** al final de la lista.
- **Tabla de comercios en vuelo** (modelo `Trade` desde MM, refresh cada 5s).
- **Historial** (FIFO, cap 100, toggle mostrar/ocultar + limpiar).

El renderTab respeta foco en inputs/selects (mismo skip-on-focus que ataques.js) para que el usuario pueda escribir sin perder el cursor cuando el body re-renderea cada 1s.

---

## 8. Casos manejados

- **Origen sin comerciantes libres** (`available_trade_capacity ≤ 0`): salta esa fuente este ciclo, log "sin comerciantes libres", reagenda normal.
- **Destino lleno** en los recursos con peso > 0: omite el ciclo entero, log "destino sin espacio en los recursos habilitados — ciclo omitido", reagenda normal.
- **Origen sin info en MM** (modelo Town no cargado, y tras refetch siguió sin venir): salta esa fuente. La ciudad se va a cargar al primer paseo del usuario o cuando llegue una notification.
- **CAPTCHA:** se detecta por response sin notifications `Trade`/`Town`. Dispara `core.onCaptchaDetectado`. El listener de `core.onCaptcha(true)` cancela todos los timers. Al `core.onCaptcha(false)` se reagendan.
- **Extensión recargada:** `core.isExtensionContextValid()` se chequea al inicio de cada `ciclo()` y antes de `refetchTowns()`. Si falló, el `setPaused(true)` del core ya detuvo el bot.
- **Grupo sin destino o sin fuentes:** el ciclo se reagenda sin hacer nada (no es un error).
- **Suma de pesos = 0** (todos en 0): `calcularPayload` devuelve `{0,0,0}`, log "nada para enviar", reagenda normal.

---

## 9. Integración

- **manifest.json:** `features/comercio.js` cargado antes de `contentScript.js`. Posición: después de `mercadoOro.js`.
- **Orden de inicialización:** `contentScript.js` itera `JamBot.features.*` en orden de inserción. Recolección va antes, así `data.ciudadesConAldeas` ya está poblado cuando el `init` de comercio corre.
- **Sin nuevos permisos:** usa las mismas APIs (`fetch`, `chrome.storage.local`, `postMessage`) que el resto del bot.
- **Versión del manifest:** bump 3.6 → 3.7.

---

## 10. Ver también

- [arquitectura.md](arquitectura.md) — bootstrap, ctx, comunicación entre worlds.
- [recoleccion.md](recoleccion.md) — patrón base del scheduler y panel.
- [persistencia.md](persistencia.md) — convenciones de `chrome.storage.local` namespaceado por mundo.
- [logging.md](logging.md) — convención de logs por feature.
