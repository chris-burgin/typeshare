/** A record key. Object keys are always strings, so an integer key like "16" is retried as a number. */
function recordKey<A, O>(codec: t.Type<A, O>): t.Type<A, O> {
	// The integer syntax serde_json writes and accepts for map keys
	const asInteger = (u: unknown): unknown => (typeof u === "string" && /^-?(0|[1-9][0-9]*)$/.test(u) ? Number(u) : u);
	return new t.Type<A, O>(
		codec.name,
		(u): u is A => codec.is(u) || codec.is(asInteger(u)),
		(u, c) => {
			const result = codec.validate(u, c);
			const integer = asInteger(u);
			return result._tag === "Left" && integer !== u ? codec.validate(integer, c) : result;
		},
		(a) => codec.encode(a),
	);
}
