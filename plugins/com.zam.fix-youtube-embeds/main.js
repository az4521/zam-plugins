// Zam plugin: Fix YouTube Embeds (com.zam.fix-youtube-embeds)
//
// After Vencord's FixYoutubeEmbeds (GPL-3.0-or-later, by coolelectronics).
// Label videos (UMG's, for example) refuse to play embedded in Zam desktop:
// YouTube answers "This video is unavailable" (error 152-4) to an embed
// whose Referer is a bare address like Zam's http://127.0.0.1:<port>/. Sent
// with a referrer on a normal hostname, the same embed plays. Vencord's
// trick (reload the player from inside, so youtube.com is the referrer) no
// longer works: YouTube blocks that too. zam.frames sets the Referer of
// Zam's YouTube players (desktop only).

const SETTINGS = [
    {
        key: "referrer",
        type: "text",
        label: "Referrer",
        default: "https://example.com/",
        description:
            "The page YouTube is told the player is on. Any https://host/ that YouTube doesn't block works.",
    },
];

const EMBED_PREFIXES = [
    "https://www.youtube.com/embed/",
    "https://www.youtube-nocookie.com/embed/",
];

let rule = null;

function apply(zam) {
    rule?.dispose();
    rule = zam.frames.inject({
        urlPrefixes: EMBED_PREFIXES,
        referrer: zam.settings.get("referrer", SETTINGS[0].default),
    });
}

export function onload(zam) {
    zam.settings.define(SETTINGS);
    apply(zam);
    zam.settings.onChange(() => apply(zam));
}

export function onunload() {
    rule = null;
}
