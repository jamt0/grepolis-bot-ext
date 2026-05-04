# Arquitectura — Grepolis JamBot

Overview general de cómo está armada la extensión. Cada feature técnica tiene su propio doc; este archivo conecta las piezas.

---

## 1. Diagrama mental

```
┌─────────────────────────────────────────────────────────────────────┐
│                    Página de Grepolis (es144.grepolis.com)          │
│                                                                     │
│  ┌──────────────────┐       ┌──────────────────────────────────┐    │
│  │  PAGE CONTEXT    │       │  CONTENT-SCRIPT WORLD (aislado)  │    │
│  │                  │       │                                  │    │
│  │  window.Game     │       │   contentScript.js               │    │
│  │  window.MM       │       │     bootstrap → core.init()      │    │
│  │  Backbone models │       │     → features[*].init(ctx)      │    │
│  │                  │       │                                  │    │
│  │  saveToken.js  ──┼──────▶│   core.js                        │    │
│  │  gameBridge.js ◀─┼──────▶│     log/logWarn/logError         │    │
│  │   (postMessage   │       │     captcha state                │    │
│  │    + Custom-     │       │     play/pause global            │    │
│  │    Events)       │       │     UI (botones, panel)          │    │
│  │                  │       │                                  │    │
│  │                  │       │   features/recoleccion.js        │    │
│  │                  │       │     scheduler + cooldown +       │    │
│  │                  │       │     retry + persistencia         │    │
│  │                  │       │                                  │    │
│  │                  │       │   features/finalizarConstruccion │    │
│  │                  │       │     scheduler propio + cola HTTP │    │
│  └──────────────────┘       └──────────────────────────────────┘    │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 2. Archivos y responsabilidades

| Archivo | Rol |
|---------|-----|
| `manifest.json` | Manifest V3. Declara permisos, content scripts, web_accessible_resources. |
| `core.js` | Estado compartido, helpers de logging, detección de CAPTCHA, play/pause global, UI de botones, init del ctx. **No conoce features.** |
| `contentScript.js` | Bootstrap. Llama `core.init()` y después itera `JamBot.features[*].init(ctx)`. |
| `features/recoleccion.js` | Feature de recolección: ciclo, cooldown gating, retry, persistencia, panel UI con tabs. |
| `features/finalizarConstruccion.js` | Feature de finalizar construcción gratis: scheduler propio, cola HTTP, dispatch de notifications. |
| `js/saveToken.js` | Inyectado en page-context. Persiste `localStorage.game` con `{csrfToken, world_id, townId, player_id}` para que el content script lo lea. |
| `js/gameBridge.js` | Inyectado en page-context. Bridge entre el content script y los modelos Backbone (`MM.getModels()`). Detecta cambios de `Game.bot_check` (CAPTCHA) y los reporta. |
| `data.json` | Configuración por defecto: `tiempoRecoleccion`, `tiempoRestanteMaxSegundos`, `finalizarGratis`. |
| `background.js` | Service worker. Por ahora solo loguea "background" — receptor del badge de CAPTCHA. |
| `popup.html` | Popup del icon de la extensión. Mínimo. |

---

## 3. Bootstrap (orden de carga)

Todo lo declarado en `manifest.json > content_scripts[0].js` se carga **en orden** y en el mismo "world" aislado:

```
1. core.js                              → registra window.JamBot.core
2. features/recoleccion.js              → registra window.JamBot.features.recoleccion
3. features/finalizarConstruccion.js    → registra window.JamBot.features.finalizarConstruccion
4. contentScript.js                     → bootstrap: ejecuta core.init() y luego cada feature.init(ctx)
```

Por eso `contentScript.js` puede asumir que `window.JamBot.core` y `window.JamBot.features.*` ya existen cuando se ejecuta. Si no — porque alguien movió el orden en el manifest — loguea un error pre-init y aborta.

`core.init()`:
1. Instala captura global de errores (`window.error` + `unhandledrejection`).
2. Carga el buffer de errores persistido (Fase 7).
3. Inyecta `js/saveToken.js` y `js/gameBridge.js` en page-context.
4. Lee `localStorage.game` (lo que persistió `saveToken.js`).
5. Si no hay `csrfToken`/`world_id`/`townId` → estamos en un subdominio que no es la app del juego (foro, wiki). Retorna `null` silenciosamente.
6. Sino, registra el listener de `JamBot:captchaState` (lo despacha el bridge).
7. Devuelve `ctx = { data, game, core }`.

Luego `contentScript.js` ejecuta cada `feature.init(ctx)` en orden de inserción en `JamBot.features` (orden de carga del manifest).

---

## 4. Comunicación entre worlds

El content-script vive en un **world aislado** (no comparte `window` con la página del juego). Para acceder a `window.Game` y `window.MM` (los modelos Backbone que carga Grepolis), inyectamos scripts en **page-context** vía `<script src="...">`.

### saveToken.js (page → content)
- Corre en page-context.
- Lee `window.Game` y publica `{Game}` vía `window.postMessage`.
- El content script escucha y guarda `csrfToken` etc. en `localStorage.game`.

### gameBridge.js (bidireccional)
- **Lee modelos** cuando el content script lo pide:
  - Listener: `JamBot:queryTownResources` (detail: `{townId}`)
  - Respuesta: `window.postMessage({type: "JamBot:townResources", townId, resources})`
- **Hidrata modelos** cuando el content script tiene una notification fresca:
  - Listener: `JamBot:dispatchNotifications` (detail: `{notifications}`)
  - Hace `model.set(subjectData)` sobre los modelos Backbone correspondientes — la UI del juego se refresca sola.
- **Vigila CAPTCHA** con polling de `Game.bot_check` cada 2s:
  - Si cambia, dispara `window.postMessage({type: "JamBot:captchaState", active})`.
  - Lo escucha `core.js`: `active=true` → `onCaptchaDetectado()` (sin contexto, fallback). `active=false` → `notificarCaptchaLimpioEnJuego()` (NO reanuda — solo pinta el cartel de verde para resaltar el botón "Ya resolví"; el usuario tiene control explícito).

---

## 5. Estado global compartido (`window.JamBot`)

Cualquier feature puede agregarse colgando de `window.JamBot.features.<nombre> = { init }`. El bootstrap las descubre con `Object.entries(JamBot.features)`.

```js
window.JamBot = {
  core: {                  // poblado por core.js
    init,
    log, logWarn, logError, logCiclo,
    isCaptchaActive, getCaptchaState, getCaptchaContext, isCaptchaResueltoEnJuego,
    onCaptcha, onCaptchaContextChange, onCaptchaTimeout,
    onCaptchaDetectado, onCaptchaResuelto,
    isPaused, onPlayPauseChange, setPaused, togglePlayPause,
    registrarBoton, formatDuracion, delaySeconds,
    getErrores, clearErrores,
  },
  features: {              // poblado por cada features/*.js
    recoleccion: { init },
    finalizarConstruccion: { init },
  },
  errores: imprimirErrores,  // shortcut para DevTools
};
```

Desde DevTools de la pestaña del juego se puede inspeccionar y manipular:

```js
JamBot.errores()                              // imprime buffer
JamBot.errores({ scope: "recoleccion" })      // filtra
JamBot.core.isPaused()                        // estado actual
JamBot.core.togglePlayPause()                 // simular click del botón ▶/⏸
JamBot.core.clearErrores()                    // vaciar buffer
```

---

## 6. ctx que reciben las features

Cada `feature.init(ctx)` recibe:

```js
ctx = {
  data,                    // contenido de data.json + ciudadesConAldeas (poblado por recoleccion)
                           //                       + relacionPorAldea (poblado por recoleccion)
                           //                       + construccion     (poblado por finalizarConstruccion)
  game: {
    csrfToken, world_id, townId, player_id,
  },
  core: { ...JamBot.core }, // misma API que JamBot.core (subset relevante para features)
}
```

`data` actúa como **bus de información cross-feature**. Cuando recoleccion termina de cargar las ciudades, las publica en `data.ciudadesConAldeas`; cuando finalizarConstruccion lee la cola, expone su estado en `data.construccion`. El panel (parte de recoleccion) lee ambas para renderizar todas las tabs.

---

## 7. Schedulers independientes

`recoleccion` y `finalizarConstruccion` corren con **schedulers propios**. No comparten `setInterval`. Cada feature decide su cadencia:

- **recoleccion**: tickea cada `tiempoCicloMinutos()` (mín configurado entre todas las ciudades). Watchdog independiente para detectar ciclos colgados.
- **finalizarConstruccion**: tickea según la próxima orden que entre en ventana (mín 30s, fallback 5min). No usa watchdog porque el ciclo es muy corto (solo HTTP requests).

Ambas reaccionan al play/pause global vía `core.onPlayPauseChange()`.

---

## 8. Ver también

- [recoleccion.md](recoleccion.md) — el ciclo de recolección, cooldown, retry, sincronización con server.
- [finalizar-construccion.md](finalizar-construccion.md) — la feature de free-finish.
- [panel.md](panel.md) — la UI con tabs.
- [persistencia.md](persistencia.md) — qué se guarda en `chrome.storage.local`.
- [logging.md](logging.md) — sistema de logs y buffer de errores.
