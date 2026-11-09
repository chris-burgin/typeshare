import * as t from "io-ts";
import * as types from "./output";

export const QualifiedTypesCodec: t.Type<types.QualifiedTypes> = /* @__PURE__ */ t.recursion<types.QualifiedTypes>("QualifiedTypes", () => fields({
	unqualified: t.string,
	qualified: t.string,
	qualified_vec: t.array(t.string),
	qualified_hashmap: record(t.string, t.string),
}, {
	qualified_optional: t.string,
	qualfied_optional_hashmap_vec: record(t.string, t.array(t.string)),
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

/**
 * Like `t.record`, but entries are added with `Object.defineProperty`, so a `__proto__` key is an
 * ordinary entry. io-ts adds them with assignment, which would set the prototype instead.
 */
function record<D extends t.Mixed, C extends t.Mixed>(
	domain: D,
	codomain: C,
): t.Type<t.TypeOf<t.RecordC<D, C>>, t.OutputOf<t.RecordC<D, C>>> {
	const codec = t.record(domain, codomain);
	const addEntry = (target: Record<string, unknown>, key: unknown, value: unknown) =>
		Object.defineProperty(target, String(key), { value, enumerable: true, writable: true, configurable: true });
	return new t.Type<t.TypeOf<typeof codec>, t.OutputOf<typeof codec>>(
		codec.name,
		codec.is,
		(u, c) => {
			if (!t.UnknownRecord.is(u)) {
				return t.failure(u, c);
			}
			const result: Record<string, unknown> = {};
			const errors: t.Errors = [];
			for (const key of Object.keys(u)) {
				const decodedKey = domain.validate(key, t.appendContext(c, key, domain, key));
				// Like any io-ts record, an entry whose key fails the key codec is left out
				if (decodedKey._tag === "Left") {
					continue;
				}
				const value = u[key];
				const decodedValue = codomain.validate(value, t.appendContext(c, key, codomain, value));
				if (decodedValue._tag === "Left") {
					// One at a time, since spreading a very long list of errors overflows the stack
					for (const error of decodedValue.left) {
						errors.push(error);
					}
				} else {
					addEntry(result, decodedKey.right, decodedValue.right);
				}
			}
			return errors.length > 0 ? t.failures(errors) : t.success(result as t.TypeOf<typeof codec>);
		},
		(a) => {
			const value = a as unknown as Record<string, unknown>;
			const result: Record<string, unknown> = {};
			for (const key of Object.keys(value)) {
				if (domain.is(key)) {
					addEntry(result, domain.encode(key), codomain.encode(value[key]));
				}
			}
			return result as t.OutputOf<typeof codec>;
		},
	);
}

