/** A string holding exactly one Unicode scalar value, like a Rust `char`. */
function character(): t.Type<string> {
	const is = (u: unknown): u is string => {
		const codePoint = typeof u === "string" ? u.codePointAt(0) : undefined;
		return (
			codePoint !== undefined &&
			(u as string).length === (codePoint > 0xffff ? 2 : 1) &&
			(codePoint < 0xd800 || codePoint > 0xdfff)
		);
	};
	return new t.Type<string>("char", is, (u, c) => (is(u) ? t.success(u) : t.failure(u, c)), t.identity);
}
