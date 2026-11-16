# Writing a Zam plugin: where things go

`zam-api/plugins/types.d.ts` is the full reference: every method has its
documentation there. This page shows which part of the API to use for common
jobs. Everything here except the first section needs the Zam release after
1.55.4. Set `minAppVersion` to match.

A plugin is a module that exports `onload(zam)` and, optionally,
`onunload()`. Every `add` / `register` / `on` call returns a handle with
`dispose()`. Zam also disposes all of a plugin's handles when it is disabled,
so you rarely need to call it yourself.

## Already there

- Slash commands: `commands.register`.
- Composer buttons and "+" actions: `composer.addButton`, `addAction`.
- Message menu items, badges and transcripts: `messages.addAction`, `decorate`,
  `annotate`.
- Link embeds: `messages.registerEmbed`.
- Room header buttons that open a side panel: `room.addHeaderButton`.
- Popovers and toasts: `ui.openPopover`, `ui.notify`.
- CSS: `ui.addStyles`.
- Incoming-call ringtones (1.63.0+): `ringtones.register`, see
  [Ringtones](#ringtones).

## Put a section in a room's settings

```js
zam.room.addSettingsTab({
    id: "fish",
    label: "Fish",
    when: ({ isSpace }) => !isSpace, // optional
    render(el, { roomId }) {
        const b = document.createElement("button");
        b.textContent = "Do the thing";
        b.onclick = () => doTheThing(roomId);
        el.append(b);
        return () => {/* cleanup when the tab closes */};
    },
});
```

The tab sits after Zam's own tabs, on desktop and mobile. You don't need to
inject anything into the dialog. Use `zam.matrix.canSetState(roomId, type)` to
decide whether to show controls that write room state.

## A page in app settings

For more than a `settings` schema can express, use
`zam.ui.addSettingsPage({ id, label, render(el) })`. The page appears under a
"Plugins" group in Settings.

## A section on the Debug page

Developer tools (inspecting or writing raw account data, say) belong on the
Debug settings page rather than in a settings page of their own:
`zam.ui.addDebugSection({ id, title, render(el) })`. Sections appear below
Zam's own debug tools; `render` runs each time the page is shown and its
returned cleanup when the page is left.

## Member list, profile cards, room list

```js
// A badge and a second line beside each member (e.g. a status you fetched).
zam.members.decorate(({ userId }) => {
    const p = cache.get(userId);
    return p ? { subtitle: p.text, badge: p.tag, tooltip: p.long } : null;
});
// After your data changes:
zam.members.refresh();

zam.members.addAction({ id: "slap", label: "Slap", onSelect: ({ userId, roomId }) => {} });
zam.members.addProfileSection({ id: "stats", render(el, { userId }) {} });
zam.rooms.addAction({ id: "export", label: "Export", onSelect: ({ roomId }) => {} });
```

`decorate` runs for every visible member on each re-render, so keep it to a
lookup. Do the fetching elsewhere, for example with `zam.matrix.getPresence`
or `getProfile`, and call `refresh()` when the data arrives.

## Custom events (super reacts and similar)

```js
// Send one. Encrypted rooms encrypt it.
await zam.matrix.sendEvent(roomId, "com.example.superreact", {
    "m.relates_to": { event_id: targetId },
    emoji: "🦍",
    body: "🦍 super react", // what other clients show
});

// Show it in the timeline. Without a renderer, Zam leaves the event out.
zam.messages.registerRenderer({
    eventType: "com.example.superreact",
    render(el, { content, sender, isOwn }) {
        el.textContent = `${content.emoji} SUPER REACT`;
    },
});

// React to new ones as they arrive (live, decrypted).
zam.events.on("message", (ev) => {
    if (ev.type === "com.example.superreact" && ev.isLive) playAnimation(ev);
});
```

A renderer can take a custom `msgtype` of `m.room.message` (`msgtype:
"com.example.x"`) instead of a custom event type. Zam refuses `m.*` types and
the types it renders itself. Prefer a custom msgtype with a sensible `body`
when other clients should still see something.

## Effects across the screen (chimp attack, truth nuke)

```js
const overlay = zam.ui.addOverlay({
    render(el) {
        // A full-window layer above Zam. Clicks pass through it unless you
        // set `interactive: true` or give a child `pointer-events: auto`.
        const chimp = document.createElement("img");
        el.append(chimp);
    },
});

// Find what to wreck.
const row = zam.dom.messageElement(eventId); // a message on screen
const list = zam.dom.region("member-list");  // app, space-sidebar, room-list,
                                             // room-header, timeline, composer
const rect = row?.getBoundingClientRect();

// Wreck it reversibly. The original styles come back on dispose or unload.
const h = zam.dom.style(row, { transform: "rotate(12deg) translateY(400px)", opacity: "0", transition: "all .6s" });
setTimeout(() => h.dispose(), 5000);
```

The DOM rules:

- Svelte owns Zam's DOM. **Never remove or move Zam's nodes**, because that
  breaks re-rendering. Hide, transform or fade them with `zam.dom.style`, and
  draw your own nodes in an overlay.
- Only the hooks are stable: `data-zam-region`, `data-event-id` and
  `data-sender` on message rows, `data-user-id` on member rows, and
  `data-room-id` on room rows. Tailwind classes and nesting can change in any
  release.
- To act on elements as they appear, use `zam.dom.observe(selector, { added(el)
  { ...; return cleanup } })` rather than your own MutationObserver. Zam runs
  one shared observer and scans once per frame.

## Panels

`zam.ui.registerPanel({ id, title, render })`, then `zam.ui.openPanel(id)`
opens it beside the timeline, for example from a command or a message action.
`zam.ui.closePanel()` closes it. Changing rooms also closes it.

## Ringtones

Needs Zam 1.63.0 or later. `zam.ringtones.register` adds a ringtone to
Settings → Voice & audio → Ringing, listed as "name (Plugin Name)". When the
user picks it, it rings for incoming calls instead of the built-in tone.

```js
// A sound file, looped at the user's ringtone volume. `src` is an https:,
// blob: or data: URL; zam.assets.url gives a blob: URL for a manifest asset.
zam.ringtones.register({
    id: "chime",
    name: "Chime",
    src: await zam.assets.url("sounds/chime.ogg", "audio/ogg"),
});

// A sound you make yourself: WebAudio, or MIDI through zam.midi.
let player = null;
zam.ringtones.register({
    id: "theme",
    name: "Theme tune",
    async start() {
        player = await zam.midi.play(await zam.assets.get("theme.mid"));
        if (!player) throw new Error("MIDI can't play here");
        player.onEnded(() => player?.play()); // loop it
        player.play();
    },
    stop() {
        player?.close(); // may run more than once, or before start finishes
        player = null;
    },
});
```

What Zam guarantees, so a call always rings:

- `start` has about two seconds to start making sound. If it throws, its
  promise rejects, or it takes longer than that, Zam calls `stop` and plays
  the built-in tone instead.
- `stop` runs when the call is answered or declined, when the caller hangs
  up, after the ring's ten-second limit, and when your plugin is disabled.
  Make it safe to call twice, and before `start` has finished.
- If the plugin is disabled while its ringtone is selected, the call rings
  the built-in tone. The choice is kept and comes back when the plugin is
  turned on again.
- Ids are 1 to 64 letters, digits, `.`, `_` or `-`, unique within your
  plugin. A bad ringtone or a repeated id throws from `register`.

Things to know:

- An incoming call starts the ringtone without a click, and browsers may
  block audio that wasn't started by one. `zam.midi` in particular says to
  start it from a click. If your sound is blocked, the user hears the
  built-in tone, not silence. Test it on the platforms you care about.
- Schedule notes with WebAudio timing rather than `setTimeout`: timers are
  slowed down while Zam's window is in the background.
- On Android, while Zam is in the background, the phone's own call screen
  rings with the system ringtone, and plugin ringtones aren't used.
- There is no hook for the sound a caller hears while waiting for an answer;
  Zam doesn't play one.

## Matrix data

`zam.matrix`:

- `getRooms`, `getEvent`, `getState` / `listState` / `setState`,
  `getAccountData` / `setAccountData` (optionally per room), `getProfile`,
  `getPresence`.
- `setState` and `setAccountData` refuse the types Zam manages itself (power
  levels, join rules, encryption, m.direct, push rules, key backup, ...). For
  those, use Zam's own settings.

## Events

`zam.events.on(name, handler)` passes typed payloads (`PluginEventMap` in
types.d.ts):

- `message`: new messages, including encrypted ones once they decrypt.
- `message-sent`: the server accepted something this device sent.
- `reaction-added`: carries `key` and `targetEventId`.
- `typing`, `member-join`, `room-enter`, `notification`, `room-update`, `sync`.

Payloads from the first sync after start-up have `isLive: false`, so skip
those if you only want news.

## Where you are

`zam.navigation.getActiveRoomId()` returns the open room, and
`zam.navigation.openRoom(roomId, { eventId })` opens a room, optionally
scrolled to a message.
