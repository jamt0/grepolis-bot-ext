# Plan de mejoras — Grepolis Bot Extension

> Documento de trabajo. Recoge los problemas detectados, el plan de mejora ordenado por prioridad y los criterios para empezar a implementar de forma **mínimamente invasiva**.

---

## 1. Contexto y problemas actuales

### 1.1 Bug raíz ya resuelto
- `model_url` estaba hardcodeado a `FarmTownPlayerRelation/52287` (player_id de otra cuenta). El servidor respondía `success:true` pero sin notificación `Town`, y el `.find()` devolvía `undefined`, rompiendo toda la pasada de recolección.
- **Fix aplicado** (commit `bcc4b70`): `Game.player_id` se persiste vía `saveToken.js` y se usa dinámicamente en el `model_url`. Añadido guard contra `undefined` y `try/catch` por aldea.

### 1.2 Problemas en producción que motivan este plan
1. **La UI del juego no refresca los recursos tras recolectar** — el bot llama directo al endpoint y no pasa por el flujo nativo del cliente, por lo que el estado en pantalla no se actualiza hasta recargar.
2. **CAPTCHA anti-bot no detectado** — cuando aparece, el bot sigue ejecutando contra endpoints que ya no devuelven datos útiles, fallando en silencio. Necesidad: **detectar → notificar → pausar → reanudar al desbloquearse**.

### 1.3 Otros problemas detectados durante el análisis (apuntados, no abordados aún)
- `setInterval` en lugar de `setTimeout` recursivo → desfase progresivo de los ciclos.
- `recursosLlenos` nunca se resetea → ciudades se "apagan" para siempre.
- Detección de almacén lleno frágil (igualdad estricta de tres recursos).
- `csrfToken` en `localStorage` puede quedar viejo en sesiones largas.
- `background.js` y `foreground.js` vacíos; `popup.html` infrautilizado.
- Magic numbers repartidos por el código (delays antiban, márgenes).

---

## 2. Principios

- **Lo menos invasivo posible**: no refactor grande, no migración de manifest, no bundlers, no TypeScript todavía. Solo lo necesario.
- **Detectar fallos silenciosos antes que optimizar**: prioridad 1 es CAPTCHA porque hoy el bot puede pasar horas "trabajando" sin recolectar nada.
- **Reanudar automáticamente cuando sea seguro**: si el usuario resuelve el CAPTCHA, el bot retoma el ritmo sin intervención adicional.
- **Riesgo de detección anti-bot**: cualquier cambio que altere visiblemente el ritmo de requests o use observers demasiado amplios aumenta riesgo. Mantener observers acotados.

---

## 3. Plan por fases

### Fase 0 — Investigación (sin código)

Antes de tocar nada, recopilar 3 datos en DevTools mientras se juega manualmente:

1. **Cómo refresca el juego sus recursos tras un claim manual**:
   - Identificar la función / evento del cliente (`Game.*`, `MM.*`, modelos Backbone) que actualiza la UI.
   - Identificar el "punto de entrada" oficial para reclamar aldea (si existe), para sustituir el `fetch` directo.
2. **Cómo se ve un CAPTCHA**:
   - Selector / clase del modal en el DOM.
   - Si la respuesta del `frontend_bridge` trae algún campo (`human_check_required`, subject `BotProtection`, etc.).
3. **Confirmar si el endpoint actual aplica el delta al modelo** o si hace falta paso adicional.

**Entregable**: nota corta con selectores y nombres de funciones concretos para arrancar fases 1 y 2.

**Herramienta**: `docs/probe.js` — script para pegar en consola que introspecciona `Game` y `MM`.

### Fase 1 — Detección y manejo de CAPTCHA (prioridad máxima)

#### 1.1 Detección por DOM
- `MutationObserver` sobre `document.body` (acotado al selector concreto, no `subtree:true` indiscriminado).
- Aparición del modal → `captchaActive = true` → notificar.
- Desaparición del modal → `captchaActive = false` → reanudar.

#### 1.2 Detección por respuesta
- En `recolectarAldea`, antes de procesar la notificación `Town`:
  - Comprobar campo CAPTCHA en la respuesta (a confirmar en fase 0).
  - Comprobar si `notifications` contiene un subject de protección anti-bot.
- Si se detecta → marcar estado, abortar pasada actual, notificar.

#### 1.3 Notificación al usuario (tres canales)
1. **`chrome.notifications.create`** — visible aunque la pestaña esté en background. Requiere añadir `notifications` al `manifest.json`.
2. **Sonido** corto (`Audio` o `AudioContext`), opcional.
3. **Estado visible del botón flotante**: rojo + texto `⚠ CAPTCHA — desbloquea`.
4. **Badge en el ícono** de la extensión (`chrome.action.setBadgeText({text:'!'})`, fondo rojo).

