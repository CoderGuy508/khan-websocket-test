const words = [
    "motherfuck", "bullshit", "goddamn", "asshole", "bastard", "nigger", "faggot",
    "fuck", "shit", "bitch", "cunt", "dick", "pussy", "cock", "piss", "damn", "ass",
    "hell", "crap", "twat", "wank", "bollocks", "slut", "whore", "douche", "nigga"
];
const letters = {
    a: "[aàáâãäå@4]", e: "[eèéêë3]", i: "[iìíîï!1|]", o: "[oòóôõö0]",
    s: "[s$5]", t: "[t7]", c: "[cç]", u: "[uùúûü]"
};
const pattern = words.sort((a, b) => b.length - a.length).map(word =>
    word.split("").map(letter => letters[letter] || letter).join("[\\s._*~\\-]*")
).join("|");
const rule = new RegExp("(^|[^a-z0-9])(?:" + pattern + ")(?:s|es|ed|ing|er|ers|y|ies|ty|head|heads|face|faces)?(?=$|[^a-z0-9])", "gi");

function filter(text)
{
    return text.normalize("NFKC").replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, "").replace(rule, (match, before) =>
        before + "*".repeat(Math.max(3, match.slice(before.length).replace(/\s/g, "").length))
    );
}
module.exports = { filter };
