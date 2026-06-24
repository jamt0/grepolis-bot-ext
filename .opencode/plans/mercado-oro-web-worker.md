# Plan: Mercado de Oro — Web Worker + chrome.alarms

## Problema
1. **Throttling en background**: `setInterval` de 1s en `mercadoOro.js:1099` se throttea agresivamente cuando la pestaña está en background. Chrome puede demorar 30s+ entre polls. Múltiples `setInterval` activos amplifican el problema.
2. **Fetches secuenciales**: `ciclo()` polla mares secuencialmente con 300-600ms delay entre cada uno. Con 6 mares, cada ciclo dura ~3-4s — los últimos mares se pollan cada ~3-4s en vez de cada 1s. Empeora con más mares.

## Solución
Combinar **Web Worker** (timer preciso en thread separado) + **chrome.alarms** (safety net en background tabs) + **fetches paralelos** (cero delay entre mares).

---

## Archivos a modificar/crear

### 1. Crear `js/pollWorker.js` (nuevo)
Timer genérico que corre en su propio thread (no throttled por Chrome).

- Recibe `{action:"register", feature, intervalMs}` → crea timer con setTimeout recursivo + drift compensation
- Recibe `{action:"unregister", feature}` → elimina timer
- Recibe `{action:"unregisterAll"}` → limpia todo
- Envía `{type:"JamBot:workerTick", feature}` cuando cada timer vence
- Un solo Worker maneja timers de TODAS las features

### 2. Modificar `manifest.json`
- Agregar `/js/pollWorker.js` a `web_accessible_resources.resources`

### 3. Modificar `core.js`
En `init()`:
- Crear Worker: `new Worker(chrome.runtime.getURL("/js/pollWorker.js"))`
- Escuchar `worker.onMessage` → routear a callbacks registrados
- Exponer en `ctx.core`:
  - `registerPollTimer(feature, intervalMs, callback)` — registra timer
  - `unregisterPollTimer(feature)` — elimina timer
  - `unregisterAllPollTimers()` — limpia todos (para CAPTCHA/pausa)

### 4. Modificar `features/mercadoOro.js`
- **Eliminar** `setInterval` de línea 1099-1101
- **Agregar** al inicio de `init()`: `core.registerPollTimer("mercadoOro", POLL_INTERVAL_MS, ciclo)`
- **Agregar** cleanup: cuando `habilitada = false`, llamar `core.unregisterPollTimer("mercadoOro")`
- **Paralelizar** el loop de fetches en `ciclo()` (líneas 711-723):
  - Reemplazar `for` secuencial + `await` + `delay()` por `Promise.allSettled`
  - **Eliminar COMPLETAMENTE** el `delay(0.3 + Math.random() * 0.3)` — cero delay entre llamadas
  - Todas las requests se disparan **simultáneamente** en un solo tick
  - Un fetch fallido no bloquea a los demás (`Promise.allSettled`)
  - Resultado: ciclo de ~200-300ms (tiempo del fetch más lento, no la suma)

### 5. Modificar `background.js`
- Agregar const `ALARM_POLL_ORO = "mercadoOroPoll"`
- Agregar alarma de 30s en `asegurarAlarma()`
- En handler `chrome.alarms.onAlarm`: enviar `{type:"JamBot:pollMercadoOro"}` a tabs de Grepolis
- En `core.js`: escuchar `JamBot:pollMercadoOro` y ejecutar el ciclo de mercadoOro

---

## Flujo

### Foreground (pestaña activa)
```
Worker (thread separado) → postMessage("workerTick") → content script → ciclo()
~1s de precisión
```

### Background (pestaña inactiva)
```
Worker → postMessage (enqueued) → content script (~1-2s delay)
chrome.alarms (30s) → background.js → chrome.tabs.sendMessage → content script (fallback)
```

### CAPTCHA / Pausa
```
core.unregisterAllPollTimers() → Worker deja de enviar ticks
```

---

## Verificación
1. Abrir DevTools → pestaña "Oro" → verificar que el subtitle dice "poll cada 1s"
2. Cambiar de pestaña 30s+ → volver → verificar que los timestamps de la tabla se actualizaron
3. Pausar el bot → verificar que el polling se detiene
4. Activar CAPTCHA → verificar que el polling se detiene
5. Reanudar → verificar que el polling se reanuda
6. Con 6+ mares: verificar que TODOS los mares se pollan cada ~1s (no solo los primeros)
7. Con un mare caído (fetch falla): verificar que los demás mares siguen pollándose normalmente
