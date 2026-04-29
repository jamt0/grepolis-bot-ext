/* ============================================================================
 * Grepolis Bot — Probe de investigación (Fase 0)
 * ============================================================================
 *
 * USO:
 * 1. Abrir Grepolis con el juego cargado.
 * 2. Abrir DevTools → Console.
 * 3. Pegar TODO este archivo y pulsar Enter.
 * 4. Copiar la salida de las 4 secciones [PROBE-1..4] y pegarla en el chat.
 *
 * También expone helpers en window.__jamProbe.* para inspección manual:
 *   __jamProbe.captureClaim()   — instala interceptor de fetch para capturar
 *                                  la próxima request de claim manual.
 *   __jamProbe.findCaptcha()    — busca elementos sospechosos de ser CAPTCHA
 *                                  en el DOM actual.
 *
 * No modifica nada del juego. Solo lectura + interceptor temporal de fetch.
 * ========================================================================== */

(() => {
  const out = (label, data) => {
    console.groupCollapsed(`%c[PROBE] ${label}`, 'color:#0af;font-weight:bold');
    console.log(data);
    console.groupEnd();
  };

  // ---------------------------------------------------------------------------
  // PROBE-1: ¿qué hay en `Game`?
  // ---------------------------------------------------------------------------
  const game = window.Game;
  if (!game) {
    console.error('[PROBE] window.Game no existe. ¿Estás en la pantalla del juego?');
    return;
  }

  const gameKeys = Object.keys(game).sort();
  out('PROBE-1 Game keys', gameKeys);

  // Subset de keys que probablemente nos interesan
  const interesting = gameKeys.filter((k) =>
    /(town|farm|player|resource|claim|captcha|bot|human|protect|notif|model|cache|manager|fetch|refresh)/i.test(k)
  );
  out('PROBE-1.b Game keys "interesantes"', interesting);

  // Tipos de cada uno
  const interestingTypes = Object.fromEntries(
    interesting.map((k) => {
      const v = game[k];
      const t =
        v === null ? 'null' :
        Array.isArray(v) ? 'array' :
        typeof v === 'object' ? (v.constructor && v.constructor.name) || 'object' :
        typeof v;
      return [k, t];
    })
  );
  out('PROBE-1.c Tipos de keys interesantes', interestingTypes);

  // ---------------------------------------------------------------------------
  // PROBE-2: ¿hay un bus de eventos / colección global de modelos?
  // ---------------------------------------------------------------------------
  const candidates = ['MM', 'Backbone', 'Marionette', 'Radio', 'GameEvents', 'EventBus'];
  const found = candidates.filter((c) => typeof window[c] !== 'undefined');
  out('PROBE-2 Buses globales detectados', found);

  // Si MM existe (común en Grepolis) → sacar lista de "channels"/"controllers"
  if (window.MM) {
    try {
      const mmKeys = Object.keys(window.MM).sort();
      out('PROBE-2.b MM keys', mmKeys);
      // En Grepolis MM tiene controllers para cada subsistema
      if (typeof window.MM.getModels === 'function') {
        out('PROBE-2.c MM.getModels() existe', 'sí — invocable');
      }
      if (typeof window.MM.getCollections === 'function') {
        out('PROBE-2.d MM.getCollections() existe', 'sí — invocable');
      }
      if (typeof window.MM.fire === 'function') {
        out('PROBE-2.e MM.fire() existe', 'sí — útil para forzar refresh');
      }
    } catch (e) {
      console.warn('[PROBE] Error introspeccionando MM:', e);
    }
  }

  // ---------------------------------------------------------------------------
  // PROBE-3: ¿hay una "FarmTown" / "FarmTownPlayerRelation" en los modelos?
  // ---------------------------------------------------------------------------
  if (window.MM && typeof window.MM.getModels === 'function') {
    try {
      const allModels = window.MM.getModels();
      const modelKeys = Object.keys(allModels || {});
      const farmRelated = modelKeys.filter((k) => /farm/i.test(k));
      out('PROBE-3 Modelos con "farm" en el nombre', farmRelated);

      if (allModels && allModels.FarmTownPlayerRelation) {
        const ftpr = allModels.FarmTownPlayerRelation;
        out('PROBE-3.b FarmTownPlayerRelation', {
          tipo: ftpr.constructor && ftpr.constructor.name,
          claves: typeof ftpr === 'object' ? Object.keys(ftpr) : null,
          metodos: typeof ftpr === 'object'
            ? Object.getOwnPropertyNames(Object.getPrototypeOf(ftpr) || {})
            : null,
        });
      }
    } catch (e) {
      console.warn('[PROBE] Error introspeccionando models:', e);
    }
  }

  // ---------------------------------------------------------------------------
  // PROBE-4: candidatos a selector de CAPTCHA en el DOM actual
  // ---------------------------------------------------------------------------
  const captchaSelectors = [
    '.bot_protection',
    '.captcha',
    '.captcha_human_verification',
    '#bot_protection',
    '#botprotection_popup',
    '.human_verification',
    '[class*="captcha"]',
    '[class*="bot_protection"]',
    '[class*="human"]',
    '[id*="captcha"]',
    '[id*="bot"]',
  ];
  const captchaPresent = captchaSelectors
    .map((sel) => ({
      selector: sel,
      encontrado: document.querySelectorAll(sel).length,
    }))
    .filter((r) => r.encontrado > 0);
  out('PROBE-4 Selectores CAPTCHA presentes ahora', captchaPresent);

  // ---------------------------------------------------------------------------
  // Helper: capturar la próxima request de claim manual
  // ---------------------------------------------------------------------------
  window.__jamProbe = window.__jamProbe || {};

  window.__jamProbe.captureClaim = () => {
    if (window.__jamProbe._patched) {
      console.warn('[PROBE] fetch ya está patcheado.');
      return;
    }
    const origFetch = window.fetch;
    window.__jamProbe._origFetch = origFetch;
    window.__jamProbe._patched = true;

    window.fetch = async function (...args) {
      const [url, opts] = args;
      const isClaim =
        typeof url === 'string' &&
        url.includes('frontend_bridge') &&
        opts && opts.body && String(opts.body).includes('claim');

      const res = await origFetch.apply(this, args);

      if (isClaim) {
        try {
          const clone = res.clone();
          const json = await clone.json();
          console.groupCollapsed(
            '%c[PROBE-CAPTURE] claim request capturada',
            'color:#fa0;font-weight:bold'
          );
          console.log('URL:', url);
          console.log('BODY enviado:', String(opts.body));
          console.log('RESPONSE parseada:', json);
          console.groupEnd();
        } catch (e) {
          console.warn('[PROBE-CAPTURE] no se pudo parsear:', e);
        }
      }
      return res;
    };

    console.log(
      '%c[PROBE] fetch interceptado. Haz un claim MANUAL en el juego — la próxima request quedará logeada.',
      'color:#fa0'
    );
    console.log('Para restaurar: __jamProbe.unpatch()');
  };

  window.__jamProbe.unpatch = () => {
    if (!window.__jamProbe._patched) return;
    window.fetch = window.__jamProbe._origFetch;
    window.__jamProbe._patched = false;
    console.log('[PROBE] fetch restaurado.');
  };

  window.__jamProbe.findCaptcha = () => {
    const all = document.querySelectorAll('*');
    const matches = [];
    all.forEach((el) => {
      const cls = (el.className && typeof el.className === 'string') ? el.className : '';
      const id = el.id || '';
      if (/captcha|bot_protection|human_verif/i.test(cls + ' ' + id)) {
        matches.push({
          tag: el.tagName,
          id,
          className: cls,
          visible: el.offsetParent !== null,
        });
      }
    });
    console.log('[PROBE] Coincidencias CAPTCHA en DOM actual:', matches);
    return matches;
  };

  console.log(
    '%c[PROBE] Listo.',
    'color:#0f0;font-weight:bold;font-size:14px'
  );
  console.log(
    'Helpers disponibles:\n' +
      '  __jamProbe.captureClaim()  — captura la próxima request de claim manual\n' +
      '  __jamProbe.findCaptcha()   — busca elementos CAPTCHA en el DOM ahora\n' +
      '  __jamProbe.unpatch()       — quita el interceptor de fetch'
  );
})();
