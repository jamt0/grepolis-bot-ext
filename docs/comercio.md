# Comercio — envío automático de recursos entre ciudades propias

Esta feature manda recursos entre ciudades propias en ciclo. El usuario define **grupos**: cada grupo tiene 1 destino, N fuentes, **un modo** (objetivo o proporcional), parámetros del modo, reserva por recurso e intervalo propio. Cada grupo tiene su propio scheduler — independiente entre sí y del resto del bot.

---

## 1. Concepto rápido

Dos modos por grupo:

**Modo Objetivo (default para grupos nuevos)** — el usuario fija "cuánto quiero tener en el destino" por recurso. El bot calcula el faltante y reparte la capacidad de cada fuente.

```
Grupo "Mantener capital llena"
  modo:      objetivo
  destino:   001 Jam M54
  fuentes:   002 Jam M55, 011 Jam M43, 015 Jam M51
  objetivo:  wood=cap  stone=cap  iron=0     (vacío en UI = "hasta cap del almacén")
  reserva:   wood=0    stone=500  iron=0
  intervalo: 15s
  enabled:   ON
```

**Modo Proporcional (legacy)** — el usuario fija pesos por recurso (0–100) y el bot reparte la capacidad de cada fuente proporcional a esos pesos. Útil cuando uno mueve excedente sin un objetivo concreto.

```
Grupo "Excedente al frente"
  modo:      proporcional
  pesos:     wood=3  stone=1  iron=0   (peso 0 = nunca mandar)
  reserva:   wood=0  stone=500 iron=0
  ...
```

### Algoritmo del ciclo (cada `intervalSeg` ± 15% jitter)

1. `refetchTowns()` para tener `resources/storage` frescos en MM.
2. `queryTown(destino)` y `queryTrades()` → `incoming = Σ trades.destinoTownId == destino`.
3. Calcular **objetivo por recurso**:
   - Modo objetivo: `grupo.objetivo[r] ?? storage_cap` (null = "hasta cap").
   - Modo proporcional: `storage_cap` (siempre — los pesos controlan el reparto).
4. **Espacio libre** efectivo: `max(0, objetivo[r] - resources_dest[r] - incoming[r])`.
   - Descontar `incoming` es crítico: sin esto, ciclos consecutivos disparan envíos que al llegar topan el almacén y se pierde el excedente. Aplica a ambos modos.
5. Si el espacio relevante (recursos activos en este modo) es 0 → **omite el ciclo**, reagenda.
6. Pre-query `queryTown` paralelo de todas las fuentes (lectura barata del cache MM).
7. **Orden de fuentes** (solo modo objetivo):
   - Saturadas primero — `≥ SATURACION_MIN_RECURSOS` recursos al `≥ SATURACION_PCT * storage_cap`. Libera espacio que recolección va a re-llenar gratis.
   - Después por `viajeMs` cacheado ASC (más cercanas primero, menos tiempo con comerciantes ocupados en ruta).
   - Tiebreaker: orden de config.
   - Modo proporcional preserva orden de config (no se ordena).
