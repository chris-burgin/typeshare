# io-ts Codecs

The `io-ts` language generates [io-ts](https://github.com/gcanti/io-ts) codecs for your types, so TypeScript code can check data at runtime before trusting it. It works alongside the `typescript` language rather than replacing it: you generate your types as usual, then generate a second file with one codec per type.

```
typeshare2 ./my_rust_project --lang=typescript --output-file=types.ts
typeshare2 ./my_rust_project --lang=io-ts --output-file=codecs.ts
```

Every codec is typed against the matching TypeScript type, so if a codec and its type ever disagree, `tsc` reports an error.

```typescript
import { isRight } from "fp-ts/Either";
import { ItemCodec } from "./codecs";

const result = ItemCodec.decode(JSON.parse(message));
if (isRight(result)) {
	// result.right is an Item
}
```

The generated file needs `io-ts` and `fp-ts` installed.

## Configuration

```toml
[io-ts]
# Where the codecs file imports the typescript output from. Defaults to "./types".
types-import = "./types"
# Appended to each type's name to name its codec. Defaults to "Codec".
codec-suffix = "Codec"

[io-ts.type_mappings]
# Codec expressions for mapped types. `t` is the io-ts import.
"DateTime" = "t.string"
```

Every type in `[typescript.type_mappings]` needs a codec in `[io-ts.type_mappings]` as well.

In multi-file mode, each crate's codecs are written to `typeshare_{crate}_codecs.ts` and import their types from `./typeshare_{crate}`, the file the `typescript` language writes for that crate.

## What gets generated

| Rust                        | Codec                                                        |
| --------------------------- | ------------------------------------------------------------ |
| `struct Item { .. }`        | `ItemCodec`, using a `fields` helper built on `t.type` and `t.partial` |
| `struct Page<T> { .. }`     | `PageCodec(TCodec)`, a function that takes a codec for `T`   |
| unit `enum`                 | Accepts only the enum's serialized values                    |
| `#[serde(tag, content)]` enum | A union that checks the tag and the content of each variant |
| `u8`, `i32`, `U53`, ...     | An integer within the Rust type's range                      |
| `f32`, `f64`                | `t.number`                                                   |
| `char`                      | A string holding exactly one character                       |
| `HashMap<K, V>`             | A record, with integer keys read from their string form      |
| `[T; N]`                    | An array of exactly `N` elements                             |
| `const`                     | Nothing, since constants don't need checking                 |

A few details follow how serde writes data rather than the TypeScript types alone:

- `Option<T>` fields accept `null` as well as a missing value, and leave the property out when it's `null`. serde writes `None` as `null`, while the TypeScript type is `field?: T`. The same goes for the content of unit variants.
- `Option<Option<T>>` fields keep `null`, since it means `Some(None)`.
- `()` accepts `null` and decodes it as `undefined`.

Codecs are lazy, so recursive types work, and bundlers can drop codecs you don't use.

## Limitations

Codecs are typed against the `typescript` output, so where that output doesn't match what serde writes, the codecs follow serde as far as the TypeScript type allows:

- An `Option` nested inside another type, such as `Vec<Option<T>>`, is typed as `T`, so those codecs reject `null` there.
- A unit struct (`struct Foo;`) is typed as `{}`, but serde writes it as `null`, so its codec rejects what serde writes.
- A map with enum keys, such as `HashMap<Kind, V>`, is typed as `Record<Kind, V>`, which says every key is present. serde maps can be missing keys, and the codec accepts that like serde does, so a decoded map can be missing keys its type promises.

Map entries whose key doesn't match the key type are left out instead of failing, which is how io-ts records work.

A field named `__proto__` isn't supported, since io-ts can't check it reliably. A `__proto__` key in the data is safe: objects leave it out, and maps keep it as an ordinary entry, instead of letting it become the prototype.

## Overriding a field

If a field has a TypeScript type override, it needs an io-ts one too, since a generated codec can't check a type it doesn't know. The value is a codec expression for the field's type. Whether the field can be missing or `null` still follows the Rust type.

```rust
#[typeshare(typescript(type = "any | undefined"), io_ts(type = "t.unknown"))]
field_to_override: String,
```
