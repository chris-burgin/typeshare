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
