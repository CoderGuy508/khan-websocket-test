const test = require("node:test");
const assert = require("node:assert/strict");
const { filter } = require("../filter.cjs");
test("filter catches case, spacing, leetspeak and common endings", () => {
    for (const value of ["fuck", "SHIT", "f u c k", "sh1t", "b!tch", "fucking", "asshole", "f\u200buck", "ｆｕｃｋ"]) assert.match(filter(value), /^\*+$/);
    assert.equal(filter("hello FUCK world"), "hello **** world");
    for (const value of ["class assignment", "Scunthorpe", "assistant", "cocktail", "Dickinson", "hello there"]) assert.equal(filter(value), value);
});
