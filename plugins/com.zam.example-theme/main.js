// Zam plugin: Example Theme (com.zam.example-theme)
//
// A small EXAMPLE of a theme written as a plugin. A theme is just CSS:
// zam.ui.addStyles(css) adds it to the app (after Zam's own styles, before the
// user's own custom CSS box) and returns a handle that removes it again.
//
// Zam draws everything from CSS variables (--discord-bg, --discord-accent, ...)
// and sets the user's chosen theme colours inline on <html>, so a rule that
// overrides one needs `!important`. Anything else (a selector of your own, a
// font, a radius) is ordinary CSS. Copy this file to start your own theme.

const SETTINGS = [
    {
        key: "scheme",
        type: "select",
        label: "Colour scheme",
        default: "midnight",
        options: [
            { value: "midnight", label: "Midnight" },
            { value: "forest", label: "Forest" },
            { value: "rose", label: "Rose" },
        ],
    },
    {
        key: "rounded",
        type: "toggle",
        label: "Rounder corners",
        default: false,
    },
];

// Each scheme: the backgrounds, and the accent as "#rrggbb" plus its channels
// (the channels let Zam draw the accent at partial opacity).
const SCHEMES = {
    midnight: {
        bg: "#0f1220",
        secondary: "#0b0e1a",
        tertiary: "#070914",
        hover: "#171b30",
        selected: "#1e2340",
        divider: "#262b47",
        accent: ["#7c8cff", "124 140 255"],
        accentHover: ["#6676f0", "102 118 240"],
    },
    forest: {
        bg: "#16211b",
        secondary: "#101a15",
        tertiary: "#0b120e",
        hover: "#1d2c24",
        selected: "#25382d",
        divider: "#2f4538",
        accent: ["#4fbf7f", "79 191 127"],
        accentHover: ["#41a56c", "65 165 108"],
    },
    rose: {
        bg: "#261a20",
        secondary: "#1e1419",
        tertiary: "#150d11",
        hover: "#31222a",
        selected: "#3b2a33",
        divider: "#4a3540",
        accent: ["#ff6b9a", "255 107 154"],
        accentHover: ["#ee5588", "238 85 136"],
    },
};

function rgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return `${n >> 16} ${(n >> 8) & 255} ${n & 255}`;
}

export function css(values) {
    const s = SCHEMES[values.scheme] ?? SCHEMES.midnight;
    let out = `:root {
    --discord-bg: ${s.bg} !important;
    --discord-bg-rgb: ${rgb(s.bg)} !important;
    --discord-bg-secondary: ${s.secondary} !important;
    --discord-bg-secondary-rgb: ${rgb(s.secondary)} !important;
    --discord-bg-tertiary: ${s.tertiary} !important;
    --discord-bg-dark: ${s.tertiary} !important;
    --discord-bg-hover: ${s.hover} !important;
    --discord-bg-selected: ${s.selected} !important;
    --discord-divider: ${s.divider} !important;
    --discord-accent: ${s.accent[0]} !important;
    --discord-accent-rgb: ${s.accent[1]} !important;
    --discord-accent-hover: ${s.accentHover[0]} !important;
    --discord-accent-hover-rgb: ${s.accentHover[1]} !important;
}
`;
    if (values.rounded) {
        out += `button, input, textarea, select { border-radius: 0.75rem; }\n`;
    }
    return out;
}

export function onload(zam) {
    zam.settings.define(SETTINGS);

    const current = () => ({
        scheme: zam.settings.get("scheme", "midnight"),
        rounded: zam.settings.get("rounded", false),
    });
    let handle = zam.ui.addStyles(css(current()));

    // Swap the stylesheet when a setting changes.
    zam.settings.onChange((values) => {
        handle.dispose();
        handle = zam.ui.addStyles(css(values));
    });
}
