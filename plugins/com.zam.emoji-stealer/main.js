// Zam plugin: Emoji Stealer (com.zam.emoji-stealer)
//
// Right-click (desktop) or long-press (touch) a custom emoji in the timeline —
// inline `data-mx-emoticon` images or custom (mxc) reactions — to open a small
// popover that copies it into:
//   - your personal pack   (account data `im.ponies.user_emotes`), or
//   - any pack of a joined room/space where you may send the
//     `im.ponies.room_emotes` state event (MSC2545 image packs).
// The image itself is never re-uploaded: packs just reference the same mxc://.
//
// The host API has no per-emoji gesture hook, so this plugin listens on the
// document (capture phase) and matches emoji elements itself. Pack reads and
// writes go through `zam.unsafe.getClient()` (the curated matrix.* API does
// not cover state events / account data). Both are full-trust escape hatches;
// they are declared in manifest.json as "ui" + "unsafe".

const SETTINGS = [
    {
        key: "rightClick",
        type: "toggle",
        label: "Right-click to steal",
        default: true,
        description:
            "Right-clicking a custom emoji opens the steal popover instead of the browser menu.",
    },
    {
        key: "longPress",
        type: "toggle",
        label: "Long-press to steal",
        default: true,
        description:
            "Long-pressing a custom emoji on touch screens opens the steal popover (replaces the message menu for that press).",
    },
    {
        key: "reactions",
        type: "toggle",
        label: "Include reactions",
        default: true,
        description:
            "Also steal from custom emoji reactions. Long-pressing a custom reaction then no longer shows who reacted.",
    },
    {
        key: "messageAction",
        type: "toggle",
        label: '"Steal emoji" message action',
        default: true,
        description:
            "Add a Steal emoji entry to the menu of messages that contain custom emoji.",
    },
];

const PACK_TYPE = "im.ponies.room_emotes";
const USER_PACK_TYPE = "im.ponies.user_emotes";
const USER_DEST = "user";
const LONG_PRESS_MS = 450; // just under the host's 500 ms row long-press
const MOVE_TOLERANCE_PX = 10;
const SHORTCODE_RE = /^[A-Za-z0-9_.+-]+$/;
// Material "add_reaction" (24x24, filled) — the host renders it as <path d>.
const ICON =
    "M18 9V7h-2V2.84C14.77 2.3 13.42 2 11.99 2 6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12c0-1.05-.17-2.05-.47-3H18zm-2.5-1c.83 0 1.5.67 1.5 1.5s-.67 1.5-1.5 1.5-1.5-.67-1.5-1.5.67-1.5 1.5-1.5zm-7 0c.83 0 1.5.67 1.5 1.5S9.33 11 8.5 11 7 10.33 7 9.5 7.67 8 8.5 8zm3.5 9.5c-2.33 0-4.31-1.46-5.11-3.5h10.22c-.8 2.04-2.78 3.5-5.11 3.5zM22 3h2v2h-2v2h-2V5h-2V3h2V1h2v2z";

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Recover `mxc://server/id` from a homeserver media URL the app rendered
 *  (…/_matrix/client/v1/media/{download,thumbnail}/server/id or the legacy
 *  …/_matrix/media/v3/…). Returns null for anything else (blob:, twemoji…). */
