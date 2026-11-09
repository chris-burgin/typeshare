/** One of the values of a TypeScript enum. */
function enumCodec<E>(name: string, values: object): t.Type<E> {
	const members = new Set<unknown>(Object.values(values));
	const is = (u: unknown): u is E => members.has(u);
	return new t.Type<E>(name, is, (u, c) => (is(u) ? t.success(u) : t.failure(u, c)), t.identity);
}
