# Feature — Recolección de recursos

La feature principal del bot. Implementada en [`features/recoleccion.js`](../features/recoleccion.js).

---

## 1. Qué hace

Cada **5 o 10 minutos** (configurable por ciudad), recorre todas las ciudades del jugador y, en cada una, claimea sus 6 aldeas farmeables. Usa siempre la opción "Recoger" rápida (`option=1` en el endpoint).

---

## 2. Endpoint

Capturado del click manual en el botón "Recoger" del juego:

```
POST https://<world>.grepolis.com/game/frontend_bridge?town_id=<TOWN>&action=execute&h=<csrf>
Content-Type: application/x-www-form-urlencoded

json={
  "model_url":   "FarmTownPlayerRelation/<RELATION_ID>",
  "action_name": "claim",
  "captcha":     null,
  "arguments":   { "farm_town_id": <ALDEA_ID>, "type": "resources", "option": 1 },
  "town_id":     <TOWN>,
  "nl_init":     true
}
```

**Respuesta normal** (claim exitoso):
- `success`: `true`
- `notifications[]`: incluye `{subject:"Town", param_str:"{...resources...}"}` con los recursos actualizados de la ciudad y un campo `last_*` que es el storage máximo.

**Respuesta de rechazo**:
- `success`: `false` → cooldown server vivo, rate limit, o error inesperado.
- Si la respuesta tiene `success:true` pero **falta** la notification `Town` → es una señal de CAPTCHA encubierto.

---

## 3. Modelo de datos del ciclo

### `recolectarRecursos()` — punto de entrada
1. Incrementa `nCiclo` (contador local de la sesión).
2. Inicializa `cicloActual` con esqueleto: `{n, inicio, ciudades:{...}, totalCiudades, totalAldeas, ciudadesCompletadas:0, aldeasCompletadas:0}`.
3. Llama `recolectarCiudades()` (procesa todo).
4. Promueve `cicloActual` → push a `ciclos[]` (FIFO max 36) → persiste.
5. Calcula `tiempoEspera` (ver §6) y programa el próximo tick.

### `recolectarCiudades()` — orquesta ciudades
1. Loguea separador violeta `═══ CICLO #N ═══`.
2. Refresca el baseline de recursos por ciudad (consultando `MM` vía bridge) — sin esto el primer claim arrastra 5-10 min de producción.
3. Ordena ciudades por `localeCompare(numeric)` → "001 Jam" < "002 Jam" < "010 Jam".
4. Para cada ciudad: separador azul + `recolectarCiudad(ciudad, ..., pendientes)`.
5. Después del loop principal: **retry diferido** sobre `pendientes` (max 3 intentos × 5s entre rondas).
6. Imprime resumen por ciudad (verde si 6/6, rojo `core.logError` si menos).
7. Retorna `{proximaLiberacionSeg}` para que `recolectarRecursos` ajuste el próximo tick.

### `recolectarCiudad()` — orquesta aldeas
1. `cooldownMs = minutos * 60 * 1000 + 5 * 1000` (margen +5s, ver §5).
2. Mezcla aldeas con shuffle (anti-bot — el orden de aldeas dentro de una ciudad NO es predictible).
3. Por cada aldea, **gating de cooldown** (ver §4).
4. Si pasa el gating, llama `recolectarAldea()`.
5. Trackea fallos en `pendientes` para retry diferido.

### `recolectarAldea()` — un claim concreto
Retorna `{status: "ok" | "reintentar" | "descartar"}`:

| Path | Status | Acción |
|------|--------|--------|
| `recursosLlenos === true` | `descartar` | Salta sin pegarle al server. Loguea warning. |
| `relationId == null` | `descartar` | Aldea conocida pero sin `FarmTownPlayerRelation` activa (huérfana). Loguea warning. |
| `success: false` del server | `reintentar` | Va al retry diferido. Loguea con cuerpo de respuesta. |
| Sin notification `Town` en la respuesta | `descartar` | Probable CAPTCHA. Dispara `core.onCaptchaDetectado()`. |
| OK | `ok` | Loguea claim, actualiza `lastClaimAtPorAldea[id]`, persiste. |

---

## 4. Gating de cooldown (lo más importante)

Antes de pegarle al server por una aldea, el bot decide si esperar. Hay **dos fuentes** de "cuándo está lista esta aldea":

### Fuente A — `lastClaimAtPorAldea[id]` (memoria + `chrome.storage.local`)
- Timestamp del último claim exitoso del bot. Persistido en `jambotLastClaimAt_${world_id}`.
- Después del cooldown configurado de la ciudad (5 o 10 min) + 5s de margen, la aldea está disponible.
- **Sobrevive a reload**: el bot recuerda cuándo claimeó cada aldea aunque cierres y abras la pestaña.

