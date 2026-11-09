import assert from "node:assert/strict";
import { test } from "node:test";
import { isLeft } from "fp-ts/Either";
import * as t from "io-ts";
import { PathReporter } from "io-ts/PathReporter";
import {
	ActionCodec,
	BlockCodec,
	ItemCodec,
	KindCodec,
	LargeBlockCodec,
	LiteralACodec,
	LiteralBCodec,
	PageCodec,
} from "../../../cli/snapshot-tests/io_ts_runtime/output.io-ts";
import { Kind } from "../../../cli/snapshot-tests/io_ts_runtime/output";

// An Item the way serde_json writes it, with None as null
const serialized = () => ({
	id: "a",
	count: 3,
	icon: null,
	cleared: null,
	kind: "login",
	tags: ["x"],
	byIndex: { "1": "creditCard" },
	byKind: { login: "l" },
	children: [] as unknown[],
	point: [1, -2],
	nothing: null,
	"kebab-key": "k",
	page: { items: ["login"], next: null },
	action: { type: "nested", content: { type: "move", content: { from: 1, to: null } } },
	bytes: [1, 2, 3, 4, 5, 6],
	empty: [],
	letter: "a",
	byLetter: { a: 1 },
	pages: {},
	lowercased: {},
	label: null,
	constructor: null,
	nothingTwice: null,
});

const withChange = (change: Record<string, unknown>) => ({ ...serialized(), ...change });

const without = (key: string) => {
	const value: Record<string, unknown> = serialized();
	delete value[key];
	return value;
};

function valid<A>(codec: t.Type<A>, value: unknown): A {
	const result = codec.decode(value);
	if (isLeft(result)) {
		throw new Error(PathReporter.report(result).join("\n"));
	}
	return result.right;
}

function invalid(codec: t.Mixed, value: unknown) {
	assert.ok(isLeft(codec.decode(value)), `expected ${JSON.stringify(value)} to be invalid`);
}

test("Option fields accept null and leave the property out", () => {
	const item = valid(ItemCodec, serialized());

	assert.ok(!("icon" in item));
	assert.ok(!("next" in item.page));
	assert.equal(item.page.next, undefined);
	assert.equal(item.action.type === "nested" && item.action.content.type === "move" && item.action.content.content.to, undefined);
	valid(ItemCodec, without("icon"));
});

test("unit fields accept null and decode it as undefined", () => {
	assert.equal(valid(ItemCodec, serialized()).nothing, undefined);
	valid(ItemCodec, without("nothing"));
});

test("Option<Option<T>> keeps null, which means Some(None)", () => {
	assert.equal(valid(ItemCodec, serialized()).cleared, null);
	assert.equal(valid(ItemCodec, withChange({ cleared: "x" })).cleared, "x");
	assert.equal(valid(ItemCodec, without("cleared")).cleared, undefined);
});

test("Option<Option<()>> keeps null too", () => {
	const item = valid(ItemCodec, serialized());

	assert.ok(Object.prototype.hasOwnProperty.call(item, "nothingTwice"));
	assert.equal(item.nothingTwice, null);
});

test("fields named like Object.prototype members are read from the object itself", () => {
	const item = valid(ItemCodec, serialized());

	// Reads see undefined, as the types say, rather than Object.prototype's members
	assert.equal(item.constructor, undefined);
	assert.equal(item.toString, undefined);
	assert.equal(valid(ItemCodec, without("constructor")).constructor, undefined);
	assert.ok(ItemCodec.is(item));
	assert.equal(valid(ItemCodec, withChange({ constructor: "x" })).constructor, "x");
	assert.equal(valid(ItemCodec, withChange({ toString: true })).toString, true);
	invalid(ItemCodec, withChange({ constructor: 1 }));
	invalid(ItemCodec, withChange({ toString: "x" }));
});

test("is() checks fields named like Object.prototype members as they are", () => {
	const item = valid(ItemCodec, serialized());
	const { constructor: _constructor, toString: _toString, ...plain } = item;

	// Without own properties, these read Object.prototype's functions, which aren't strings or booleans
	assert.ok(!ItemCodec.is(plain));
	assert.ok(ItemCodec.is(item));
});

