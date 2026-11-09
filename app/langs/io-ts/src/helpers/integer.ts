/** An integer between `min` and `max`, inclusive. */
function integer(name: string, min: number, max: number): t.Type<number> {
	const is = (u: unknown): u is number =>
		typeof u === "number" && Number.isInteger(u) && u >= min && u <= max;
	return new t.Type<number>(name, is, (u, c) => (is(u) ? t.success(u) : t.failure(u, c)), t.identity);
}
