/** A value, `undefined`, or `null`. serde writes `None` as `null`, so `null` decodes as `undefined`. */
function optional<A, O>(codec: t.Type<A, O>): t.Type<A | undefined, O | undefined> {
	return new t.Type<A | undefined, O | undefined>(
		codec.name,
		(u): u is A | undefined => u === undefined || codec.is(u),
		(u, c) => (u === undefined || u === null ? t.success(undefined) : codec.validate(u, c)),
		(a) => (a === undefined ? undefined : codec.encode(a)),
	);
}
