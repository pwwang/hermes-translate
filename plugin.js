/**
 * translate — right-click a text selection inside a message and translate it
 * through `llm.oneshot`. The popup (language picker + result) is the whole
 * surface: no composer middleware, no insertion, no chip.
 *
 * The mechanics below (jsx()/jsxs() only, window-capture interception,
 * globalThis listener swap, statusbar-mounted fixed overlays) are lifted from
 * quote-comment, which learned them the hard way — see that file for the why.
 */

import { STATUSBAR_AREAS, atom, host, useValue, Button, Codicon } from '@hermes/plugin-sdk'
import { Fragment, jsx, jsxs } from 'react/jsx-runtime'
import { useState } from 'react'

// -- state ---------------------------------------------------------------

/** Own menu (standalone only): screen position + the selected text. */
const menuAtom = atom({ open: false, x: 0, y: 0, text: '' })
/** Translation popup. `status`: idle | loading | done | error. */
const popupAtom = atom({ open: false, text: '', status: 'idle', result: '', error: '' })

/** Target language, mirrored into ctx.storage. Read once in register() so the
 *  popup can translate immediately on open. */
let targetLanguage = ''

// ctx is only reachable inside register(); kept for component handlers
// (os.writeClipboard, storage). Re-assigned on every reload.
let ctxRef = null

// Only the latest translation may write into the popup.
let seq = 0

// A menu row activates on pointerdown and unmounts the menu inside that
// handler; Chromium then re-hit-tests the gesture's compat mousedown onto
// whatever sat UNDER the menu, which would read as an outside click and close
// the popup the row just opened. Consume the first mousedown instead.
let suppressDismiss = false
let suppressResetTimer = 0

function armDismissSuppression() {
  suppressDismiss = true
  clearTimeout(suppressResetTimer)
  suppressResetTimer = setTimeout(() => {
    suppressDismiss = false
  }, 1500)
}

// -- cross-plugin menu host -----------------------------------------------

/** Registry quote-comment publishes while loaded. Re-checked at EVERY
 *  contextmenu: its host is a fresh object after each of its reloads, so a
 *  one-shot registration would go stale with the old object and vanish. */
const EXT_KEY = '__hermes_message_menu_ext'

function extHost() {
  const h = globalThis[EXT_KEY]

  return h?.alive ? h : null
}

/** Idempotent: drop any row of ours, then push a fresh one (the old closure
 *  belongs to a previous incarnation of this module). */
function registerExtRow() {
  const ext = extHost()

  if (!ext) {
    return false
  }

  ext.rows = ext.rows.filter(row => row.id !== 'translate').concat({
    id: 'translate',
    icon: 'globe',
    label: 'Translate',
    // Arm OUR suppression here, not only in the standalone menu: quote-comment
    // consumes its OWN flag, but the compat mousedown still reaches our
    // window-capture handler and would close the popup we just opened.
    onSelect: text => {
      armDismissSuppression()
      openPopup(text)
    }
  })

  return true
}

// -- app-menu flash suppression -------------------------------------------

/** Roots stamped with the app's context-menu opt-out attribute during a
 *  right-click gesture, so the app's window-capture handler skips them and
 *  never opens its own menu (no flash, no double menu). */
const markedRoots = new Set()
let markClearTimer = 0

function markRoot(root) {
  if (root && !markedRoots.has(root)) {
    root.setAttribute('data-hermes-context-menu-trigger', '')
    markedRoots.add(root)
  }

  // Safety net for gestures that never produce a contextmenu event. NOTE: must
  // NOT be cleared on mouseup — on Windows contextmenu fires AFTER mouseup, so
  // clearing there would strip the attribute before the app's handler (which
  // runs first on window capture) ever sees it.
  clearTimeout(markClearTimer)
  markClearTimer = setTimeout(clearMarks, 600)
}

function clearMarks() {
  clearTimeout(markClearTimer)

  for (const root of markedRoots) {
    root.removeAttribute('data-hermes-context-menu-trigger')
  }

  markedRoots.clear()
}

function selectionContext() {
  const selection = window.getSelection()
  const text = selection ? selection.toString().trim() : ''

  return text ? { selection, text } : null
}

function messageRootOf(node) {
  const el = node instanceof Element ? node : node?.parentElement

  return el?.closest?.('[data-role="user"], [data-role="assistant"]') ?? null
}