test("fields named like Object.prototype members stay missing after earlier fields change", () => {
	// Decoding `child` and `fallback` drops their null `next`, which makes io-ts clone the object
	// before it reads `constructor` and `toString`
	const page = { items: [], next: null };
	const item = valid(ItemCodec, withChange({ child: page, constructor: null, fallback: page }));

	assert.deepEqual(item.child, { items: [] });
	assert.deepEqual(item.fallback, { items: [] });
	assert.equal(item.constructor, undefined);
	assert.equal(item.toString, undefined);
	assert.ok(ItemCodec.is(item));
});

test("serde(default) fields can be missing but not null", () => {
	assert.equal(valid(ItemCodec, withChange({ pinned: true })).pinned, true);
	valid(ItemCodec, without("pinned"));
	invalid(ItemCodec, withChange({ pinned: null }));
});

test("overridden Option fields still accept null", () => {
	assert.ok(!("label" in valid(ItemCodec, serialized())));
	assert.equal(valid(ItemCodec, withChange({ label: "x" })).label, "x");
	invalid(ItemCodec, withChange({ label: 1 }));
});

test("required fields must be present", () => {
	invalid(ItemCodec, without("id"));
	invalid(ItemCodec, without("kebab-key"));
});

test("integers must fit the Rust type", () => {
	valid(ItemCodec, withChange({ count: 255 }));
	invalid(ItemCodec, withChange({ count: 256 }));
	invalid(ItemCodec, withChange({ count: -1 }));
	invalid(ItemCodec, withChange({ count: 1.5 }));
	invalid(ItemCodec, withChange({ count: "3" }));
});

test("enums accept their serialized values only", () => {
	assert.equal(valid(KindCodec, "creditCard"), Kind.CreditCard);
	invalid(KindCodec, "CreditCard");
	invalid(ItemCodec, withChange({ kind: "nope" }));
});

test("chars must be a single Unicode scalar value", () => {
	valid(ItemCodec, withChange({ letter: "😀" }));
	invalid(ItemCodec, withChange({ letter: "" }));
	invalid(ItemCodec, withChange({ letter: "ab" }));
	invalid(ItemCodec, withChange({ letter: "\ud800" }));
	assert.deepEqual(valid(ItemCodec, withChange({ byLetter: { a: 1, ab: 2 } })).byLetter, { a: 1 });
});

test("record keys are validated from their string form", () => {
	const byIndex = { "0": "login", "4294967295": "creditCard" };
	assert.deepEqual(valid(ItemCodec, withChange({ byIndex })).byIndex, byIndex);
	assert.deepEqual(valid(ItemCodec, withChange({ byKind: { creditCard: "c" } })).byKind, { creditCard: "c" });
	invalid(ItemCodec, withChange({ byIndex: { "1": "nope" } }));
});

test("record entries with invalid keys are dropped, like any io-ts record", () => {
	const byIndex = { "1": "login", x: "login", "4294967296": "login", "0x10": "login", "016": "login", " 2": "login", "3.0": "login" };
	assert.deepEqual(valid(ItemCodec, withChange({ byIndex })).byIndex, { "1": "login" });
	assert.deepEqual(valid(ItemCodec, withChange({ byKind: { login: "l", nope: "n" } })).byKind, { login: "l" });
});

test("a map value with a very large number of errors fails instead of throwing", () => {
	invalid(ItemCodec, withChange({ pages: { x: { items: new Array(200000).fill("invalid") } } }));
});

test("fixed-size arrays must have exactly their length", () => {
	invalid(ItemCodec, withChange({ point: [1] }));
	invalid(ItemCodec, withChange({ point: [1, 2, 3] }));
	invalid(ItemCodec, withChange({ bytes: [1, 2, 3, 4, 5, 6, 7] }));
	invalid(ItemCodec, withChange({ bytes: [1, 2, 3, 4, 5, 256] }));
	invalid(ItemCodec, withChange({ empty: [1] }));
	assert.deepEqual(valid(ItemCodec, serialized()).bytes, [1, 2, 3, 4, 5, 6]);
});

test("a __proto__ key in the input can't stand in for fields", () => {
	// JSON.parse makes __proto__ an ordinary property, which io-ts would turn into a prototype
	invalid(PageCodec(t.string), JSON.parse('{"next":null,"__proto__":{"items":["x"]}}'));
	invalid(PageCodec(t.string), JSON.parse('{"__proto__":{"items":["x"]}}'));

	const page = valid(PageCodec(t.string), JSON.parse('{"items":[],"__proto__":{"next":42}}'));

	assert.equal(Object.getPrototypeOf(page), Object.prototype);
	assert.equal(page.next, undefined);
});

