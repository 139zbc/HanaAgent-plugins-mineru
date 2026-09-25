# Hana plugin gotchas

Behaviours of the Hana plugin host that were found the hard way while building this plugin. They are collected here because each one cost real debugging time, and most of them fail *silently* rather than with an obvious error.

Versions this was verified against: **Hana 0.450.0** on Windows. Host internals move; treat these as "check this first", not as eternal truths.

## 1. Plugin page assets return 403 when the page is authorized only by the surface session

A plugin page is loaded inside an iframe whose URL carries a `pluginIframeTicket` and a `pluginSurfaceSession`. Pages authorized *only* that way do not receive the plugin asset-session cookie, so a second request for `/assets/panel.js` or `/assets/panel.css` comes back:

```
403 {"error":"missing_credential"}
```

The routes themselves work fine — it is the asset request that is unauthenticated.

**Workaround used here:** `routes/ui.js` inlines `panel.css` and `panel.js` into the `/page` and `/widget` HTML response, so there is no second request to fail. Revert with `INLINE_ASSETS = false` once the host issues the cookie for surface-session pages too.

Two things the workaround must *not* do:

- put the ticket, token or surface session into any asset URL;
- replace the `assets/` directory with a custom static route (`assets/` stays authoritative).

The same problem applies to `<img>` tags: a bare image request carries no credential. Result images are therefore fetched by page script through the plugin's own route with the surface session attached, and converted to a `blob:` URL.

## 2. Shared modules keep their first-loaded content (ESM cache)

Hana's plugin reload busts the ESM cache **only for the entry file** — it appends a cache-busting query to the entry URL. Any module the entry imports is served from the process's module cache, still holding the content from the first load.

So this sequence fails:

1. Add a new export to `translate.v2.js`.
2. Update `index.js` to import it.
3. Reload the plugin.

Result: the plugin fails to load with

```
The requested module './translate.v2.js' does not provide an export named 'normalizeTargetLanguage'
```

The file on disk has the export; the process has the old module.

**Convention used here:** shared runtime modules carry a content version in their filename (`job-store.v6.js`, `translate.v3.js`, `parse-options.v2.js`, …). When you change one, create the next version, update every importer, and delete the old file. After a full Hana restart the cache is empty and names can be normalized again if you want.

This bites in order: first on a real export change, then again the next time you add one, because the pitfall is invisible while you are reading the source.

## 3. The configuration schema is cached at startup

The manifest's `contributes.configuration` is held in memory from app startup. Consequences:

- A config key added to `manifest.json` is **unknown to the running host**: `ctx.config.set("newKey", …)` throws `PluginConfigValidationError: UNKNOWN_FIELD`, even after a plugin reload.
- A config key removed from the manifest still shows up in `GET /api/plugins/:id/config-schema` until the app restarts.
- Fields whose definition changed (for example a field that gained an `enum`) keep their old shape until the app restarts.

Adding or removing config fields therefore requires **an app restart**, not a plugin reload. Writing a not-yet-known key should be wrapped in `try/catch` and logged as a warning rather than allowed to break the feature the key belongs to.

## 4. How plugin settings render (and what you cannot do)

Hana's plugin settings page derives every field's control from the schema:

| Schema | Control |
|---|---|
| `type: boolean` | toggle |
| has `enum` | **select** |
| `type: object` / `array` | textarea (JSON) |
| anything else | text input, or password when `sensitive: true` |

Two useful consequences:

- **A dropdown needs only `enum`** (plus `default`). No UI code is required.
- **Marking a field `sensitive` changes more than its appearance**, and the difference is easy to miss.

On that second point: `sensitive` closes two doors at once. The field renders as a password input *and* `GET /plugins/:id/config` redacts it (the route hardcodes `redacted: true`). There is no reveal control for plugin config fields, so a `sensitive` value can never be read back through the plugin API.

Plugins also cannot add their own button or row to that page: `contributes.settingsTab` is accepted only for **bundled built-in** plugins, and is skipped for community plugins. So any custom affordance next to a setting (a reveal button, a test-connection button, a status line) has to live in the plugin's own page or widget surface.

## 5. iframe sandbox limits

The plugin page iframe is created with:

```
sandbox="allow-scripts allow-forms allow-popups allow-same-origin"
```

Notably absent:

- **`allow-downloads`** — an `<a download>` click with a `blob:` or data URL is silently ignored. There is no error and no visible feedback. If a plugin needs to hand a file to the user, either render a link the user copies, or deliver the file through a conversation attachment.
- **`allow-modals`** — `window.confirm` / `alert` do nothing. In-page confirmation UI has to be built by hand.

Widget and card surfaces use slightly different sandbox attributes (`allow-scripts allow-same-origin`, and for some card hosts `allow-scripts` only), so do not assume the page sandbox applies everywhere.

## 6. `model:sample-text` does not inject anything into your prompt

The bus event used for one-shot utility text generation passes the system prompt through untouched:

```ts
systemPrompt: payload.systemPrompt || ""
```

Nothing is prepended, and no persona or agent instructions are added. That makes it a clean way to call a model with exactly the instructions you wrote. The model is resolved from `payload.agentId` → that agent's `models.utility`; omit `agentId` to use the current session's utility model.

One practical consequence: **reasoning models count thinking tokens against `maxTokens`.** A budget that looks generous for the visible output can still yield an empty reply, which surfaces as `LLM_EMPTY_RESPONSE` with `reason: empty_after_thinking`. Short text with a tiny budget is the riskiest case.

## 7. Manifest metadata and icons are injected verbatim

- Display fields derived from the manifest (plugin name, page tab title, tab icon) are read when Hana starts scanning plugins. Changing them needs **an app restart**; a plugin reload only refreshes runtime code.
- Manifest icons are injected as-is — the host does not resize them. Titlebar buttons are 26×26 with no constraint on the inner `<svg>`, so an inline SVG without `width`/`height` expands to fill the button and looks about twice as large as Hana's own 14×14 icons. Give icons explicit `width="14" height="14"` and use a `scale()` group if the glyph should not fill the viewBox.

## 8. Auth details that are easy to get wrong

- The page URL needs `pluginIframeTicket` **and** `pluginSurfaceSession`. Passing `token` instead of the ticket breaks the ticket signature verification.
- Requests made by page script to the plugin's own routes need the surface session in the `X-Hana-Plugin-Surface-Session` header.
- The ticket is signed over the **canonical** surface path — query parameters that are not part of the ticket's own allow-list are folded into the signed path, so adding an extra query parameter to the page URL makes verification fail with `plugin_iframe_ticket route mismatch`. Keep the URL to the parameters the host issues.