// -- theme helpers -------------------------------------------------------

const SURFACE = {
  position: 'fixed',
  zIndex: 'var(--z-over-modal)',
  background: 'var(--ui-bg-elevated)',
  border: '1px solid var(--ui-stroke-secondary)',
  borderRadius: 6,
  boxShadow: '0 8px 24px rgba(0, 0, 0, 0.18)',
  color: 'var(--ui-text-primary)',
  fontSize: 13,
  fontFamily: 'inherit'
}

/** Compact form control — the native select / text input / inline button. */
const CONTROL = {
  padding: '3px 6px',
  border: '1px solid var(--ui-stroke-secondary)',
  borderRadius: 4,
  background: 'var(--ui-bg-tertiary)',
  color: 'var(--ui-text-primary)',
  fontSize: 12,
  fontFamily: 'inherit'
}

/** Bordered scroll box shared by the source preview and the result area. */
const BOX = {
  padding: 8,
  marginBottom: 10,
  border: '1px solid var(--ui-stroke-secondary)',
  borderRadius: 4,
  whiteSpace: 'pre-wrap',
  overflowWrap: 'anywhere'
}

const HINT = { color: 'var(--ui-text-tertiary)' }

// -- translation ---------------------------------------------------------

const CUSTOM = '__custom__'

const LANGUAGES = [
  'English', 'Chinese (Simplified)', 'Chinese (Traditional)', 'Japanese',
  'Korean', 'Spanish', 'French', 'German', 'Portuguese', 'Russian', 'Arabic',
  'Hindi'
]

function closePopup() {
  // Invalidate any in-flight request: nothing may land in a dismissed popup.
  seq += 1
  popupAtom.set({ open: false, text: '', status: 'idle', result: '', error: '' })
}

function openPopup(text) {
  popupAtom.set({ open: true, text, status: 'idle', result: '', error: '' })

  // "Remember and translate directly next time": a stored language skips the
  // picker and starts the translation on open.
  if (targetLanguage) {
    void runTranslation()
  }
}

async function runTranslation() {
  const lang = targetLanguage
  const current = popupAtom.get()

  if (!current.open || !lang || !current.text) {
    return
  }

  const mine = (seq += 1)

  popupAtom.set({ ...current, status: 'loading', result: '', error: '' })

  try {
    const sessionId = host.state.focusedSessionId.get()
    const res = await host.request('llm.oneshot', {
      instructions: `Translate the user-provided text into ${lang}. Output only the translation, no quotes, no explanations. Keep paragraph breaks.`,
      input: current.text,
      // Omitted entirely (not just undefined) when there is no focused session.
      ...(sessionId ? { session_id: sessionId } : {}),
      max_tokens: 1500,
      temperature: 0.2
    })

    if (mine !== seq) {
      return
    }

    popupAtom.set({ ...popupAtom.get(), status: 'done', result: res?.text ?? '' })
  } catch (err) {
    if (mine !== seq) {
      return
    }

    popupAtom.set({ ...popupAtom.get(), status: 'error', error: err?.message || String(err) })
  }
}

/** Persist + re-run. The ONLY path that changes the target language. */
function applyLanguage(lang) {
  const trimmed = lang.trim()

  if (!trimmed) {
    return
  }

  targetLanguage = trimmed
  ctxRef.storage.set('target_language', trimmed)
  void runTranslation()
}

// -- floating surfaces (single component tree under the statusbar) --------

function PluginRoot() {
  const menu = useValue(menuAtom)
  const popup = useValue(popupAtom)

  return jsxs(Fragment, {
    children: [
      menu.open && jsx(ContextMenuCard, { key: 'menu', x: menu.x, y: menu.y, text: menu.text }),
      popup.open && jsx(TranslatePopup, { key: 'popup', popup })
    ]
  })
}

function closeMenu() {
  menuAtom.set({ open: false, x: 0, y: 0, text: '' })
}

function closeAll() {
  closeMenu()
  closePopup()
}

/** The app's Radix menu dismisses on an OUTSIDE pointerdown (and preventDefaults
 *  it, which would kill clicks on our rows). A synthetic pointerdown on body —
 *  the frame after we open, again at 120ms because the app menu mounts async —
 *  closes it so only ours remains; it fires no compat mousedown, so our own
 *  dismiss handlers ignore it. */
