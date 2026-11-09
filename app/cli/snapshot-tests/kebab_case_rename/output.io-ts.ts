import * as t from "io-ts";
import * as types from "./output";

export const ThingsCodec: t.Type<types.Things> = /* @__PURE__ */ t.recursion<types.Things>("Things", () => fields({
	bla: t.string,
}, {
	label: t.string,
	"label-left": t.string,
}, {}));

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