### Fuente B — `aldea.loot` del server (al boot)
- Timestamp Unix en segundos que viene del endpoint `island_info` (campo `loot` de cada aldea en `farm_town_list`).
- Indica **cuándo el server libera la aldea** para el próximo claim.
- Útil cuando `lastClaimAtPorAldea` está vacío (e.g. primer ciclo después de instalar la extensión, o si el storage se borró). Sin esto el bot dispararía todas las aldeas y se comería un `success:false` por cada una.

### Lógica combinada en `recolectarCiudad`

```js
for (const aldea of shuffle(aldeas)) {
  const last = lastClaimAtPorAldea[aldea.id] || 0;
  const transcurrido = Date.now() - last;

  // Fuente B — solo si nunca claimeamos esta aldea en la sesión
  if (last === 0 && aldea.loot) {
    if (aldea.loot * 1000 > Date.now()) { saltar; continue; }
  }

  // Fuente A
  if (last > 0 && transcurrido < cooldownMs) { saltar; continue; }

  // Procede
  await recolectarAldea(...);
}
```

---

## 5. Margen de +5s en `cooldownMs`

```js
const cooldownMs = minutos * 60 * 1000 + 5 * 1000;
```

Antes restábamos 30s ("para no saltar una aldea casi vencida"). Eso era el bug: pegábamos al server **antes** que liberara el cooldown y comíamos `success:false` silenciosos. El claim no se hacía y `lastClaimAtPorAldea` no se actualizaba — la aldea quedaba esperando otro ciclo entero.

Con +5s pegamos **después** de que el server liberó. Costo: ~1.7% de yield en ciudades de 5min, ~0.8% en las de 10min. Cubre:
- Drift de reloj entre cliente y server (típico < 2s)
- Latencia round-trip de la request (50-300 ms)
- Jitter del `setTimeout` del navegador (peor caso: pestaña en background)

---

## 6. Cadencia entre claims

```js
await delayMs(jitter(2000, 2500));  // 2-2.5s entre claim y claim
```

Más conservador que 1-1.5s anterior. Razones:
- Reduce presión sobre el server (menos `success:false` por rate limit encubierto).
- Reduce errores de hidratación del cliente del juego cuando llegan notifications muy seguidas.
- Variabilidad ±25% mantiene la huella anti-bot.
- Costo: ~17s extra de duración por ciclo (con 18 aldeas). Despreciable vs cooldown de 5/10 min.

---

## 7. Scheduler del próximo tick

En `recolectarRecursos`, después de procesar todo:

```js
const baseMs = tiempoCicloMinutos() * 60 * 1000;  // 5 o 10 min según config

// CAPTCHA pendiente → NO se programa siguiente tick. El bot queda
// esperando al humano; cuando aprieta "Ya resolví" en el cartel, la
// sincronización post-captcha llama a programarSiguienteTick(~2s) para
// retomar el ciclo (ver §10).
if (core.isCaptchaActive()) return;

let esperaAjustada = baseMs - duracionCiclo + jitter(3-30s);

// Adelantar si hay aldeas listas antes del intervalo normal
if (stats.proximaLiberacionSeg < ∞) {
  const esperaServer = stats.proximaLiberacionSeg * 1000 + 5000;
  if (esperaServer < esperaAjustada) esperaAjustada = esperaServer;
}

tiempoEspera = Math.max(30 * 1000, esperaAjustada);   // piso 30s
```

**Compensación de duración**: el próximo tick arranca al MISMO instante (en promedio) que el actual + `baseMs`, no al fin del actual + `baseMs`. Sin esto, cada vuelta acumularía `duracionCiclo` (~30s) como gap permanente vs el cooldown del server.

**Adelantar** (clave después de un reload): si en este ciclo todas las aldeas estaban en cooldown y la próxima se libera en 4 min, no esperamos 10 min — adelantamos a 4m05s. Recuperamos yield perdido por el reload.

---

## 8. Retry diferido (max 3 intentos)

Las aldeas que retornan `status: "reintentar"` (server `success:false`) se acumulan en `pendientes`. Después del loop principal:

```js
while (pendientes.length > 0 && !captcha && !pausado) {
  const ronda = pendientes;
  pendientes = [];
  await delayMs(5000);  // 5s entre rondas — le da aire al server

  for (const item of ronda) {
    if (item.intentos >= 3) {
      core.logError("descartada tras 3 intentos sin éxito");
      continue;
    }
    const r = await recolectarAldea(...);
    if (r.status === "ok") { lastClaimAt = Date.now(); persistir(); }
    else if (r.status === "reintentar") {
      pendientes.push({ ...item, intentos: item.intentos + 1 });
    }
    // status === 'descartar' → no reintentamos
  }
}
```

---

## 9. AbortController + watchdog

### AbortController de 30s en el fetch
Sin esto, un fetch que nunca resuelve (TCP sin respuesta) bloquea el ciclo entero — `setTimeout` nunca arranca y el bot "se para solo".

```js
const ctrl = new AbortController();
const abortId = setTimeout(() => ctrl.abort(), 30000);
try { response = await fetch(url, { signal: ctrl.signal, ... }); }
finally { clearTimeout(abortId); }
```