8. Loop fuentes:
   - `tope[r] = max(0, min(stock - reserva_origen, espacio_destino))`.
   - Modo objetivo: `calcularPayloadObjetivo(cap_mercado, tope)` — reparte proporcional al faltante.
   - Modo proporcional: `calcularPayload(cap_mercado, pesos, tope)` — reparte por pesos.
   - Si payload > 0 → POST `trade`, log, **cachea `viajeMs` por fuente**, decrementa espacio del destino local.
   - Modo objetivo: si el faltante total llega a 0 → `break` (no procesa fuentes restantes).

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
    islandId, marketLevel,
  })
  ```
  Lee del modelo `Town` en MM. Si el modelo no está cargado (ciudad no abierta y sin notifications recientes), los campos vienen como `null` — el feature hace 1 refetch de la collection `Towns` al inicio de cada ciclo para forzar la carga.

  - `islandId`: id de la isla. Lo usa el gating inter-isla del comercio.
  - `marketLevel`: nivel actual del mercado, o `null` si no pudimos detectarlo. El bridge prueba varios shapes (`town.getBuildingLevel("market")`, `attributes.buildings.market`, `attributes.building_market`) porque la API interna del cliente puede variar entre versiones del juego. Si todos fallan queda `null` y comercio NO pre-filtra (deja al server rechazar).

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
      modo: "objetivo",                          // "objetivo" | "proporcional"
                                                 // grupos sin campo (pre-v3.8) → "proporcional" (backwards-compat)
      objetivo: { wood: null, stone: null, iron: 0 },  // por recurso: null = "hasta cap del almacén",
                                                       // 0 = "no mandar este recurso", N = "hasta N"
                                                       // solo aplica si modo === "objetivo"
      pesos:   { wood: 3, stone: 1, iron: 0 },   // 0..100 — solo aplica si modo === "proporcional"
      reserva: { wood: 0, stone: 500, iron: 0 }, // piso mínimo en origen (ambos modos)
      viajeMsPorFuente: { 95: 12000, 102: 47000 }, // cache de viajeMs origen→destino,
                                                   // poblado tras cada envío OK.
                                                   // Usado como proxy de distancia para ordenar
                                                   // fuentes en modo objetivo. Fuentes sin cache
                                                   // van al final (Infinity).
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
    [grupoId]: {
      ts, modo, motivo?, destinoLleno?,
      incoming?: {wood,stone,iron},   // trades en vuelo hacia destino al inicio del ciclo
      fuentes: [{ townId, sent?, cap?, motivo?, saturada? }]
    }
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

**Decisión de default por modo:** grupos nuevos se crean en `"objetivo"` porque el caso de uso típico es "mantener llena esta ciudad". Grupos cargados del storage sin campo `modo` (versión anterior) caen a `"proporcional"` para preservar exactamente su comportamiento anterior — `normalizarGrupo` no migra entre modos.

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

Dos funciones puras dentro del feature, una por modo. El tope se calcula fuera y se les pasa idéntico:

```
tope[r] = max(0, min(stock_origen[r] - reserva_origen[r],
                     espacioDestino[r]))   // ver §6.1
```

### 6.1. Espacio del destino (común a ambos modos)

```
trades   = queryTrades()
incoming = Σ trades.wood/stone/iron donde destinationTownId == grupo.destinoTownId

objetivoPorRecurso[r] = grupo.modo === "objetivo"
                          ? (grupo.objetivo[r] ?? storage_cap)
                          : storage_cap

espacioDestino[r] = max(0, objetivoPorRecurso[r] - resources_destino[r] - incoming[r])
```

El descuento de `incoming` evita el overshoot clásico: sin él, cap=30k + recursos=13k + en_vuelo=5k → bot "ve" 17k libres → manda 17k → llegan 22k → sobran 5k. Con descuento: espacio efectivo = 12k.

### 6.2. `calcularPayloadObjetivo(capacidad, topePorRecurso)` — modo objetivo

Reparte la capacidad del mercado **proporcional al faltante** de cada recurso (no por pesos ni equitativo):

```
candidatos = {r : tope[r] > 0}

bucle distribución (cap 6 iters):
  para cada r en candidatos:
    faltante[r] = tope[r] - enviar[r]
  sumaFaltante = Σ faltante
  para cada r en candidatos:
    obj         = floor(capRestante * faltante[r] / sumaFaltante)
    agrega[r]   = min(obj, faltante[r])
    enviar[r] += agrega[r]
  capRestante -= Σ agrega
  cortar si capRestante=0 o nadie cambió

