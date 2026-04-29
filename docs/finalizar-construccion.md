# Feature — Finalizar construcción gratis (<5min)

Replica la mecánica nativa del juego: el botón "Gratis" que aparece en la cola cuando a una orden le quedan menos de 5 minutos.

---

## 1. Qué hace

Cada ciclo, el bot:

1. Lee la cola de construcción de **todas** las ciudades del jugador.
2. Para cada orden con `to_be_completed_at - now ≤ 290s`, dispara la finalización gratis (`buyInstant`).
3. Reagenda el siguiente ciclo en función de la próxima orden que entre en ventana (mín. 30s, fallback 5min si no hay nada cerca).

El margen de 290s (vs 300 reales) evita race conditions con el reloj del servidor — ajustable vía `data.tiempoRestanteMaxSegundos`.

---

## 2. Endpoint

Capturado del click manual en el botón "Gratis":

```
POST https://<world>.grepolis.com/game/frontend_bridge?town_id=<TOWN>&action=execute&h=<csrf>
Content-Type: application/x-www-form-urlencoded

json={
  "model_url":   "BuildingOrder/<ID>",
  "action_name": "buyInstant",
  "captcha":     null,
  "arguments":   { "order_id": <ID> },
  "town_id":     <TOWN>,
  "nl_init":     true
}
```

**Response relevante**:
- `success`: `"La construcción se ha completado correctamente."`
- `costs`: `0` (gratis dentro de la ventana).
- `notifications[]`: actualizaciones de cada `BuildingOrder` restante en la cola (con sus nuevos `to_be_completed_at` recalculados) + `BuildingBuildData` con el estado del edificio.

Las `notifications` se reenvían al bridge (`JamBot:dispatchNotifications`) para que los modelos Backbone se actualicen y la UI del juego refleje el cambio sin recargar.

---

## 3. Soporte multi-ciudad

**Problema**: MM solo carga las `BuildingOrder` de la ciudad activa. Las otras 29 (en una cuenta de 30 ciudades) no están en memoria.

