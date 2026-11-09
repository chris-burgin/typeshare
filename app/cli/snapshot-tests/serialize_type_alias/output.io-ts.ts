import * as t from "io-ts";
import * as types from "./output";

export const UuidCodec: t.Type<types.Uuid> = /* @__PURE__ */ t.recursion<types.Uuid>("Uuid", () => t.string);

export const AccountUuidCodec: t.Type<types.AccountUuid> = /* @__PURE__ */ t.recursion<types.AccountUuid>("AccountUuid", () => UuidCodec);

export const AlsoStringCodec: t.Type<types.AlsoString> = /* @__PURE__ */ t.recursion<types.AlsoString>("AlsoString", () => t.string);

export const ItemUuidCodec: t.Type<types.ItemUuid> = /* @__PURE__ */ t.recursion<types.ItemUuid>("ItemUuid", () => t.string);