pulido: si sobra capacidad, llenar en orden de mayor faltante restante
```

Garantías:
- `Σ enviar <= capacidad`, `enviar[r] <= tope[r]`.
- Si `tope[r] = 0` (incluyendo `objetivo[r] = 0`), `enviar[r] = 0`.

### 6.3. `calcularPayload(capacidad, pesos, topePorRecurso)` — modo proporcional

Sin cambios respecto a v3.7. Reparte la capacidad **proporcional a los pesos**, `peso 0` excluye el recurso, redistribución cuando alguien tope-toca, pulido final por peso descendente.

### 6.4. Orden de fuentes

Solo modo objetivo ordena fuentes. Modo proporcional preserva orden de config (comportamiento histórico).

```
sort(fuentes, por:
  1. esOrigenSaturado(info) DESC      // saturadas primero (libera espacio que recolección re-llena)
  2. viajeMsPorFuente[id] ASC          // cercanas primero (cache poblada tras cada envío OK)
  3. idxConfig ASC                     // tiebreaker estable
)
```

`esOrigenSaturado(townInfo)` = `≥ SATURACION_MIN_RECURSOS (2)` recursos al `≥ SATURACION_PCT (95%)` del cap del almacén. Umbrales conservadores: 95% (no 100%) porque ya hay desperdicio por encima; 2-de-3 (no 3-de-3) porque madera satura primero — esperar a los 3 al tope hace que la heurística nunca dispare.

Modo objetivo además hace **early-exit** del loop cuando `Σ espacioDestino = 0` (faltante cubierto). No procesa fuentes restantes — minimiza la cantidad de envíos.

---

## 7. UI

Tab "Comercio" en `#panelConfigJam`. Recoleccion la enchufa vía `renderTabComercioDelegado` que llama a `JamBot.features.comercio.api.renderTab(body)` (mismo patrón que ataques, defensa, oro).

Estructura:

- **Header master:** estado + botón Iniciar/Detener global.
- **Lista de grupos** (colapsables):
  - Header con nombre, destino, resumen (cantidad de fuentes · intervalo · resumen del modo `obj wood/stone/iron` o `pesos w/s/i`), toggle ON/OFF, expand/collapse.
  - Body expandido:
    1. nombre / destino / intervalo / eliminar.
    2. **Selector de modo** (Objetivo / Proporcional) con tooltip de cada modo.
    3. **Si modo Objetivo**: 3 inputs de objetivo por recurso (vacío = "hasta cap del almacén", 0 = "no mandar este recurso") + reserva por recurso. Atajo "Hasta cap" que pone los 3 en `null`.
    4. **Si modo Proporcional**: sliders de peso 0–100 por recurso + reserva por recurso (UI legacy sin cambios).
    5. Selector de fuentes (checkboxes multi-select con shortcuts "Todas"/"Ninguna").
    6. Tabla de estado por fuente (capacidad libre actual, último envío, hace cuánto).
- **Botón "Nuevo grupo"** al final de la lista (grupos nuevos arrancan en modo Objetivo con `objetivo = {null, null, null}` — "hasta cap en los 3").
- **Tabla de comercios en vuelo** (modelo `Trade` desde MM, refresh cada 5s).
- **Historial** (FIFO, cap 100, toggle mostrar/ocultar + limpiar).

El renderTab respeta foco en inputs/selects (mismo skip-on-focus que ataques.js) para que el usuario pueda escribir sin perder el cursor cuando el body re-renderea cada 1s.

---

## 8. Casos manejados

- **Origen con mercado <5 enviando a otra isla**: el server rechaza el envío inter-isla si el mercado del origen es nivel <5. El feature pre-filtra cuando puede leer `marketLevel` del bridge — salta la fuente con motivo `mercado nivel N — no puede enviar entre islas (requiere ≥5)`. Si `marketLevel` viene `null` (versión del cliente que no expone el shape esperado), no pre-filtra y el server hace el gating (queda registrado como error en el log de esa fuente).
- **Origen sin comerciantes libres** (`available_trade_capacity ≤ 0`): salta esa fuente este ciclo, log "sin comerciantes libres", reagenda normal.
- **Destino en objetivo** (modo objetivo): si después de descontar `incoming` el espacio de cada recurso activo es 0, omite el ciclo entero, log "destino ya en objetivo (contando trades en vuelo) — ciclo omitido". El próximo ciclo evalúa de nuevo cuando recursos se gastan o los trades llegan.
- **Destino lleno** (modo proporcional): mismo flujo que arriba, log "destino sin espacio en los recursos habilitados — ciclo omitido".
- **Faltante cubierto en mid-ciclo** (modo objetivo): el loop hace early-exit cuando `Σ espacioDestino = 0` y skipea las fuentes restantes del orden — minimiza la cantidad de envíos.
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