**Solución**: refetch HTTP por ciudad usando el mismo patrón que [`obtenerMapaRelaciones`](../features/recoleccion.js#L36) en recoleccion:

```
GET .../frontend_bridge?town_id=<TOWN>&action=refetch
   &json={"collections":{"BuildingOrders":[]},"town_id":<TOWN>,"nl_init":false}
```

Lista de ciudades: se reusa `data.ciudadesConAldeas` que recoleccion ya pobla en su init (el bootstrap garantiza que recoleccion corre antes).

**Anti-detección**:
- `shuffle` del orden de consulta de las ciudades.
- `jitter(300, 800)ms` entre fetches de cola.
- `shuffle` también del orden en que se disparan las finalizaciones.
- `jitter(1000, 1500)ms` antes de cada `buyInstant` (alineado con recoleccion).
- Corte inmediato si el bridge detecta CAPTCHA (`Game.bot_check`).
- Corte inmediato si el usuario pausa o deshabilita la feature mid-tanda.

Costo total para 30 ciudades: ~9-24s de fetches por ciclo. El scheduler reagenda solo en función de la próxima orden cercana, así que en estado estable hay un ciclo cada ~5min.

---

## 4. Configuración

La feature se habilita/deshabilita desde el toggle **"Finalizar construcción gratis"** del panel ⚙ (gestionado por [recoleccion.js](../features/recoleccion.js)). El estado se persiste en `chrome.storage.local`:

```js
{
  jambotConfig: {
    porCiudad: { ... },
    finalizarHabilitado: true   // ← este flag
  }
}
```

**Flujo de carga**:

1. En `init()`, la feature lee `chrome.storage.local.jambotConfig.finalizarHabilitado`.
2. Si no existe (primera carga o nunca tocaron el toggle), cae al default de [data.json](../data.json) → `data.finalizarGratis === true`.
3. Se suscribe a `chrome.storage.onChanged` para reaccionar cuando el usuario cambia el toggle. La función `reconciliar()` arranca/cancela el ciclo según `habilitada && !core.isPaused()`.

**Defaults en [data.json](../data.json)**:

```json
{
  "finalizarGratis": true,
  "tiempoRestanteMaxSegundos": 290
}
```

- `finalizarGratis` → valor default si el toggle del panel nunca se tocó.
- `tiempoRestanteMaxSegundos` → ventana en segundos (default 290).

A diferencia de antes, **la feature siempre se inicia** (registra listeners). Si está deshabilitada solo no programa ciclos hasta que se active.

---

## 5. UI

**No hay botón propio**. El control unificado de play/pause vive en `core.js` ([core.js:107-150](../core.js#L107-L150)) y se manifiesta como el botón `▶/⏸/⚠` que `recoleccion` registra. Ese botón controla **todas** las features.

El estado de finalizar se ve en dos lados del panel ⚙:

- **Header del panel** (común a todas las features): muestra `Estado: ▶ Pausado / ⏸ Corriendo / ⚠ CAPTCHA`.
- **Sección Funciones**: checkbox `Finalizar construcción gratis` que habilita/deshabilita la feature.

Sin click manual de "forzar ciclo": el ciclo arranca automáticamente cuando se cumplen `habilitada && !core.isPaused()` — ya sea por el toggle, por el play global, o por una resolución de CAPTCHA.

---

## 6. Detección de CAPTCHA

A diferencia de los claims de farm, la response de `buyInstant` **no incluye** una notification `Town`, así que la heurística "no Town = CAPTCHA" no aplica acá. La detección sigue viniendo del polling de `Game.bot_check` que ya hace [gameBridge.js](../js/gameBridge.js).

Cuando se detecta CAPTCHA durante un ciclo:
- Se aborta la consulta de colas o el barrido de finalizaciones.
- El siguiente tick se programa a 30s (en vez del fallback de 5min) para detectar la resolución rápido.

---

## 7. Punto frágil — nombre de la colección

`NOMBRE_COLECCION = "BuildingOrders"` (plural, asumido por simetría con `Towns`/`FarmTownPlayerRelations`). No verificado en una sesión real con cola activa.

**Si el log muestra `0 con órdenes` en todas las ciudades teniendo órdenes activas**:
1. Abrir una ciudad cualquiera en el juego.
2. DevTools → Network → filtrar `refetch`.
3. Ver el JSON de la request: dentro de `"collections":{ "<NOMBRE>": [] }`.
4. Cambiar la constante en [features/finalizarConstruccion.js](../features/finalizarConstruccion.js).

---

## 8. Archivos tocados

| Archivo | Cambio |
|---|---|
| [features/finalizarConstruccion.js](../features/finalizarConstruccion.js) | Feature completa (sin botón propio: se controla por el play/pause global de core + el toggle del panel ⚙). |
| [core.js](../core.js) | API global `isPaused / onPlayPauseChange / setPaused / togglePlayPause` que ambas features consumen. |
| [features/recoleccion.js](../features/recoleccion.js) | Panel ⚙ hospeda el toggle `Finalizar construcción gratis` (lo persiste en `chrome.storage.local.jambotConfig.finalizarHabilitado`). `guardarConfigPorCiudad` hace merge para no pisar la clave del toggle. |
| [data.json](../data.json) | Flags de config (defaults). |
| [manifest.json](../manifest.json) | Carga del nuevo JS. |
| [contentScript.js](../contentScript.js) | Bootstrap genérico (itera `JamBot.features`). |

**Comunicación inter-feature**:
- Play/pause global → `core.onPlayPauseChange` (suscripto por ambas features).
- Toggle de habilitar finalizar → `chrome.storage.onChanged` (escrito por el panel en recoleccion, leído por finalizar).

Sin cambios funcionales en el bridge (el handler `queryBuildingQueue` que se agregó al bridge se removió al pasar a HTTP refetch — no quedó dead code).
