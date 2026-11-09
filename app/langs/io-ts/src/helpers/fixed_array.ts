/** An array of exactly `length` elements, like a Rust `[T; N]`. */
function fixedArray<A, O, N extends keyof FixedArrays<A>>(
	codec: t.Type<A, O>,
	length: N,
): t.Type<FixedArrays<A>[N], FixedArrays<O>[N]> {
	const elements = t.array(codec);
	const hasLength = (u: unknown): u is unknown[] => Array.isArray(u) && u.length === length;
	return new t.Type<FixedArrays<A>[N], FixedArrays<O>[N]>(
		`[${codec.name}; ${String(length)}]`,
		(u): u is FixedArrays<A>[N] => hasLength(u) && elements.is(u),
		(u, c) => (hasLength(u) ? (elements.validate(u, c) as t.Validation<FixedArrays<A>[N]>) : t.failure(u, c)),
		(a) => elements.encode(a as unknown as A[]) as FixedArrays<O>[N],
	);
}