test("a __proto__ map key is checked and kept as an entry", () => {
	const json = (pages: string) => JSON.parse(`{"pages":${pages}}`);
	const item = valid(ItemCodec, { ...serialized(), ...json('{"__proto__":{"items":["login"],"next":null},"a":{"items":[]}}') });

	assert.equal(Object.getPrototypeOf(item.pages), Object.prototype);
	assert.deepEqual(Object.getOwnPropertyDescriptor(item.pages, "__proto__")?.value, { items: ["login"] });
	assert.deepEqual(item.pages.a, { items: [] });
	invalid(ItemCodec, { ...serialized(), ...json('{"__proto__":{"items":["bogus"]}}') });

	const encoded = ItemCodec.encode(item);
	assert.ok(Object.prototype.hasOwnProperty.call(encoded.pages, "__proto__"));
	assert.equal(Object.getPrototypeOf(encoded.pages), Object.prototype);
});

test("a map key that decodes to __proto__ is kept as an entry", () => {
	const { lowercased } = valid(ItemCodec, { ...serialized(), lowercased: JSON.parse('{"__PROTO__":1,"A":2}') });

	assert.equal(Object.getPrototypeOf(lowercased), Object.prototype);
	assert.equal(Object.getOwnPropertyDescriptor(lowercased, "__proto__")?.value, 1);
	assert.equal(lowercased.a, 2);
});

test("encoding a map leaves out keys the key codec rejects, including __proto__", () => {
	const item = valid(ItemCodec, serialized());
	const encoded = ItemCodec.encode({ ...item, byLetter: JSON.parse('{"a":1,"__proto__":2,"abc":3}') });

	assert.deepEqual(encoded.byLetter, { a: 1 });
	assert.ok(!Object.prototype.hasOwnProperty.call(encoded.byLetter, "__proto__"));
});

test("large fixed-size arrays work", () => {
	valid(BlockCodec, new Array(1024).fill(0));
	invalid(BlockCodec, new Array(1023).fill(0));
	valid(LargeBlockCodec, new Array(16384).fill(0));
	invalid(LargeBlockCodec, new Array(16385).fill(0));
});

test("optional literal fields are not used as union tags", () => {
	const either = t.union([LiteralACodec, LiteralBCodec]);

	valid(either, {});
	valid(either, { kind: null });
	assert.deepEqual(valid(either, { kind: "b" }), { kind: "b" });
	invalid(either, { kind: "c" });
});

test("recursive types validate every level", () => {
	valid(ItemCodec, withChange({ children: [serialized(), withChange({ children: [serialized()] })] }));
	invalid(ItemCodec, withChange({ children: [withChange({ children: [withChange({ count: 999 })] })] }));
});

test("algebraic enums check the tag and the content", () => {
	valid(ActionCodec, { type: "lock" });
	assert.deepEqual(valid(ActionCodec, { type: "lock", content: null }), { type: "lock" });
	invalid(ActionCodec, { type: "lock", content: 1 });
	valid(ActionCodec, { type: "open", content: "x" });
	invalid(ActionCodec, { type: "open" });
	assert.deepEqual(valid(ActionCodec, { type: "maybeOpen", content: null }), { type: "maybeOpen" });
	valid(ActionCodec, { type: "maybeOpen" });
	invalid(ActionCodec, { type: "move", content: { to: 1 } });
	invalid(ActionCodec, { type: "nested", content: { type: "bogus" } });
	invalid(ActionCodec, { type: "bogus" });
});

test("generic types are codec factories", () => {
	valid(PageCodec(t.string), { items: ["a"], next: "b" });
	invalid(PageCodec(KindCodec), { items: ["bogus"] });
	assert.equal(PageCodec(KindCodec).name, "Page<Kind>");
});

test("decoded values encode back to the same value", () => {
	const item = valid(ItemCodec, serialized());
	const encoded = ItemCodec.encode(item);

	// The undefined placeholder for a shadowed key doesn't reach JSON
	assert.ok(!Object.prototype.hasOwnProperty.call(JSON.parse(JSON.stringify(encoded)), "toString"));
	assert.deepEqual(valid(ItemCodec, encoded), item);
});

test("errors name the Rust types", () => {
	const [error] = PathReporter.report(ItemCodec.decode(withChange({ count: 256 })));
	assert.match(error, /Item/);
	assert.match(error, /count: u8/);
});