function dismissAppMenu() {
  document.body.dispatchEvent(
    new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 })
  )
}

// -- ui ------------------------------------------------------------------

/** One menu row. Activates on POINTERDOWN, not click: while the app's Radix
 *  menu is open its DismissableLayer preventDefaults outside pointerdowns,
 *  which makes Chromium suppress the whole mousedown/mouseup/click sequence on
 *  our rows. React's onPointerDown fires before Radix's document handler. */
function MenuRow({ icon, label, onSelect }) {
  const [hover, setHover] = useState(false)

  return jsxs('button', {
    type: 'button',
    onPointerDown: onSelect,
    onMouseEnter: () => setHover(true),
    onMouseLeave: () => setHover(false),
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 7,
      width: '100%',
      padding: '5px 10px',
      border: 0,
      borderRadius: 4,
      textAlign: 'left',
      background: hover ? 'var(--ui-control-hover-background)' : 'transparent',
      color: 'var(--ui-text-primary)',
      fontSize: 13,
      fontFamily: 'inherit',
      cursor: 'pointer'
    },
    children: [
      jsx(Codicon, { name: icon, size: 13, style: { flexShrink: 0, color: 'var(--ui-text-secondary)' } }),
      label
    ]
  })
}

/** Standalone menu — only reachable when no live host exists; otherwise our
 *  row lives in quote-comment's menu and this never opens. */
function ContextMenuCard({ x, y, text }) {
  const left = Math.min(x, window.innerWidth - 176)
  const top = Math.min(y, window.innerHeight - 100)

  const row = (key, icon, label, run) =>
    jsx(MenuRow, {
      key,
      icon,
      label,
      onSelect: () => {
        armDismissSuppression()
        closeMenu()
        run()
      }
    })

  return jsxs('div', {
    'data-tl': 'menu',
    style: { ...SURFACE, left, top, minWidth: 160, padding: 4 },
    children: [
      row('copy', 'copy', 'Copy', () => void ctxRef.os.writeClipboard(text)),
      row('translate', 'globe', 'Translate', () => openPopup(text))
    ]
  })
}

function TranslatePopup({ popup }) {
  const source = popup.text
  // Seeded per mount: the popup unmounts on close, so reopening reflects the
  // stored language with no store wiring.
  const [sel, setSel] = useState(
    !targetLanguage ? '' : LANGUAGES.includes(targetLanguage) ? targetLanguage : CUSTOM
  )
  const [custom, setCustom] = useState(LANGUAGES.includes(targetLanguage) ? '' : targetLanguage)

  const preview = source.length > 140 ? `${source.slice(0, 140)}…` : source

  const body =
    popup.status === 'loading'
      ? jsx('span', { style: HINT, children: 'Translating…' })
      : popup.status === 'error'
        ? jsx('span', { style: { color: 'var(--ui-danger, #f87171)' }, children: popup.error })
        : popup.status === 'done'
          ? popup.result
          : jsx('span', { style: HINT, children: 'Pick a language to translate.' })

  return jsxs('div', {
    'data-tl': 'popup',
    style: {
      ...SURFACE,
      left: '50%',
      top: '45%',
      transform: 'translate(-50%, -50%)',
      width: 'min(440px, calc(100vw - 32px))',
      padding: 14
    },
    children: [
      jsxs('div', {
        style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 },
        children: [
          jsx('span', { style: { fontWeight: 600 }, children: 'Translate' }),
          jsx('select', {
            value: sel,
            onChange: event => {
              const value = event.target.value

              setSel(value)

              // 'Custom…' only reveals the input; that value is submitted
              // explicitly (Enter).
              if (value && value !== CUSTOM) {
                applyLanguage(value)
              }
            },
            style: { ...CONTROL, marginLeft: 'auto', maxWidth: 200 },
            children: [
              jsx('option', { value: '', children: 'Language…' }),
              ...LANGUAGES.map(lang => jsx('option', { key: lang, value: lang, children: lang })),
              jsx('option', { value: CUSTOM, children: 'Custom…' })
            ]
          })
        ]
      }),
      sel === CUSTOM &&
        jsx('input', {
          // Focus via callback ref (beats autoFocus, which loses the race
          // against the gesture's compat mousedown focus-steal).
          ref: el => {
            el?.focus()
          },
          type: 'text',
          value: custom,
          onChange: event => setCustom(event.target.value),
          placeholder: 'Target language — press Enter',
          onKeyDown: event => {
            if (event.key === 'Enter') {
              event.preventDefault()
              applyLanguage(custom)
            }
          },
          style: { ...CONTROL, display: 'block', width: '100%', marginBottom: 10 }
        }),
      jsx('div', {
        title: source,
        style: {
          ...BOX,
          maxHeight: 72,
          overflow: 'auto',
          color: 'var(--ui-text-secondary)',
          fontSize: 12,
          lineHeight: 1.5
        },
        children: preview
      }),
      jsx('div', {
        style: {
          ...BOX,
          minHeight: 40,
          maxHeight: 260,
          overflow: 'auto',
          fontSize: 13,
          lineHeight: 1.5,
          userSelect: 'text'
        },
        children: body
      }),
      jsxs('div', {
        style: { display: 'flex', justifyContent: 'flex-end', gap: 8 },
        children: [
          jsx(Button, {
            type: 'button',
            variant: 'secondary',
            onClick: closePopup,
            children: [
              jsx(Codicon, { name: 'close', size: 13, style: { marginRight: 5, verticalAlign: '-2px' } }),
              'Close'
            ]
          }),
          jsx(Button, {
            type: 'button',
            variant: 'default',
            onClick: () => {
              const result = popupAtom.get().result

              if (result) {
                void ctxRef.os.writeClipboard(result)
              }
            },
            children: [
              jsx(Codicon, { name: 'copy', size: 13, style: { marginRight: 5, verticalAlign: '-2px' } }),
              'Copy'
            ]
          })
        ]
      })
    ]
  })
}