#### 1.4 Pausa y reanudación
- Sustituir `setInterval` por `setTimeout` recursivo (de paso arregla el desfase).
- En cada tick, si `captchaActive === true`, no recolectar; reprogramar siguiente tick.
- Observer del 1.1 pone `captchaActive = false` al detectar fin del modal → próximo tick reanuda.
- Limpiar notificación / badge / estado del botón al reanudar.

**Resultado esperado**: aparece CAPTCHA → notificación + sonido + botón rojo → usuario lo resuelve → bot reanuda solo.

### Fase 2 — Refresh de recursos en la UI

Estrategias en orden de preferencia (decidir según hallazgos de fase 0):

#### Plan A — Llamar al cliente del juego (preferido)
- Si en fase 0 encontramos la función oficial (ej: `Game.farmTownManager.claim(aldeaId, opcion)`), sustituir el `fetch` directo por una llamada inyectada en page-context (mismo patrón que `saveToken.js`).
- Comunicación content-script ↔ page vía `window.postMessage` o `CustomEvent`.
- La UI se actualiza sola al pasar por el flujo nativo.

#### Plan B — Disparar refresh manualmente (fallback)
- Tras claim exitoso, disparar evento del bus que el juego use:
  - `MM.fire('town/refresh', { id: codigoCiudad })`, `Game.townManager.fetchTown(codigoCiudad)`, etc.
- Si no hay bus accesible: aplicar el delta (`response.Town.last_wood`, etc.) directamente al modelo del town del juego.

#### Plan C — DOM hack (último recurso)
- Manipular directamente los `<span>` de los recursos en el header.
- Solo si A y B son inviables. Frágil pero funcional.

### Fase 3 — Control mínimo y diagnóstico

Necesario para que las fases anteriores sean operables:

- **Botón "Detener"** que cancele el timeout y limpie estado.
- **Estado visible en el botón**:
  - Verde + `próx: 4m32s` cuando todo bien.
  - Amarillo + `recolectando…` durante la pasada.
  - Rojo + `CAPTCHA` cuando bloqueado.
- **Refresh periódico de la lista de aldeas/ciudades** (cada N ciclos, ej: 12 → 1h con `tiempoRecoleccion=5`) — detectar conquistas/fundaciones nuevas.
- **Resetear `recursosLlenos` cada ciclo** — fix del bug de "ciudades que se apagan".
- **Logging estructurado** con prefijo `[JamBot]` y niveles `debug/info/warn/error`.

---

## 4. Orden de implementación

| # | Fase | Por qué en este orden | Esfuerzo |
|---|---|---|---|
| 1 | Fase 0 (investigación) | Sin esto, las dos fases siguientes son a ciegas | 1-2h |
| 2 | Fase 1.1 + 1.2 + 1.4 (detección + pausa) | Dejar de fallar en silencio es lo más urgente | 2-3h |
| 3 | Fase 1.3 (notificación) | Inútil pausar si no te enteras | 1-2h |
| 4 | Fase 3 (control + reset `recursosLlenos`) | Bugs ya activos hoy | 2h |
| 5 | Fase 2 (refresh UI) | Calidad de vida; el bot ya funciona sin esto | 2-4h según plan A/B/C |

---

## 5. Riesgos y consideraciones

- **Detección anti-bot**: observers acotados a un selector concreto, no escanear todo el `body`. No alterar de forma marcada el ritmo de requests respecto al actual.
- **Acoplamiento al cliente del juego**: el Plan A de fase 2 depende de funciones internas que pueden cambiar entre versiones. Plan B más resiliente, Plan C quebradizo. Si vamos por A, prever fallback a B si la función no existe.
- **`chrome.notifications`**: añadir permiso al manifest. Comprobar versión Manifest V2 vs V3.
- **Reanudación tras CAPTCHA**: cuidado con animaciones de fade. Usar debounce corto o esperar a que el nodo desaparezca del DOM completamente.
- **TOS de Grepolis prohíbe bots**: las mejoras no deberían hacer al bot más "agresivo". El jitter aleatorio en los delays podría ayudar a parecer más humano (pendiente de evaluar).

---

## 6. Hallazgos de Fase 0 (investigación)

Resultados del probe ejecutado el 2026-04-28:

### Sistema CAPTCHA
- **`Game.hcaptcha`** existe como Object → Grepolis usa **hCaptcha** para bot protection.
- **`Game.bot_check`** existe como propiedad (valor `null` cuando no hay challenge activo).
- **Implicación**: la detección de Fase 1 puede simplificarse — en vez de `MutationObserver` sobre el DOM, podemos vigilar el cambio de `Game.bot_check` (probablemente pasa de `null` a un objeto cuando se requiere CAPTCHA). Mantener detección DOM como respaldo.

