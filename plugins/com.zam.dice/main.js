// Zam plugin: Dice Roller (com.zam.dice)
//
// A small, self-contained EXAMPLE of a repo (GitHub-distributed) Zam plugin.
// Registers a /roll slash command that rolls dice from standard notation
// (e.g. "2d6+1", "d20", "3d8-2") and posts the result as a normal m.text
// message, so recipients on any Matrix client see plain text.
//
// It is written purely against the `zam` host API: no app imports, no
// client.ts, no direct DOM. Copy this file's shape to start your own plugin.
// Metadata + the settings schema live in manifest.json alongside this file;
// the schema is repeated here only so the plugin can seed its own defaults at
// runtime via zam.settings.define().

const SETTINGS = [
    {
        key: "showRolls",
        type: "toggle",
        label: "Show individual dice",
        default: true,
        description: "Include each die's value, e.g. 2d6 -> 8 (3, 5).",
    },
];

// Guards so a hostile "9999d9999" can never hang the send path.
const MAX_DICE = 100;
const MAX_SIDES = 1000;

// Pure: parse "NdM(+/-K)" -> { total, rolls, mod, notation } or null on bad input.
function roll(input) {
    const m = /^\s*(\d*)d(\d+)\s*([+-]\s*\d+)?\s*$/i.exec(input || "");
    if (!m) return null;
    const count = m[1] === "" ? 1 : parseInt(m[1], 10);
    const sides = parseInt(m[2], 10);
    const mod = m[3] ? parseInt(m[3].replace(/\s+/g, ""), 10) : 0;
    if (count < 1 || count > MAX_DICE || sides < 1 || sides > MAX_SIDES) {
        return null;
    }
    const rolls = [];
    let total = 0;
    for (let i = 0; i < count; i++) {
        const r = 1 + Math.floor(Math.random() * sides);
        rolls.push(r);
        total += r;
    }
    total += mod;
    const modStr = mod === 0 ? "" : mod > 0 ? "+" + mod : String(mod);
    return { total, rolls, mod, notation: count + "d" + sides + modStr };
}

export function onload(zam) {
    // Seed the settings defaults so the gear form + get() are stable pre-edit.
    zam.settings.define(SETTINGS);

    zam.commands.register({
        name: "roll",
        description: "Roll dice, e.g. /roll 2d6+1",
        argKind: "text",
        async run({ roomId, arg }) {
            const result = roll(arg);
            if (!result) {
                // Invalid input: don't spam the room; notify() is a local hint.
                zam.ui.notify({
                    body: 'Could not roll "' + arg + '". Try 2d6, d20, or 3d8+1.',
                });
                return;
            }
            const showRolls = zam.settings.get("showRolls", true);
            let body = "🎲 " + result.notation + " -> " + result.total;
            if (showRolls && result.rolls.length > 1) {
                const modStr =
                    result.mod === 0
                        ? ""
                        : result.mod > 0
                          ? " +" + result.mod
                          : " " + result.mod;
                body += " (" + result.rolls.join(", ") + modStr + ")";
            }
            await zam.matrix.sendMessage(roomId, {
                msgtype: "m.text",
                body: body,
            });
        },
    });
}

export function onunload() {}