// -- contextmenu interception + dismissal listeners -----------------------

// Keys for the hot-reload listener swap: a re-evaluated plugin removes the
// previous incarnation's listener before adding its own, so listeners never
// stack and never point at dead closures.
const KEY_CONTEXTMENU = '__tl_ctxmenu_handler'
const KEY_MOUSEDOWN = '__tl_mousedown_handler'
const KEY_KEYDOWN = '__tl_keydown_handler'
const KEY_SCROLL = '__tl_scroll_handler'
const KEY_BLUR = '__tl_blur_handler'
const KEY_RESIZE = '__tl_resize_handler'

function bindOnce(key, target, type, fn, capture) {
  const previous = globalThis[key]

  if (previous) {
    target.removeEventListener(type, previous, capture)
  }

  target.addEventListener(type, fn, capture)
  globalThis[key] = fn
}

function unbind(key, target, type, capture) {
  const fn = globalThis[key]

  if (fn) {
    target.removeEventListener(type, fn, capture)
    delete globalThis[key]
  }
}

export default {
  id: 'translate',
  name: 'Translate',
  register(ctx) {
    ctxRef = ctx
    targetLanguage = ctx.storage.get('target_language', '')

    // Best-effort at load (succeeds when quote-comment loaded before us); the
    // per-contextmenu re-check below heals any load-order difference.
    registerExtRow()

    ctx.register({
      id: 'popup',
      area: STATUSBAR_AREAS.right,
      order: 140,
      render: () => jsx(PluginRoot, {})
    })

    // Listeners attach to WINDOW (capture), not document: the app's context
    // menu listens on window capture and stopPropagation()s every right-click,
    // which kills all document-level listeners. stopPropagation does NOT stop
    // other listeners on the SAME target (that is stopImmediatePropagation).
    const onContextMenu = event => {
      // The app's handler has ALREADY decided (it registered before us on the
      // same target) — drop the gesture's trigger-attribute stamps now.
      clearMarks()

      const info = selectionContext()

      if (!info || !messageRootOf(event.target) || !messageRootOf(info.selection.anchorNode)) {
        closeMenu()

        return
      }

      // A live quote-comment owns the menu: register into it and stand down —
      // no preventDefault, the gesture is not ours to consume. But do not
      // trust the host blindly: if its menu has not appeared shortly after
      // (broken or stale instance whose registry object still reports alive),
      // fall back to our own menu so the gesture never yields nothing. The
      // trigger-attribute stamps already suppressed the app's own menu, so
      // without this the right-click would be a dead gesture.
      if (registerExtRow()) {
        closeMenu()

        const point = { open: true, x: event.clientX, y: event.clientY, text: info.text }

        setTimeout(() => {
          if (!document.querySelector('[data-qc="menu"]') && !menuAtom.get().open) {
            menuAtom.set(point)
            requestAnimationFrame(dismissAppMenu)
            setTimeout(dismissAppMenu, 120)
          }
        }, 100)

        return
      }

      // Standalone: suppress the app menu, so we must offer Copy ourselves.
      event.preventDefault()
      event.stopPropagation()
      menuAtom.set({ open: true, x: event.clientX, y: event.clientY, text: info.text })
      requestAnimationFrame(dismissAppMenu)
      setTimeout(dismissAppMenu, 120)
    }

    // Anything inside a floating surface is ignored; every other mousedown
    // closes both. Detached targets are ignored too: unmounting the menu inside
    // a pointerdown handler detaches the row, so the compat mousedown targets a
    // dead node whose closest('[data-tl]') is null — treating it as "outside"
    // would close the popup that handler just opened.
    const onMouseDown = event => {
      if (suppressDismiss) {
        suppressDismiss = false
        // This is the gesture's own compat mousedown (see armDismissSuppression).
        // Block its DEFAULT action too, or the browser moves focus to the
        // element re-hit-tested under the cursor and steals it from the
        // custom-language input that just mounted.
        event.preventDefault()

        return
      }

      // Right-button press with a message selection: stamp the roots BEFORE the
      // contextmenu event fires, so the app's handler skips them entirely.
      // Marks are cleared in onContextMenu or by the 600ms timer.
      if (event.button === 2) {
        const info = selectionContext()

        if (info && messageRootOf(event.target) && messageRootOf(info.selection.anchorNode)) {
          markRoot(messageRootOf(event.target))
          markRoot(messageRootOf(info.selection.anchorNode))
        }
      }

      const target = event.target instanceof Element ? event.target : null

      if (!target || !target.isConnected || target.closest('[data-tl]')) {
        return
      }

      // An outside press dismisses the menu only. The translation popup is a
      // task surface: it closes on Escape or its own Close button, never by a
      // stray click or a focus change (a translation may still be in flight).
      closeMenu()
    }

    const onKeyDown = event => {
      if (event.key === 'Escape') {
        closeAll()
      }
    }

    // Scroll/resize close floating surfaces (a menu must not follow the page
    // away). Scrolls INSIDE a surface are fine — the capture-phase target
    // identifies the scroller.
    const onScroll = event => {
      if (event.target instanceof Element && event.target.closest('[data-tl]')) {
        return
      }

      closeMenu()
    }

    // Focus loss (alt-tab, clicking another app), scrolling and resizing close
    // only the transient menu: an open translation — or one still in flight —
    // must survive them so the user can come back to the result.
    const onBlur = () => {
      closeMenu()
    }

    const onResize = () => {
      closeMenu()
    }

    bindOnce(KEY_CONTEXTMENU, window, 'contextmenu', onContextMenu, true)
    bindOnce(KEY_MOUSEDOWN, window, 'mousedown', onMouseDown, true)
    bindOnce(KEY_KEYDOWN, window, 'keydown', onKeyDown, true)
    bindOnce(KEY_SCROLL, window, 'scroll', onScroll, true)
    bindOnce(KEY_BLUR, window, 'blur', onBlur, false)
    bindOnce(KEY_RESIZE, window, 'resize', onResize, false)

    ctx.onDispose(() => {
      // Retract our row from quote-comment's registry: this module's closures
      // die with the unload, so a row left behind would open nothing.
      const ext = extHost()

      if (ext) {
        ext.rows = ext.rows.filter(row => row.id !== 'translate')
      }

      clearMarks()
      closeAll()
      unbind(KEY_CONTEXTMENU, window, 'contextmenu', true)
      unbind(KEY_MOUSEDOWN, window, 'mousedown', true)
      unbind(KEY_KEYDOWN, window, 'keydown', true)
      unbind(KEY_SCROLL, window, 'scroll', true)
      unbind(KEY_BLUR, window, 'blur', false)
      unbind(KEY_RESIZE, window, 'resize', false)
    })
  }
}