function mxcFromHttp(src) {
    if (!src) return null;
    if (src.startsWith("mxc://")) return src;
    try {
        const u = new URL(src, location.href);
        const m =
            /\/_matrix\/(?:client\/v1\/media|media\/(?:v3|r0|v1))\/(?:download|thumbnail)\/([^/]+)\/([^/?#]+)/.exec(
                u.pathname,
            );
        if (!m) return null;
        return (
            "mxc://" + decodeURIComponent(m[1]) + "/" + decodeURIComponent(m[2])
        );
    } catch {
        return null;
    }
}

/** ":blob_cat:" -> "blob_cat"; strip anything the app's validator rejects. */
function cleanShortcode(raw) {
    const s = String(raw || "")
        .trim()
        .replace(/^:+|:+$/g, "")
        .replace(/\s+/g, "_")
        .replace(/[^A-Za-z0-9_.+-]/g, "");
    return s || "emoji";
}

function el(tag, style, props) {
    const node = document.createElement(tag);
    if (style) node.style.cssText = style;
    if (props) Object.assign(node, props);
    return node;
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export function onload(zam) {
    zam.settings.define(SETTINGS);
    const setting = (k) => zam.settings.get(k, true);
    const client = () => zam.unsafe.getClient();

    // ----- Matrix helpers (live SDK objects stay inside this block) -----

    function roomState(room) {
        try {
            return room.getLiveTimeline().getState("f") || room.currentState;
        } catch {
            return room.currentState;
        }
    }

    function packEvents(room) {
        const st = roomState(room);
        const evs = st ? st.getStateEvents(PACK_TYPE) : [];
        return Array.isArray(evs) ? evs : evs ? [evs] : [];
    }

    /** Every pack image we can see (personal + joined rooms), for looking up a
     *  nicer shortcode / image info for a bare mxc. */
    function findKnownImage(mxc) {
        const c = client();
        if (!c) return null;
        const contents = [];
        const user = c.getAccountData(USER_PACK_TYPE);
        if (user) contents.push(user.getContent());
        for (const room of c.getRooms()) {
            for (const ev of packEvents(room)) contents.push(ev.getContent());
        }
        for (const content of contents) {
            const images = (content && content.images) || {};
            for (const [shortcode, img] of Object.entries(images)) {
                if (img && img.url === mxc) return { shortcode, img };
            }
        }
        return null;
    }

    /** Reaction events don't carry the shortcode in the key (it's the mxc);
     *  clients put it in `shortcode` (MSC4027) or a beeper-prefixed field. */
    function reactionShortcode(eventId, mxc) {
        const c = client();
        if (!c || !eventId) return null;
        for (const room of c.getRooms()) {
            if (!room.findEventById(eventId)) continue;
            for (const ev of room.getLiveTimeline().getEvents()) {
                if (ev.getType() !== "m.reaction") continue;
                const content = ev.getContent() || {};
                const rel = content["m.relates_to"] || {};
                if (rel.event_id !== eventId || rel.key !== mxc) continue;
                const sc =
                    content.shortcode ||
                    content["com.beeper.reaction.shortcode"];
                if (sc) return sc;
            }
            return null;
        }
        return null;
    }

    /** Destinations the user can write to: personal pack first, then every
     *  pack in joined spaces, then joined rooms. A writable room with no pack
     *  yet gets one entry for a new default pack (state key ""). */
    function listDestinations() {
        const c = client();
        if (!c) return [];
        const me = c.getUserId();
        const dests = [
            {
                id: USER_DEST,
                kind: "user",
                label: "My Emojis",
                sub: "Personal pack",
            },
        ];
        const rooms = c
            .getRooms()
            .filter((r) => r.getMyMembership() === "join")
            .filter((r) => {
                const st = roomState(r);
                return st && st.maySendStateEvent(PACK_TYPE, me);
            })
            .sort((a, b) => {
                const sa = a.isSpaceRoom() ? 0 : 1;
                const sb = b.isSpaceRoom() ? 0 : 1;
                return sa - sb || (a.name || "").localeCompare(b.name || "");
            });
        for (const room of rooms) {
            const kind = room.isSpaceRoom() ? "Space" : "Room";
            const roomName = room.name || room.roomId;
            const packs = packEvents(room);
            if (packs.length === 0) {
                dests.push({
                    id: room.roomId + "|",
                    kind: "room",
                    roomId: room.roomId,
                    stateKey: "",
                    label: roomName,
                    sub: kind + " · new pack",
                    newPackName: roomName + " Emojis",
                });
                continue;
            }
            for (const ev of packs) {
                const stateKey = ev.getStateKey() || "";
                const content = ev.getContent() || {};
                const packName =
                    (content.pack && content.pack.display_name) ||
                    stateKey ||
                    roomName + " Emojis";
                dests.push({
                    id: room.roomId + "|" + stateKey,
                    kind: "room",
                    roomId: room.roomId,
                    stateKey,
                    label: roomName,
                    sub: packs.length > 1 ? kind + " · " + packName : kind,
                    newPackName: packName,
                });
            }
        }
        return dests;
    }

    async function readPack(dest) {
        const c = client();
        if (dest.kind === "user") {
            const ev = c.getAccountData(USER_PACK_TYPE);
            return (ev && ev.getContent()) || {};
        }
        try {
            return (
                (await c.getStateEvent(dest.roomId, PACK_TYPE, dest.stateKey)) ||
                {}
            );
        } catch {
            return {}; // M_NOT_FOUND: pack doesn't exist yet
        }
    }

    async function writePack(dest, content) {
        const c = client();
        if (dest.kind === "user") {
            await c.setAccountData(USER_PACK_TYPE, content);
        } else {
            await c.sendStateEvent(
                dest.roomId,
                PACK_TYPE,
                content,
                dest.stateKey,
            );
        }
    }

    // ----- Emoji detection in the DOM -----

    /** { mxc, shortcode, src, eventId, isReaction } for a stealable emoji
     *  element under `target`, else null. Only timeline rows count, so the
     *  emoji picker and pack settings are left alone. */
    function stealableAt(target) {
        if (!(target instanceof Element)) return null;
        const row = target.closest("[data-event-id]");
        if (!row) return null;
        const eventId = row.getAttribute("data-event-id");

        const inline = target.closest("img[data-mx-emoticon]");
        if (inline) {
            const mxc = mxcFromHttp(inline.getAttribute("src"));
            if (!mxc) return null;
            return {
                mxc,
                src: inline.src,
                shortcode: inline.getAttribute("title") || inline.alt,
                eventId,
                isReaction: false,
            };
        }

        if (!setting("reactions")) return null;
        const button = target.closest("button");
        const img = button && button.querySelector('img[alt^="mxc://"]');
        if (img) {
            const mxc = img.getAttribute("alt");
            return { mxc, src: img.src, shortcode: null, eventId, isReaction: true };
        }
        return null;
    }

    /** All distinct stealable emoji rendered in one message row. */
    function stealablesInRow(row) {
        const out = [];
        const seen = new Set();
        const nodes = row.querySelectorAll(
            'img[data-mx-emoticon], button img[alt^="mxc://"]',
        );
        for (const node of nodes) {
            const found = stealableAt(node);
            if (found && !seen.has(found.mxc)) {
                seen.add(found.mxc);
                found.anchor = node;
                out.push(found);
            }
        }
        return out;
    }

    function resolveEmoji(found) {
        const known = findKnownImage(found.mxc);
        let shortcode = found.shortcode;
        if (!shortcode && found.isReaction) {
            shortcode = reactionShortcode(found.eventId, found.mxc);
        }
        if (!shortcode && known) shortcode = known.shortcode;
        return {
            ...found,
            shortcode: cleanShortcode(shortcode),
            // Carry w/h/mimetype over when the source pack had them.
            info: known && known.img.info ? known.img.info : undefined,
        };
    }

    // ----- Popover UI -----

    let popover = null;
    let lastOpen = 0;

    function closePopover() {
        if (popover) popover.dispose();
        popover = null;
    }

    const INPUT_STYLE =
        "width:100%;box-sizing:border-box;padding:6px 8px;border-radius:4px;border:1px solid var(--discord-divider);background:var(--discord-bg-dark);color:var(--discord-text-primary);font:inherit;font-size:14px;outline:none;";

    function renderSteal(root, emoji, candidates) {
        root.style.cssText =
            "width:300px;max-width:calc(100vw - 16px);padding:12px;display:flex;flex-direction:column;gap:10px;color:var(--discord-text-primary);font-size:14px;";

        // Multi-emoji message (from the message action): pick one first.
        if (candidates && candidates.length > 1) {
            const grid = el(
                "div",
                "display:flex;flex-wrap:wrap;gap:6px;padding-bottom:8px;border-bottom:1px solid var(--discord-divider);",
            );
            for (const cand of candidates) {
                const b = el(
                    "button",
                    "padding:4px;border-radius:6px;cursor:pointer;background:" +
                        (cand.mxc === emoji.mxc
                            ? "var(--discord-bg-hover)"
                            : "transparent") +
                        ";border:1px solid " +
                        (cand.mxc === emoji.mxc
                            ? "rgb(var(--discord-accent-rgb))"
                            : "transparent") +
                        ";",
                    { type: "button", title: cand.shortcode || "" },
                );
                b.appendChild(
                    el("img", "width:28px;height:28px;object-fit:contain;display:block;", {
                        src: cand.src,
                        alt: "",
                    }),
                );
                b.addEventListener("click", () => {
                    root.replaceChildren();
                    renderSteal(root, resolveEmoji(cand), candidates);
                });
                grid.appendChild(b);
            }
            root.appendChild(grid);
        }

        // Header: preview + shortcode field.
        const head = el("div", "display:flex;align-items:center;gap:10px;");
        head.appendChild(
            el(
                "img",
                "width:48px;height:48px;object-fit:contain;flex-shrink:0;border-radius:4px;background:var(--discord-bg-dark);",
                { src: emoji.src, alt: emoji.shortcode },
            ),
        );
        const fieldWrap = el("label", "flex:1;min-width:0;display:flex;flex-direction:column;gap:4px;");
        fieldWrap.appendChild(
            el(
                "span",
                "font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.02em;color:var(--discord-text-secondary);",
                { textContent: "Shortcode" },
            ),
        );
        const input = el("input", INPUT_STYLE, {
            value: emoji.shortcode,
            spellcheck: false,
            autocomplete: "off",
        });
        input.setAttribute("autocapitalize", "off");
        fieldWrap.appendChild(input);
        head.appendChild(fieldWrap);
        root.appendChild(head);

        // Destination list (filterable when long).
        const dests = listDestinations();
        let selected =
            dests.find((d) => d.id === zam.storage.get("lastDest", USER_DEST)) ||
            dests[0];

        root.appendChild(
            el(
                "span",
                "font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.02em;color:var(--discord-text-secondary);",
                { textContent: "Add to" },
            ),
        );
        let filter = null;
        if (dests.length > 6) {
            filter = el("input", INPUT_STYLE, { placeholder: "Search rooms and spaces" });
            root.appendChild(filter);
        }
        const list = el(
            "div",
            "display:flex;flex-direction:column;gap:2px;max-height:216px;overflow-y:auto;overscroll-behavior:contain;",
            { role: "listbox" },
        );
        root.appendChild(list);

        const status = el("div", "font-size:12px;min-height:0;color:var(--discord-text-secondary);");
        root.appendChild(status);

        const actions = el("div", "display:flex;justify-content:flex-end;gap:8px;");
        const cancel = el(
            "button",
            "padding:6px 12px;border-radius:4px;border:0;background:transparent;color:var(--discord-text-primary);cursor:pointer;font:inherit;",
            { type: "button", textContent: "Cancel" },
        );
        const submit = el(
            "button",
            "padding:6px 14px;border-radius:4px;border:0;background:rgb(var(--discord-accent-fill-rgb, var(--discord-accent-rgb)));color:#fff;cursor:pointer;font:inherit;font-weight:600;",
            { type: "button", textContent: "Steal" },
        );
        actions.append(cancel, submit);
        root.appendChild(actions);

        let confirmOverwrite = false;
        let busy = false;
        const setStatus = (text, tone) => {
            status.textContent = text || "";
            status.style.color =
                tone === "error"
                    ? "rgb(var(--discord-danger-rgb))"
                    : tone === "warn"
                      ? "rgb(var(--discord-warning-rgb))"
                      : "var(--discord-text-secondary)";
        };
        const resetConfirm = () => {
            confirmOverwrite = false;
            submit.textContent = "Steal";
            setStatus("");
        };

        function drawList() {
            const q = filter ? filter.value.trim().toLowerCase() : "";
            list.replaceChildren();
            for (const d of dests) {
                if (
                    q &&
                    d.kind !== "user" &&
                    !(d.label + " " + d.sub).toLowerCase().includes(q)
                ) {
                    continue;
                }
                const active = d === selected;
                const row = el(
                    "button",
                    "display:flex;flex-direction:column;align-items:flex-start;gap:1px;width:100%;text-align:left;padding:6px 8px;border-radius:4px;border:0;cursor:pointer;font:inherit;color:var(--discord-text-primary);background:" +
                        (active ? "var(--discord-bg-hover)" : "transparent") +
                        ";box-shadow:" +
                        (active ? "inset 3px 0 0 rgb(var(--discord-accent-rgb))" : "none") +
                        ";",
                    { type: "button" },
                );
                row.setAttribute("role", "option");
                row.setAttribute("aria-selected", String(active));
                row.appendChild(
                    el("span", "font-weight:600;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;", {
                        textContent: d.label,
                    }),
                );
                row.appendChild(
                    el("span", "font-size:12px;color:var(--discord-text-muted);", {
                        textContent: d.sub,
                    }),
                );
                row.addEventListener("click", () => {
                    selected = d;
                    resetConfirm();
                    drawList();
                });
                list.appendChild(row);
            }
            if (!list.firstChild) {
                list.appendChild(
                    el("div", "padding:6px 8px;color:var(--discord-text-muted);", {
                        textContent: "No matches",
                    }),
                );
            }
        }
        drawList();
        if (filter) filter.addEventListener("input", drawList);
        input.addEventListener("input", resetConfirm);

        async function doSteal() {
            if (busy || !selected) return;
            const shortcode = input.value.trim().replace(/^:+|:+$/g, "");
            if (!SHORTCODE_RE.test(shortcode)) {
                setStatus(
                    "Use only letters, numbers, dots, underscores, pluses, and hyphens.",
                    "error",
                );
                return;
            }
            busy = true;
            submit.disabled = true;
            submit.style.opacity = "0.6";
            try {
                const dest = selected;
                const current = await readPack(dest);
                const images = { ...(current.images || {}) };
                const existing = images[shortcode];
                if (existing && existing.url === emoji.mxc) {
                    setStatus(":" + shortcode + ": is already in that pack.", "warn");
                    return;
                }
                if (existing && !confirmOverwrite) {
                    confirmOverwrite = true;
                    submit.textContent = "Replace";
                    setStatus(
                        ":" + shortcode + ": already exists there. Press Replace to overwrite it, or pick another name.",
                        "warn",
                    );
                    return;
                }
                const image = { url: emoji.mxc, usage: ["emoticon"] };
                if (emoji.info) image.info = emoji.info;
                images[shortcode] = image;
                const pack = { ...(current.pack || {}) };
                if (!pack.display_name) {
                    pack.display_name =
                        dest.kind === "user" ? "My Emojis" : dest.newPackName;
                }
                await writePack(dest, { ...current, pack, images });
                zam.storage.set("lastDest", dest.id);
                closePopover();
                zam.ui.notify({
                    body:
                        "Added :" +
                        shortcode +
                        ": to " +
                        (dest.kind === "user" ? "your emojis" : dest.label),
                });
            } catch (e) {
                const code = e && (e.errcode || (e.data && e.data.errcode));
                setStatus(
                    code === "M_FORBIDDEN"
                        ? "You don't have permission to edit that pack."
                        : "Couldn't add emoji: " + ((e && e.message) || e),
                    "error",
                );
            } finally {
                busy = false;
                submit.disabled = false;
                submit.style.opacity = "";
            }
        }

        submit.addEventListener("click", doSteal);
        cancel.addEventListener("click", closePopover);
        input.addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
                e.preventDefault();
                doSteal();
            }
        });

        // Don't pop the soft keyboard on touch; focus the field on desktop.
        if (!matchMedia("(pointer: coarse)").matches) {
            requestAnimationFrame(() => {
                input.focus();
                input.select();
            });
        }
    }

    function openSteal(found, anchor, candidates) {
        if (!client()) return;
        const now = Date.now();
        if (now - lastOpen < 700) return; // long-press + Android contextmenu
        lastOpen = now;
        closePopover();
        const emoji = resolveEmoji(found);
        popover = zam.ui.openPopover({
            anchor,
            render(root) {
                renderSteal(root, emoji, candidates);
            },
        });
    }

    // ----- Gestures (document, capture phase) -----

    let press = null; // { timer, x, y, fired }

    function cancelPress() {
        if (press && press.timer) clearTimeout(press.timer);
        press = null;
    }

    function onContextMenu(e) {
        const found = stealableAt(e.target);
        if (!found) return;
        // Android fires contextmenu on long-press too; honor the touch setting.
        const touchy = press !== null || matchMedia("(pointer: coarse)").matches;
        if (!setting(touchy ? "longPress" : "rightClick")) return;
        e.preventDefault();
        e.stopPropagation();
        openSteal(found, e.target);
    }

    function onTouchStart(e) {
        cancelPress();
        if (!setting("longPress") || e.touches.length !== 1) return;
        const target = e.target;
        const found = stealableAt(target);
        if (!found) return;
        // Keep the row's long-press menu, swipe and double-tap, the reaction
        // "who reacted" sheet, and link-copy from arming for this press.
        e.stopPropagation();
        const t = e.touches[0];
        press = { x: t.clientX, y: t.clientY, fired: false, timer: null };
        press.timer = setTimeout(() => {
            if (!press) return;
            press.timer = null;
            press.fired = true;
            navigator.vibrate && navigator.vibrate(50);
            openSteal(found, target);
        }, LONG_PRESS_MS);
    }

    function onTouchMove(e) {
        if (!press || !press.timer) return;
        const t = e.touches[0];
        if (Math.hypot(t.clientX - press.x, t.clientY - press.y) > MOVE_TOLERANCE_PX) {
            clearTimeout(press.timer);
            press.timer = null;
        }
    }

    function onTouchEnd(e) {
        if (press && press.fired) {
            // Swallow the tap that ends the long-press (reaction toggle, row
            // select) — the popover is already open.
            e.preventDefault();
            e.stopPropagation();
        }
        cancelPress();
    }

    const opts = { capture: true };
    const touchOpts = { capture: true, passive: false };
    document.addEventListener("contextmenu", onContextMenu, opts);
    document.addEventListener("touchstart", onTouchStart, touchOpts);
    document.addEventListener("touchmove", onTouchMove, opts);
    document.addEventListener("touchend", onTouchEnd, touchOpts);
    document.addEventListener("touchcancel", cancelPress, opts);

    // No iOS image callout / Android image drag on stealable emoji.
    const style = document.createElement("style");
    style.textContent =
        "[data-event-id] img[data-mx-emoticon],[data-event-id] button img[alt^='mxc://']{-webkit-touch-callout:none;-webkit-user-drag:none;}";
    document.head.appendChild(style);

    teardown = () => {
        cancelPress();
        closePopover();
        document.removeEventListener("contextmenu", onContextMenu, opts);
        document.removeEventListener("touchstart", onTouchStart, touchOpts);
        document.removeEventListener("touchmove", onTouchMove, opts);
        document.removeEventListener("touchend", onTouchEnd, touchOpts);
        document.removeEventListener("touchcancel", cancelPress, opts);
        style.remove();
    };

    // ----- Message action (keyboard / discoverability fallback) -----

    function rowFor(eventId) {
        return document.querySelector(
            '[data-event-id="' + CSS.escape(eventId) + '"]',
        );
    }

    zam.messages.addAction({
        id: "steal-emoji",
        label: "Steal emoji",
        icon: ICON,
        when({ roomId, eventId }) {
            if (!setting("messageAction")) return false;
            // Cheap check on the event itself; the row may not be mounted yet.
            const c = client();
            const room = c && c.getRoom(roomId);
            const ev = room && room.findEventById(eventId);
            const html = ev && ev.getContent() && ev.getContent().formatted_body;
            if (typeof html === "string" && html.includes("data-mx-emoticon")) {
                return true;
            }
            const row = rowFor(eventId);
            return !!row && stealablesInRow(row).length > 0;
        },
        onSelect({ eventId }) {
            const row = rowFor(eventId);
            const all = row ? stealablesInRow(row) : [];
            if (all.length === 0) {
                zam.ui.notify({ body: "No custom emoji found in that message." });
                return;
            }
            const candidates = all.map((f) => ({
                ...f,
                shortcode: f.shortcode ? cleanShortcode(f.shortcode) : null,
            }));
            // Menu may still be closing; defer so our popover isn't superseded.
            setTimeout(() => openSteal(all[0], row, candidates), 0);
        },
    });
}

let teardown = null;

export function onunload() {
    if (teardown) teardown();
    teardown = null;
}