`AbortError` cae en el catch del caller (`recolectarCiudad`) → registrado como retry transitorio.

### Watchdog del scheduler
Si `programarSiguienteTick(ms)` arma un timeout de `ms`, también arma un timeout de respaldo de `ms × 2 + 60000`:

```js
setTimeout(() => {
  if (!core.isPaused() && proximoTickId == null) {
    core.logWarn("watchdog: el ciclo no arrancó — relanzando");
    recolectarRecursos();
  }
}, ms * 2 + 60_000);
```

Cubre cualquier escenario donde el `setTimeout` principal no dispare (Chrome throttle agresivo en background, error no manejado, etc.).

---

## 10. Anti-CAPTCHA

### Detección
Hay 2 vías:

1. **Polling de `Game.bot_check`** (`gameBridge.js`): cada 2s, si `Game.bot_check` cambia de null a object, dispara `JamBot:captchaState`. → `core.onCaptchaDetectado()` (sin contexto).
2. **Heurística post-claim** (la más útil): si la respuesta del fetch de claim no trae notification `Town`, asumimos CAPTCHA. La feature dispara `core.onCaptchaDetectado({ ciclo, ciudad, aldea })` con el contexto del fallo, y al romper el loop del ciclo agrega las aldeas pendientes que quedaron sin procesar.

### Comportamiento durante CAPTCHA pendiente

El flujo viejo (probes cada 30s) generaba un bucle: cada probe disparaba un nuevo CAPTCHA. El nuevo flujo es **explícitamente humano-en-el-loop**:

1. **Bot detenido** — no se programa siguiente tick. No hay probes.
2. **Cartel grande** arriba del tab Recolección con: ciclo, ciudad/aldea que falló, lista de aldeas pendientes en cola, countdown del timeout (10 min) y botón "Ya resolví".
3. **Pulpo** (card flotante en la esquina inferior izquierda) cambia a ⚠ rojo + nombre de la aldea sugerida; click abre el panel directamente en Recolección.
4. **Flash del título** de la pestaña + bip de audio (igual que antes).
5. El bridge sigue vigilando `Game.bot_check`. Cuando el humano resuelve el CAPTCHA del juego y `bot_check` vuelve a `null`, **NO** se reanuda automáticamente — solo se prende un flag `resueltoEnJuego` que pinta el cartel de verde y resalta el botón. El usuario tiene control explícito.

### Resolución por el usuario

Click en "Ya resolví" → `resolverCaptchaPorUsuario()`:

1. Refetch `island_info` de cada ciudad → lee el campo `loot` (timestamp Unix sec del próximo claim disponible) de cada aldea.
2. **Reconcilia gaps** con `lastClaimAtPorAldea`: si `loot - now ≈ cooldown - (now - lastClaimAt)` (±90s), el claim ya está registrado por el bot. Si no coincide, el HUMANO claimeó esa aldea — inferimos el ts del claim como `loot - cooldown` y lo guardamos en `lastClaimAtPorAldea`. Esto evita que el bot pegue al server antes del cooldown real (cada aldea con su propio ts, aunque el humano las haya claimeado con varios minutos de diferencia).
3. `core.onCaptchaResuelto()` → cierra el estado captcha.
4. `programarSiguienteTick(~2s)` → tick inmediato para procesar lo que falte del ciclo.

### Timeout (10 min)

Si el humano no apreta "Ya resolví" en 10 min, entramos en estado `"timeout"`:
- `core.onCaptchaTimeout` dispara → la feature de recolección llama `core.setPaused(true)` para detener el bot.
- El cartel cambia a gris con el texto "TIMEOUT — bot detenido".
- El botón Iniciar del header se habilita (en `pending` está bloqueado). Apretarlo limpia el estado captcha (`core.onCaptchaResuelto`) y arranca un ciclo nuevo. Los cooldowns por aldea siguen vivos en `lastClaimAtPorAldea` — no se pierde sincronización.

---

## 11. Persistencia (resumen)

Ver [persistencia.md](persistencia.md) para el detalle completo. Lo que toca esta feature:

| Clave (en `chrome.storage.local`) | Contenido |
|-----------------------------------|-----------|
| `jambotConfig` | Config por ciudad (5/10 min) + toggle finalizar gratis. Global. |
| `jambotLastClaimAt_${world_id}` | Map `{aldeaId: timestamp}`. |
| `jambotHistorial_${world_id}` | `{porAldea: {aldeaId: [36 entradas]}, ciclos: [36 ciclos]}`. |

---

## 12. Ver también

- [arquitectura.md](arquitectura.md) — visión general.
- [panel.md](panel.md) — la UI que muestra todo este estado.
- [persistencia.md](persistencia.md) — formatos de storage.
- [logging.md](logging.md) — los `core.log/logWarn/logError` que se usan en todo el archivo.