### Arquitectura del juego (relevante para Fase 2)
- **Buses globales detectados**: `MM`, `Backbone`, `GameEvents`. No hay Marionette ni Radio.
- **`MM.getModels()` y `MM.getCollections()`** disponibles → registry Backbone-style accesible.
- **Modelos relevantes encontrados**: `FarmTown` y `FarmTownPlayerRelation` aparecen como entradas en `MM.getModels()`.
- **Implicación**: Plan A de fase 2 es viable — existe un modelo cliente para la relación jugador↔aldea. Llamar a su método nativo de `claim` (a confirmar nombre exacto) debería disparar el refresh de UI automáticamente vía Backbone events.

### Identidad del jugador (ya usado en el fix)
- `Game.player_id`, `Game.player_name`, `Game.world_id`, `Game.townId` confirmados como propiedades directas.

### CAPTCHA en DOM (estado base)
- Solo 1 nodo con `id` que contiene "bot" en el DOM en estado normal — probablemente un ícono del HUD. Ignorable hasta tener un CAPTCHA real para muestrear.

### Pendiente de Fase 0
- [x] Salida de captureClaim durante un claim manual (capturado vía XHR — el cliente usa XHR, no fetch).
- [x] Inspección de `Game.hcaptcha` y `Game.bot_check`.
- [ ] Inspección de instancia Backbone (`MM.getModels().FarmTownPlayerRelation['106']`) — confirmar si tiene método `claim` nativo (Plan A) o si hay que dispatchar notifications manualmente (Plan B).
- [ ] Selector exacto del modal hCaptcha cuando aparezca.

### 🔥 Hallazgo crítico — el bot actual NO recolecta

Capturado el claim manual del cliente nativo:

```
URL:    POST /game/frontend_bridge?town_id={town_id}&action=execute&h={csrfToken}
BODY:
  model_url:    "FarmTownPlayerRelation/{relation_id}"
  action_name:  "claim"
  captcha:      null
  arguments:    { farm_town_id: <int>, type: "resources", option: 1 }
  town_id:      <int>
  nl_init:      true
```

**`{relation_id}` es uno de los IDs en `Object.keys(MM.getModels().FarmTownPlayerRelation)`** (ej: `103, 104, …, 108`), **uno por cada ciudad del jugador**, NO es el `player_id`.

El bot actual en `contentScript.js:93` usa `FarmTownPlayerRelation/${player_id}` (ej: `848939901`). Esa relación no existe → el server responde `success:true` sin notificación de `Town` y **el claim no aplica nada**. El fix anterior (`bcc4b70`) solo evitó el crash, no arregló la recolección.

**Implicación en el plan**: añadir como tarea prioritaria — antes de fase 1 — corregir el `model_url` para usar el `relation_id` por ciudad. Probablemente el `relation_id` esté disponible en el `farm_town_list` que ya devuelve `island_info`, o accesible vía `MM.getModels().FarmTownPlayerRelation`.

### Estructura de la respuesta a un claim (relevante para Fase 2)

La respuesta incluye `notifications` con `type: "backbone"` y `param_str` JSON. Cada notification representa la actualización de un modelo Backbone:

```json
[
  { "subject": "Town",                      "param_id": 91,  "param_str": "{\"Town\":{...recursos completos...}}" },
  { "subject": "FarmTownPlayerRelation",    "param_id": 106, "param_str": "{\"FarmTownPlayerRelation\":{...cooldown...}}" }
]
```

Grepolis dispatcha estas notifications hacia los modelos correspondientes y la UI se actualiza vía Backbone events. Nuestro bot las ignora (solo lee `Town` para `recursosLlenos`).

**Implicación para Fase 2**: si encontramos el dispatcher (probable que esté en `GameEvents` o como handler global), basta con pasarle la respuesta tras un claim del bot — la UI se refresca sola sin tocar nada más.

### CAPTCHA — pista en el payload

El campo `captcha: null` en el body del claim sugiere que cuando se requiere, ese campo lleva un token. Habrá que detectar:
- Cambio de `Game.bot_check` (ahora `null`).
- Posible respuesta de error específica cuando el server requiere captcha.

---

## 7. Estado del documento

- **Creado**: 2026-04-28
- **Última actualización**: 2026-04-28 (hallazgos de Fase 0)
- **Fase actual**: Fase 0 (investigación) — parcialmente completada.
- **Bloqueante actual**: pendiente push del commit `bcc4b70` (remoto pertenece a `jamt0`, credenciales locales son de `jonatanmancerakilik` → 403).
