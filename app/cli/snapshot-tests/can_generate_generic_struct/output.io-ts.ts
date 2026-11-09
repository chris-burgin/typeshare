import * as t from "io-ts";
import * as types from "./output";

export const GenericStructCodec = <A, B>(A: t.Type<A>, B: t.Type<B>): t.Type<types.GenericStruct<A, B>> => t.recursion<types.GenericStruct<A, B>>(`GenericStruct<${A.name}, ${B.name}>`, () => fields({
	field_a: A,
	field_b: t.array(B),
}, {}, {}));

export const GenericStructUsingGenericStructCodec = <T>(T: t.Type<T>): t.Type<types.GenericStructUsingGenericStruct<T>> => t.recursion<types.GenericStructUsingGenericStruct<T>>(`GenericStructUsingGenericStruct<${T.name}>`, () => fields({
	struct_field: GenericStructCodec(t.string, T),
	second_struct_field: GenericStructCodec(T, t.string),
	third_struct_field: GenericStructCodec(T, t.array(T)),
}, {}, {}));

export const EnumUsingGenericStructCodec: t.Type<types.EnumUsingGenericStruct> = /* @__PURE__ */ t.recursion<types.EnumUsingGenericStruct>("EnumUsingGenericStruct", () => t.union([
	fields({
		type: t.literal("VariantA"),
		content: GenericStructCodec(t.string, t.number),
	}, {}, {}),
	fields({
		type: t.literal("VariantB"),
		content: GenericStructCodec(t.string, integer("i32", -2147483648, 2147483647)),
	}, {}, {}),
	fields({
		type: t.literal("VariantC"),
		content: GenericStructCodec(t.string, t.boolean),
	}, {}, {}),
	fields({
		type: t.literal("VariantD"),
		content: GenericStructUsingGenericStructCodec(optional(t.undefined)),
	}, {}, {}),
]));

/** A value, `undefined`, or `null`. serde writes `None` as `null`, so `null` decodes as `undefined`. */
function optional<A, O>(codec: t.Type<A, O>): t.Type<A | undefined, O | undefined> {
	return new t.Type<A | undefined, O | undefined>(
		codec.name,
		(u): u is A | undefined => u === undefined || codec.is(u),
		(u, c) => (u === undefined || u === null ? t.success(undefined) : codec.validate(u, c)),
		(a) => (a === undefined ? undefined : codec.encode(a)),
	);
}

/**
 * Like `t.intersection([t.type(required), t.partial(nullable), t.partial(optional)])`, but a `null`
 * value for a `nullable` property counts as missing and is left out, since serde writes `None` as
 * `null`. A missing property named like an `Object.prototype` member, such as `toString`, is set
 * to `undefined`, so neither io-ts nor the code reading the result sees the inherited member. An
 * undeclared `__proto__` property is left out, since io-ts would turn it into the prototype of the
 * objects it builds.
 */
function fields<R extends t.Props, N extends t.Props, P extends t.Props>(
	required: R,
	nullable: N,
	optional: P,
): t.IntersectionC<[t.TypeC<R>, t.PartialC<N>, t.PartialC<P>]> {
	const codec = t.intersection([t.type(required), t.partial(nullable), t.partial(optional)]);
	const nullableKeys = Object.keys(nullable);
	const shadowedKeys = [...Object.keys(required), ...nullableKeys, ...Object.keys(optional)].filter(
		(key) => key in Object.prototype,
	);
	const isOwn = (u: object, key: string) => Object.prototype.hasOwnProperty.call(u, key);
	const needsCopy = (u: Record<string, unknown>, dropNulls: boolean) =>
		isOwn(u, "__proto__") ||
		shadowedKeys.some((key) => !isOwn(u, key)) ||
		(dropNulls && nullableKeys.some((key) => isOwn(u, key) && u[key] === null));
	// io-ts reads properties with plain lookups, and clones objects into ordinary ones as it goes, so
	// a missing shadowed key gets an own undefined that every clone, and the result, keeps
	const isolate = (u: Record<string, unknown>, dropNulls: boolean) => {
		const copy: Record<string, unknown> = {};
		for (const key of Object.keys(u)) {
			if (key !== "__proto__" && !(dropNulls && u[key] === null && nullableKeys.includes(key))) {
				copy[key] = u[key];
			}
		}
		for (const key of shadowedKeys) {
			if (!isOwn(copy, key)) {
				copy[key] = undefined;
			}
		}
		return copy;
	};
	return new t.IntersectionType<[t.TypeC<R>, t.PartialC<N>, t.PartialC<P>], t.TypeOf<typeof codec>, t.OutputOf<typeof codec>, unknown>(
		codec.name,
		// Checks the object as it is, so a missing shadowed key that reads an inherited member fails
		codec.is,
		(u, c) => {
			if (!t.UnknownRecord.is(u) || !needsCopy(u, true)) {
				return codec.validate(u, c);
			}
			return codec.validate(isolate(u, true), c);
		},
		(a) => {
			const value = a as unknown as Record<string, unknown>;
			if (!needsCopy(value, false)) {
				return codec.encode(a);
			}
			return codec.encode(isolate(value, false) as t.TypeOf<typeof codec>);
		},
		// Partial members add no union tags, so only required literals are used as tags
		codec.types,
	);
}

/** An integer between `min` and `max`, inclusive. */
function integer(name: string, min: number, max: number): t.Type<number> {
	const is = (u: unknown): u is number =>
		typeof u === "number" && Number.isInteger(u) && u >= min && u <= max;
	return new t.Type<number>(name, is, (u, c) => (is(u) ? t.success(u) : t.failure(u, c)), t.identity);
}

